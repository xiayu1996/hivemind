// PoC-2a against a real provider: same round-trip, but context carryover is
// proven by asking the model to recall a codeword it was only told before the
// reload, rather than by a scripted reply counter.
//
//   PI_PROVIDER=openai-codex PI_MODEL=gpt-5.4-mini node poc-2a-real-provider.mjs

import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { PiRpc } from "./rpc-client.mjs";

const PROVIDER = process.env.PI_PROVIDER ?? "openai-codex";
const MODEL = process.env.PI_MODEL ?? "gpt-5.4-mini";
const OUT = process.env.POC_OUT ?? mkdtempSync(join(tmpdir(), "hivemind-poc2a-real-"));
mkdirSync(OUT, { recursive: true });

const VOLATILE = new Set(["id", "parentId", "timestamp", "sessionId", "requestId", "durationMs", "usage", "cost", "api"]);
const canonical = (v) => Array.isArray(v) ? v.map(canonical)
  : (v && typeof v === "object")
    ? Object.fromEntries(Object.keys(v).sort().filter((k) => !VOLATILE.has(k)).map((k) => [k, canonical(v[k])]))
    : v;

const textOf = (m) => JSON.stringify(m?.content ?? "");
const log = (...a) => console.log(...a);

async function run() {
  const sessionDir = join(OUT, "sessions");
  mkdirSync(sessionDir, { recursive: true });
  const ARGS = ["--provider", PROVIDER, "--model", MODEL, "-nt", "--session-dir", sessionDir];

  const a = new PiRpc(ARGS, { cwd: OUT });
  await a.request({ type: "set_auto_retry", enabled: false });
  await a.request({ type: "prompt", message: "Remember this codeword and just acknowledge: PANGOLIN-7731. Reply with one short sentence." }, 120000);
  await a.waitFor(() => a.eventsOfType("agent_settled").length >= 1, "settle 1", 180000);

  const stateA = await a.request({ type: "get_state" });
  const msgsA = await a.request({ type: "get_messages" });
  const sessionFile = stateA.data.sessionFile;
  const usage = a.events.filter((e) => e.type === "message_end" && e.message?.usage).map((e) => e.message.usage).at(-1);
  await a.close();
  log(`model: ${stateA.data.model?.id ?? MODEL}`);
  log(`messages: ${msgsA.data.messages.length}`);
  log(`usage: ${JSON.stringify(usage)}`);

  // Reload in a fresh process from the session file.
  const copied = join(sessionDir, `imported-${basename(sessionFile)}`);
  copyFileSync(sessionFile, copied);
  const b = new PiRpc([...ARGS, "--session", copied], { cwd: OUT });
  const msgsB = await b.request({ type: "get_messages" });

  await b.request({ type: "prompt", message: "What was the codeword? Answer with the codeword only." }, 120000);
  await b.waitFor(() => b.eventsOfType("agent_settled").length >= 1, "settle B", 180000);
  const msgsB2 = await b.request({ type: "get_messages" });
  const answer = textOf(msgsB2.data.messages.at(-1));
  await b.close();

  const verdict = {
    poc: "PoC-2a against real provider",
    provider: PROVIDER,
    model: MODEL,
    messagesExported: msgsA.data.messages.length,
    messagesAfterLoad: msgsB.data.messages.length,
    roundTripEqual: JSON.stringify(canonical(msgsA.data.messages)) === JSON.stringify(canonical(msgsB.data.messages)),
    recalledCodeword: answer.includes("PANGOLIN-7731"),
    answerSnippet: answer.slice(0, 120),
    usage,
  };
  verdict.pass = verdict.roundTripEqual && verdict.recalledCodeword;
  writeFileSync(join(OUT, "verdict-2a-real.json"), JSON.stringify(verdict, null, 2));
  log(JSON.stringify(verdict, null, 2));
  process.exit(verdict.pass ? 0 : 1);
}

run().catch((e) => { console.error("FAILED:", e); process.exit(2); });
