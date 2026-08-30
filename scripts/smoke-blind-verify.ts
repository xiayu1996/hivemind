import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { POLICY_ENV_VAR, serializeGuardPolicy, type GuardPolicy } from "../src/guard/policy.js";
import { RpcPiRunner } from "../src/runner/rpc-runner.js";
import { BlindVerifyExecutor, type VerifyRecord } from "../src/verify/executor.js";
import { resolveModel, staticCatalog } from "../src/runner/model-resolver.js";

const MODEL = await resolveModel(staticCatalog([{ provider: "mock", id: "mock-1" }]), "mock", "mock-1");

const REPO = fileURLToPath(new URL("..", import.meta.url));
const PI_BIN = process.env.PI_BIN ?? join(
  homedir(), ".hivemind", "pi", "0.84.3", "pi", process.platform === "win32" ? "pi.exe" : "pi",
);
const MOCK_PORT = process.env.HIVEMIND_MOCK_PORT ?? "19100";

function startMock(): ChildProcess {
  return spawn(process.execPath, [join(REPO, "poc", "rpc-context", "mock-provider-server.mjs"), "--port", MOCK_PORT], {
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitForMock(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      if ((await fetch(`http://127.0.0.1:${MOCK_PORT}/v1/models`)).ok) return;
    } catch {
      // The mock has not bound its port yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("mock provider never became reachable");
}

async function main(): Promise<void> {
  const mock = startMock();
  const evidence = await mkdtemp(join(tmpdir(), "hm-blind-verify-"));
  await mkdir(join(evidence, "sessions"), { recursive: true });
  const records: VerifyRecord[] = [];
  try {
    await waitForMock();
    const executor = new BlindVerifyExecutor(
      {
        create: (policy: GuardPolicy) => new RpcPiRunner({
          binary: PI_BIN,
          provider: "mock",
          model: MODEL,
          cwd: REPO,
          sessionDir: join(evidence, "sessions"),
          tools: ["bash"],
          contextFiles: "explicit",
          extensions: [
            join(REPO, "poc", "rpc-context", "mock-provider-extension.mjs"),
            join(REPO, "extensions", "hive-guard.ts"),
          ],
          env: {
            HIVEMIND_MOCK_PORT: MOCK_PORT,
            [POLICY_ENV_VAR]: serializeGuardPolicy(policy),
          },
        }),
      },
      { insert: async (record) => { records.push(record); } },
    );
    const result = await executor.run({
      cardId: "blind-smoke",
      round: 1,
      codeSessionId: "code-session-must-not-be-reused",
      worktreePath: REPO,
      evidencePath: evidence,
      auditPath: join(evidence, "tool-audit.jsonl"),
      specification: "The local deterministic verification probe completes.",
      declaredScenarioIds: ["S-MOCK-01-unit"],
      allowedHosts: ["localhost"],
      commitMessages: ["test(S-MOCK-01-unit): red", "feat(S-MOCK-01-unit): green"],
    });
    if (result.record.verdict !== "accepted") throw new Error(JSON.stringify(result.validationErrors));
    if (result.record.verifySessionId === result.record.codeSessionId) throw new Error("session separation failed");
    if (!JSON.stringify(result.events).includes("HIVEMIND_TEST_RESULT S-MOCK-01-unit passed")) {
      throw new Error("observed test result is missing from the real pi trajectory");
    }
    console.log(`PASS: blind VERIFY used fresh session ${result.record.verifySessionId}`);
    console.log("PASS: read-only real pi trajectory contains observed scenario evidence and no CODE transcript");
  } finally {
    mock.kill("SIGKILL");
  }
}

main().catch((error: unknown) => {
  console.error("FAILED:", error);
  process.exit(1);
});
