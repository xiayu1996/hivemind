// PoC-2b: mid-run steering, abort, and resume-after-abort.
//
// The mock answers the first USE_TOOL prompt with a bash tool call that sleeps,
// which opens the only window where a steering message can be delivered
// (after the current turn's tool calls, before the next LLM call).

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiRpc } from "./rpc-client.mjs";

const EXT = new URL("./mock-provider-extension.mjs", import.meta.url).pathname;
const OUT = process.env.POC_OUT ?? mkdtempSync(join(tmpdir(), "hivemind-poc2b-"));
mkdirSync(OUT, { recursive: true });

const ARGS = ["-e", EXT, "--provider", "mock", "--model", "mock-1", "-t", "bash", "--session-dir", join(OUT, "sessions")];
const log = (...a) => console.log(...a);
const result = {};

async function testSteer() {
  const p = new PiRpc(ARGS, { cwd: OUT });
  await p.request({ type: "prompt", message: "USE_TOOL please run the probe" });
  await p.waitFor(() => p.eventsOfType("tool_execution_start").length >= 1, "tool start", 20000);

  const steer = await p.request({ type: "steer", message: "STEERED-MESSAGE-XYZ" });
  await p.waitFor(() => p.eventsOfType("agent_settled").length >= 1, "settle", 40000);

  const msgs = await p.request({ type: "get_messages" });
  const flat = JSON.stringify(msgs.data.messages);
  await p.close();

  result.steer = {
    accepted: steer.success === true,
    deliveredIntoConversation: flat.includes("STEERED-MESSAGE-XYZ"),
    toolExecuted: p.eventsOfType("tool_execution_end").length >= 1,
    queueUpdateEvents: p.eventsOfType("queue_update").length,
  };
  result.steer.pass = result.steer.accepted && result.steer.deliveredIntoConversation && result.steer.toolExecuted;
  log("steer:", JSON.stringify(result.steer));
}

async function testAbortAndResume() {
  const sessionDir = join(OUT, "sessions-abort");
  mkdirSync(sessionDir, { recursive: true });
  const p = new PiRpc(["-e", EXT, "--provider", "mock", "--model", "mock-1", "-t", "bash", "--session-dir", sessionDir], { cwd: OUT });

  await p.request({ type: "prompt", message: "USE_TOOL long running probe" });
  await p.waitFor(() => p.eventsOfType("tool_execution_start").length >= 1, "tool start", 20000);

  const abort = await p.request({ type: "abort" });
  await p.waitFor(() => p.eventsOfType("agent_settled").length >= 1 || p.eventsOfType("agent_end").length >= 1, "abort settle", 20000);

  const state = await p.request({ type: "get_state" });
  const sessionFile = state.data.sessionFile;
  const aliveAfterAbort = p.exited === null;

  // Same process keeps the session: a new prompt must be accepted right after abort.
  const after = await p.request({ type: "prompt", message: "continue after abort" });
  await p.waitFor(() => p.eventsOfType("agent_settled").length >= 2, "post-abort settle", 30000);
  const msgs = await p.request({ type: "get_messages" });
  await p.close();

  // Cross-process resume from the same session file (crash-recovery path).
  const q = new PiRpc(["-e", EXT, "--provider", "mock", "--model", "mock-1", "-t", "bash",
    "--session-dir", sessionDir, "--session", sessionFile], { cwd: OUT });
  const resumed = await q.request({ type: "get_messages" });
  await q.close();

  result.abort = {
    accepted: abort.success === true,
    processAliveAfterAbort: aliveAfterAbort,
    acceptedNewPromptAfterAbort: after.success === true,
    messagesInProcess: msgs.data.messages.length,
    messagesAfterCrossProcessResume: resumed.data.messages.length,
    resumeCarriedHistory: resumed.data.messages.length > 0,
  };
  result.abort.pass = result.abort.accepted && result.abort.processAliveAfterAbort
    && result.abort.acceptedNewPromptAfterAbort && result.abort.resumeCarriedHistory;
  log("abort/resume:", JSON.stringify(result.abort));
}

async function run() {
  await testSteer();
  await testAbortAndResume();
  const verdict = {
    poc: "PoC-2b mid-run injection / abort / resume",
    ...result,
    pass: result.steer.pass && result.abort.pass,
    outDir: OUT,
  };
  writeFileSync(join(OUT, "verdict-2b.json"), JSON.stringify(verdict, null, 2));
  log(JSON.stringify(verdict, null, 2));
  process.exit(verdict.pass ? 0 : 1);
}

run().catch((e) => { console.error("FAILED:", e); process.exit(2); });
