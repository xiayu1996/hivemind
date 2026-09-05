// End-to-end check that the guard extension actually blocks inside a real pi
// process, and that both audit channels record the denial.
//
// The mock provider drives the tool call, so the run is deterministic and needs
// no vendor credentials: a real model may or may not choose to run `rm -rf`,
// which would make a passing run meaningless.
//
// Run: npx tsx scripts/smoke-guard.ts

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { JsonlDecoder } from "../src/runner/jsonl.js";
import { defaultPiBinary } from "../src/runner/pi-binary.js";
import {
  POLICY_ENV_VAR,
  assembleGuardPolicy,
  serializeGuardPolicy,
  type GuardPolicy,
} from "../src/guard/policy.js";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const PI_BIN = defaultPiBinary();
const MOCK_PORT = process.env.HIVEMIND_MOCK_PORT ?? "8131";

interface Probe {
  label: string;
  prompt: string;
  auditTarget: string;
  expectBlocked: boolean;
  expectReason?: string;
}

const HARMLESS: Probe = {
  label: "ordinary command",
  prompt: "USE_TOOL:echo hello-from-mock",
  auditTarget: "echo hello-from-mock",
  expectBlocked: false,
};

const PROBES: Probe[] = [
  { label: "rm -rf", prompt: "USE_TOOL:rm -rf /tmp/hivemind-guard-victim", auditTarget: "rm -rf /tmp/hivemind-guard-victim", expectBlocked: true, expectReason: "recursive rm is forbidden" },
  { label: "push main", prompt: "USE_TOOL:git push origin main", auditTarget: "git push origin main", expectBlocked: true, expectReason: "push to master/main is forbidden" },
  HARMLESS,
];

const VERIFY_PROBES: Probe[] = [
  { label: "write tool", prompt: "USE_WRITE:verify-write.txt", auditTarget: "write", expectBlocked: true, expectReason: "not available in the VERIFY phase" },
  { label: "redirection", prompt: "USE_TOOL:printf x > verify-redirect.txt", auditTarget: "printf x > verify-redirect.txt", expectBlocked: true, expectReason: "shell write is forbidden in VERIFY" },
  { label: "sed -i", prompt: "USE_TOOL:sed -i 's/a/b/' src/a.ts", auditTarget: "sed -i 's/a/b/' src/a.ts", expectBlocked: true, expectReason: "shell write is forbidden in VERIFY" },
  { label: "tee", prompt: "USE_TOOL:printf x | tee verify-tee.txt", auditTarget: "printf x | tee verify-tee.txt", expectBlocked: true, expectReason: "shell write is forbidden in VERIFY" },
  { label: "git commit", prompt: "USE_TOOL:git commit -am verify", auditTarget: "git commit -am verify", expectBlocked: true, expectReason: "shell write is forbidden in VERIFY" },
];

function startMock(): ChildProcess {
  const child = spawn(
    process.execPath,
    [join(REPO, "poc/rpc-context/mock-provider-server.mjs"), "--port", MOCK_PORT],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(`[mock] ${chunk}`));
  return child;
}

