import { spawn, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PiCompletionJudge, verifyCompletion } from "../src/pipeline/completion-verifier.js";
import { RpcPiRunner } from "../src/runner/rpc-runner.js";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const PI_BIN = process.env.PI_BIN ?? join(
  homedir(), ".hivemind", "pi", "0.84.3", "pi", process.platform === "win32" ? "pi.exe" : "pi",
);
const MOCK_PORT = process.env.HIVEMIND_MOCK_PORT ?? "8134";

function startMock(): ChildProcess {
  return spawn(process.execPath, [
    join(REPO, "poc", "rpc-context", "mock-provider-server.mjs"), "--port", MOCK_PORT,
  ], { stdio: ["ignore", "pipe", "pipe"] });
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
  try {
    await waitForMock();
    const judge = new PiCompletionJudge(() => new RpcPiRunner({
      binary: PI_BIN,
      provider: "mock",
      model: "mock-1",
      cwd: REPO,
      tools: [],
      contextFiles: "explicit",
      extensions: [join(REPO, "poc", "rpc-context", "mock-provider-extension.mjs")],
      env: { HIVEMIND_MOCK_PORT: MOCK_PORT },
    }));
    const decision = await verifyCompletion(judge, {
      phase: "CODE",
      claimedArtifact: "The phase produced its expected artifact.",
      sideEffects: { artifactStored: true, testsObserved: true },
    });
    console.log(JSON.stringify(decision));
    if (!decision.done) throw new Error(decision.reason);
    console.log("PASS: a fresh real pi session verified the phase exit");
  } finally {
    mock.kill("SIGKILL");
  }
}

main().catch((error: unknown) => {
  console.error("FAILED:", error);
  process.exit(1);
});
