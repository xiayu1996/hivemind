// PoC-2a: can a Context be exported from one pi process and loaded into another,
// so a phase can be rebuilt on a different machine or after a crash?
//
// Export face: get_messages over RPC.
// Import face: the session JSONL file (RPC has no import command).
// Pass criterion: messages after reload are semantically identical to the export,
// and the reloaded session keeps answering in the original conversation's sequence.

import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { PiRpc, MOCK_ARGS } from "./rpc-client.mjs";

const EXT = new URL("./mock-provider-extension.mjs", import.meta.url).pathname;
const OUT = process.env.POC_OUT ?? mkdtempSync(join(tmpdir(), "hivemind-poc2a-"));
mkdirSync(OUT, { recursive: true });

// Volatile identity/telemetry fields differ per run by design; the portable
// Context is what remains once they are stripped.
const VOLATILE = new Set(["id", "parentId", "timestamp", "sessionId", "requestId", "durationMs", "usage", "cost", "api"]);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).toSorted()) {
      if (VOLATILE.has(k)) continue;
      out[k] = canonical(value[k]);
    }
    return out;
  }
  return value;
}

const log = (...a) => console.log(...a);

async function run() {
  const sessionDir = join(OUT, "sessions");
  mkdirSync(sessionDir, { recursive: true });

  // --- Phase 1: original session, two turns ---
  const a = new PiRpc([...MOCK_ARGS(EXT), "--session-dir", sessionDir], { cwd: OUT });
  await a.request({ type: "prompt", message: "remember the codeword: PANGOLIN" });
  await a.waitFor(() => a.eventsOfType("agent_settled").length >= 1, "settle 1");
  await a.request({ type: "prompt", message: "what is the codeword?" });
  await a.waitFor(() => a.eventsOfType("agent_settled").length >= 2, "settle 2");

  const stateA = await a.request({ type: "get_state" });
  const msgsA = await a.request({ type: "get_messages" });
  const sessionFile = stateA.data.sessionFile;
  log(`session A file: ${sessionFile}`);
  log(`session A messages: ${msgsA.data.messages.length}`);
  await a.close();

  writeFileSync(join(OUT, "export-A.json"), JSON.stringify(msgsA.data.messages, null, 2));

  // --- Phase 2: import into a fresh process via the session file ---
  const copied = join(sessionDir, `imported-${basename(sessionFile)}`);
  copyFileSync(sessionFile, copied);

  const b = new PiRpc([...MOCK_ARGS(EXT), "--session-dir", sessionDir, "--session", copied], { cwd: OUT });
  const msgsB = await b.request({ type: "get_messages" });
  log(`session B messages after load: ${msgsB.data.messages.length}`);
  writeFileSync(join(OUT, "export-B.json"), JSON.stringify(msgsB.data.messages, null, 2));

  // Continue the conversation in the reloaded process: the scripted mock replies
  // in sequence, so a correct load yields ACK-3 (third assistant reply).
  await b.request({ type: "prompt", message: "confirm you still have the context" });
  await b.waitFor(() => b.eventsOfType("agent_settled").length >= 1, "settle B");
  const msgsB2 = await b.request({ type: "get_messages" });
  const lastB = msgsB2.data.messages.at(-1);
  await b.close();

  // --- Verdict ---
  const cA = JSON.stringify(canonical(msgsA.data.messages));
  const cB = JSON.stringify(canonical(msgsB.data.messages));
  const roundTripEqual = cA === cB;

  const lastText = JSON.stringify(lastB?.content ?? lastB ?? "");
  const continuedInSequence = lastText.includes("ACK-3");

  const verdict = {
    poc: "PoC-2a context round-trip",
    exportFace: "get_messages (RPC)",
    importFace: "session JSONL via --session (no RPC import command exists)",
    messagesExported: msgsA.data.messages.length,
    messagesAfterLoad: msgsB.data.messages.length,
    roundTripEqual,
    continuedInSequence,
    pass: roundTripEqual && continuedInSequence,
    outDir: OUT,
  };
  writeFileSync(join(OUT, "verdict-2a.json"), JSON.stringify(verdict, null, 2));
  log(JSON.stringify(verdict, null, 2));

  if (!roundTripEqual) {
    const linesA = cA.length, linesB = cB.length;
    log(`canonical length A=${linesA} B=${linesB}`);
  }
  process.exit(verdict.pass ? 0 : 1);
}

run().catch((e) => { console.error("FAILED:", e); process.exit(2); });
