// Windows PoC: run ten fresh real pi RPC processes, each including a Git Bash
// tool call. The provider is deterministic and local so this measures the
// process/RPC/shell boundary without spending credentials or vendor capacity.
//
// Run from Git Bash:
//   PI_BIN='C:/Users/me/.hivemind/pi/0.84.3/pi/pi.exe' npx tsx scripts/smoke-windows-rpc.ts

import { spawn, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcPiRunner } from "../src/runner/rpc-runner.js";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const PI_BIN = process.env.PI_BIN ?? join(homedir(), ".hivemind", "pi", "0.84.3", "pi", "pi.exe");
const MOCK_PORT = process.env.HIVEMIND_MOCK_PORT ?? "8132";
const ITERATIONS = 10;

function startMock(): ChildProcess {
  const child = spawn(
    process.execPath,
    [join(REPO, "poc", "rpc-context", "mock-provider-server.mjs"), "--port", MOCK_PORT],
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
      // The child has not bound its port yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("mock provider never became reachable");
}

async function runIteration(iteration: number): Promise<void> {
  const marker = `hivemind-windows-${iteration}`;
  const runner = new RpcPiRunner({
    binary: PI_BIN,
    provider: "mock",
    model: "mock-1",
    cwd: REPO,
    tools: ["bash"],
    extensions: [join(REPO, "poc", "rpc-context", "mock-provider-extension.mjs")],
    contextFiles: "explicit",
    env: { HIVEMIND_MOCK_PORT: MOCK_PORT },
  });

  try {
    await runner.start();
    await runner.setAutoRetry(false);
    const result = await runner.prompt(`USE_TOOL:printf '${marker}\\n'; uname -s`, 45_000);
    const stream = JSON.stringify(result.events);
    const unparseable = result.events.filter((event) => event.type === "__unparseable__").length;
    if (result.failure) throw new Error(`provider failure: ${result.failure.errorMessage}`);
    if (!stream.includes(marker)) throw new Error("bash output marker is missing from the RPC stream");
    if (!stream.includes("MINGW")) throw new Error("bash tool did not run under Git for Windows");
    if (unparseable !== 0) throw new Error(`RPC stream contained ${unparseable} unparseable record(s)`);
    if (process.env.HIVEMIND_DEBUG_EVENTS === "1" && iteration === 1) {
      console.log(JSON.stringify(result.events.filter((event) => event.type.includes("tool")), null, 2));
    }
    console.log(`${iteration}/${ITERATIONS} PASS handshake tool=MINGW framing=clean events=${result.events.length}`);
  } finally {
    await runner.stop();
  }
}

async function main(): Promise<void> {
  if (process.platform !== "win32") throw new Error(`Windows is required, got ${process.platform}`);
  const mock = startMock();
  try {
    await waitForMock();
    for (let iteration = 1; iteration <= ITERATIONS; iteration++) {
      await runIteration(iteration);
    }
  } finally {
    mock.kill("SIGKILL");
  }
  console.log(`PASS: ${ITERATIONS}/${ITERATIONS} Windows pi RPC runs completed with Git Bash tool calls`);
}

main().catch((error: unknown) => {
  console.error("FAILED:", error);
  process.exit(1);
});
