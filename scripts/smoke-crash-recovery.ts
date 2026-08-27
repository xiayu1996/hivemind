// M1-06 acceptance: SIGKILL a running pi, then resume from the last checkpoint in
// a fresh process and confirm the conversation survived the crash.
//
// Runs against the mock provider: this is a durability question, not a model one.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckpointStore } from "../src/runner/checkpoint.js";
import { RpcPiRunner } from "../src/runner/rpc-runner.js";

const PI = `${process.env.HOME}/.hivemind/pi/0.84.3/pi/pi`;
const EXT = join(process.cwd(), "poc/rpc-context/mock-provider-extension.mjs");
const work = await mkdtemp(join(tmpdir(), "hm-crash-"));
const store = new CheckpointStore({ dir: join(work, "checkpoints") });

const base = {
  binary: PI,
  provider: "mock",
  model: "mock-1",
  cwd: work,
  tools: [] as string[],
  sessionDir: join(work, "sessions"),
  extensions: [EXT],
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
process.exit(before.length === after.length && carried && continued ? 0 : 1);
