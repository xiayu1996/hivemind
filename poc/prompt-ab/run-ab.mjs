// PoC-4: three-arm prompt comparison on one real coding task.
//
//   arm "default"  - pi's built-in system prompt only
//   arm "append"   - built-in + hivemind baseline layer (--append-system-prompt)
//   arm "replace"  - hivemind baseline layer only (--system-prompt)
//
// Each arm gets a pristine copy of the fixture repo. Arm identity goes into a key
// file the scoring sheet does not contain, so scoring can be done blind.

import { mkdirSync, writeFileSync, cpSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { PiRpc } from "../rpc-context/rpc-client.mjs";

const FIXTURE = process.env.AB_FIXTURE;
const OUT = process.env.AB_OUT;
const MODEL = process.env.AB_MODEL ?? "gpt-5.6-terra";
const BASELINE = new URL("../../prompts/baseline.md", import.meta.url).pathname;

const TASK = `test/cart.test.js 里有一个失败的用例，请修复 src/cart.js 让它通过。
另外产品那边说还要支持优惠券叠加，请一并把 applyCoupon 实现掉。`;

const ARMS = [
  { id: "default", extra: [] },
  { id: "append", extra: ["--append-system-prompt", BASELINE] },
  { id: "replace", extra: ["--system-prompt", readFileSync(BASELINE, "utf8")] },
];

// Fixed permutation so directory order does not reveal which arm is which.
const LABELS = ["arm-2", "arm-3", "arm-1"];

const sh = (cwd, cmd, args) => {
  try { return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { return (e.stdout ?? "") + (e.stderr ?? ""); }
};

async function runArm(arm, label) {
  const dir = join(OUT, label);
  rmSync(dir, { recursive: true, force: true });
  cpSync(FIXTURE, dir, { recursive: true });

  const p = new PiRpc([
    "--provider", "openai-codex", "--model", MODEL, "--thinking", "medium",
    "--session-dir", join(dir, ".sessions"), ...arm.extra,
  ], { cwd: dir });

  await p.request({ type: "set_auto_retry", enabled: false });
  const t0 = Date.now();
  await p.request({ type: "prompt", message: TASK }, 120000);
  await p.waitFor(() => p.eventsOfType("agent_settled").length >= 1, `settle ${label}`, 900000);
  const elapsedMs = Date.now() - t0;

  const msgs = await p.request({ type: "get_messages" });
  const last = await p.request({ type: "get_last_assistant_text" }).catch(() => null);
  await p.close();

  const toolBlobs = p.eventsOfType("tool_execution_end").map((e) => JSON.stringify(e));
  const ranTests = toolBlobs.some((s) => /npm\\s+test|node\\s+--test/.test(s));
  const diff = sh(dir, "git", ["diff"]);
  const touchedTests = sh(dir, "git", ["diff", "--name-only"]).includes("test/");
  const testResult = sh(dir, "npm", ["test"]);
  const green = /fail 0/.test(testResult);

  const usage = p.events
    .filter((e) => e.type === "message_end" && e.message?.usage)
    .reduce((acc, e) => {
      const u = e.message.usage;
      acc.input += u.input ?? 0; acc.output += u.output ?? 0; acc.cost += u.cost?.total ?? 0;
      return acc;
    }, { input: 0, output: 0, cost: 0 });

  const finalText = last?.data?.text ?? JSON.stringify(msgs.data.messages.at(-1)?.content ?? "");

  writeFileSync(join(OUT, `${label}-final.md`), finalText);
  writeFileSync(join(OUT, `${label}-diff.patch`), diff);
  writeFileSync(join(OUT, `${label}-facts.json`), JSON.stringify({
    label, elapsedMs, ranTests, touchedTests, testsGreenAfter: green,
    toolCallCount: toolBlobs.length, usage, finalTextChars: finalText.length,
  }, null, 2));

  console.log(`${label}: ranTests=${ranTests} green=${green} touchedTests=${touchedTests} tools=${toolBlobs.length} cost=$${usage.cost.toFixed(4)} ${Math.round(elapsedMs / 1000)}s`);
  return { label, arm: arm.id, elapsedMs, ranTests, touchedTests, green, usage };
}

const results = [];
for (let i = 0; i < ARMS.length; i++) results.push(await runArm(ARMS[i], LABELS[i]));
writeFileSync(join(OUT, "KEY-do-not-read-before-scoring.json"), JSON.stringify(results, null, 2));
console.log("\nkey written; score arm-1/2/3 blind from *-final.md and *-diff.patch");
