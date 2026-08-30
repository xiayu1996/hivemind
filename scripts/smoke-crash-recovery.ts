// M1-06 acceptance: SIGKILL a running pi, then resume from the last checkpoint in
// a fresh process and confirm the conversation survived the crash.
//
// Runs against the mock provider: this is a durability question, not a model one.
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckpointStore } from "../src/runner/checkpoint.js";
import { RpcPiRunner } from "../src/runner/rpc-runner.js";
import { resolveModel, staticCatalog } from "../src/runner/model-resolver.js";

const MODEL = await resolveModel(staticCatalog([{ provider: "mock", id: "mock-1" }]), "mock", "mock-1");

const PI = `${process.env.HOME}/.hivemind/pi/0.84.3/pi/pi`;
const EXT = join(process.cwd(), "poc/rpc-context/mock-provider-extension.mjs");
const MOCK_PORT = process.env.HIVEMIND_MOCK_PORT ?? "19102";

// The extension only registers a provider pointing at this port; without the
// server behind it every completion fails and the resumed session answers
// nothing, which reads as a recovery failure that never happened.
const mock = spawn(process.execPath, [join(process.cwd(), "poc/rpc-context/mock-provider-server.mjs"), "--port", MOCK_PORT], {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, HIVEMIND_MOCK_PORT: MOCK_PORT },
});
for (let attempt = 0; ; attempt++) {
  try {
    if ((await fetch(`http://127.0.0.1:${MOCK_PORT}/v1/models`)).ok) break;
  } catch {
    // The mock has not bound its port yet.
  }
  if (attempt >= 50) throw new Error("mock provider never became reachable");
  await new Promise((resolve) => setTimeout(resolve, 100));
}
const work = await mkdtemp(join(tmpdir(), "hm-crash-"));
const store = new CheckpointStore({ dir: join(work, "checkpoints") });

const base = {
  binary: PI,
  provider: "mock",
  model: MODEL,
  cwd: work,
  tools: [] as string[],
  sessionDir: join(work, "sessions"),
  extensions: [EXT],
  env: { HIVEMIND_MOCK_PORT: MOCK_PORT },
};

const first = new RpcPiRunner(base);
await first.start();
await first.prompt("remember the codeword: PANGOLIN", 60_000);

const sessionFile = String((await first.getState()).sessionFile);
const checkpoint = await store.capture("run-crash", 1, sessionFile);
const before = await first.getMessages();
console.log(`checkpoint seq=${checkpoint.seq} bytes=${checkpoint.bytes} truncated=${checkpoint.truncatedLines}`);

await first.kill();
console.log("killed mid-run, alive =", first.alive);

const recovered = await store.latestIntact("run-crash");
if (!recovered) throw new Error("no intact checkpoint to resume from");

const second = new RpcPiRunner({ ...base, sessionFile: recovered.file });
await second.start();
const after = await second.getMessages();
const result = await second.prompt("confirm you still have the context", 60_000);
await second.stop();

const carried = JSON.stringify(after).includes("PANGOLIN");
const continued = JSON.stringify(result.events).includes("ACK-");

console.log(`messages before crash: ${before.length}, after resume: ${after.length}`);
console.log(`history carried: ${carried}`);
console.log(`resumed session kept answering: ${continued}`);
console.log(before.length === after.length && carried && continued
  ? "PASS: crash recovery works"
  : "FAIL");
mock.kill();
process.exit(before.length === after.length && carried && continued ? 0 : 1);