async function waitForMock(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${MOCK_PORT}/v1/models`);
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("mock provider never became reachable");
}

/** Runs one prompt through pi with the guard loaded and returns the raw event stream. */
async function runProbe(probe: Probe, policy: GuardPolicy, withPolicy = true): Promise<unknown[]> {
  const child = spawn(
    PI_BIN,
    [
      "--mode", "rpc",
      "-e", join(REPO, "poc/rpc-context/mock-provider-extension.mjs"),
      "-e", join(REPO, "extensions/hive-guard.ts"),
      "--provider", "mock",
      "--model", "mock-1",
      "--no-context-files",
      "--tools", "bash,write",
    ],
    {
      cwd: policy.worktreePath,
      env: withPolicy
        ? { ...process.env, HIVEMIND_MOCK_PORT: MOCK_PORT, [POLICY_ENV_VAR]: serializeGuardPolicy(policy) }
        : { ...process.env, HIVEMIND_MOCK_PORT: MOCK_PORT, [POLICY_ENV_VAR]: undefined },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  const events: unknown[] = [];
  const decoder = new JsonlDecoder();
  const settled = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`pi never settled for probe ${probe.label}`)), 45_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      for (const line of decoder.push(chunk)) {
        const event = JSON.parse(line) as { type?: string };
        events.push(event);
        if (event.type === "agent_settled" || event.type === "agent_end") {
          clearTimeout(timer);
          resolve();
        }
      }
    });
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => process.stderr.write(`[pi] ${chunk}`));

  child.stdin.write(`${JSON.stringify({ type: "prompt", message: probe.prompt, id: "p1" })}\n`);

  try {
    await settled;
  } finally {
    child.stdin.end();
    child.kill("SIGKILL");
  }
  return events;
}

function readAudit(auditPath: string): Array<Record<string, unknown>> {
  if (!existsSync(auditPath)) return [];
  return readFileSync(auditPath, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function main(): Promise<void> {
  const workDir = mkdtempSync(join(tmpdir(), "hivemind-guard-"));
  const auditPath = join(workDir, "audit", "tool-audit.jsonl");
  const policy = assembleGuardPolicy({
    phase: "CODE",
    cardId: "S-smoke",
    runId: "run-smoke",
    worktreePath: workDir,
    auditPath,
  });
  const verifyPolicy = assembleGuardPolicy({
    phase: "VERIFY",
    cardId: "S-smoke",
    runId: "run-smoke-verify",
    worktreePath: workDir,
    evidencePath: join(workDir, "evidence"),
    auditPath,
  });

  const mock = startMock();
  const failures: string[] = [];
  try {
    await waitForMock();

    for (const probe of PROBES) {
      const events = await runProbe(probe, policy);
      const stream = JSON.stringify(events);
      const blockedInStream = stream.includes("hive-guard:");

      if (blockedInStream !== probe.expectBlocked) {
        failures.push(`${probe.label}: event stream blocked=${blockedInStream}, expected ${probe.expectBlocked}`);
      }
      if (probe.expectReason && !stream.includes(probe.expectReason)) {
        failures.push(`${probe.label}: event stream is missing the reason "${probe.expectReason}"`);
      }

      const audit = readAudit(auditPath).filter((record) => record.target === probe.auditTarget);
      if (audit.length === 0) {
        failures.push(`${probe.label}: no audit record for the command`);
      } else {
        const decision = audit.at(-1)?.decision;
        const expected = probe.expectBlocked ? "deny" : "allow";
        if (decision !== expected) {
          failures.push(`${probe.label}: audit decision=${String(decision)}, expected ${expected}`);
        }
      }
      console.log(`${probe.label}: stream_blocked=${blockedInStream} audit_records=${audit.length}`);
    }

    for (const probe of VERIFY_PROBES) {
      const events = await runProbe(probe, verifyPolicy);
      const stream = JSON.stringify(events);
      const audit = readAudit(auditPath).filter((record) => record.target === probe.auditTarget);
      if (!stream.includes("hive-guard:")) failures.push(`${probe.label}: VERIFY call was not blocked`);
      if (probe.expectReason && !stream.includes(probe.expectReason)) {
        failures.push(`${probe.label}: event stream is missing the reason "${probe.expectReason}"`);
      }
      if (audit.at(-1)?.decision !== "deny") failures.push(`${probe.label}: audit denial is missing`);
      console.log(`VERIFY ${probe.label}: blocked=${stream.includes("hive-guard:")} audit_records=${audit.length}`);
    }

    // A guard that cannot read its policy must deny rather than fall back to
    // permitting work: an unguarded phase is indistinguishable from a guarded
    // one until something is already broken.
    const unguarded = await runProbe(HARMLESS, policy, false);
    const unguardedStream = JSON.stringify(unguarded);
    if (!unguardedStream.includes("hive-guard:")) {
      failures.push("no-policy run: a harmless command was allowed; the guard failed open");
    }
    if (!unguardedStream.includes("is not set")) {
      failures.push("no-policy run: the denial did not say the policy was missing");
    }
    console.log(`no policy: blocked=${unguardedStream.includes("hive-guard:")}`);
  } finally {
    mock.kill("SIGKILL");
  }

  const audit = readAudit(auditPath);
  console.log(`\naudit file: ${auditPath} (${audit.length} records)`);
  for (const record of audit) {
    console.log(`  ${String(record.decision)} ${String(record.toolName)} ${String(record.target)} ${String(record.reason ?? "")}`);
  }

  if (failures.length > 0) {
    console.error(`\nFAILED:\n${failures.map((line) => `  - ${line}`).join("\n")}`);
    process.exit(1);
  }
  console.log("\nPASS: red lines blocked in-process, both channels recorded the decision");
}

main().catch((error: unknown) => {
  console.error("FAILED:", error);
  process.exit(2);
});
