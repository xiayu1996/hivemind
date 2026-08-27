// PoC-5: what does pi actually emit over RPC for each provider failure class?
//
// Auto-retry is disabled first so the raw error surfaces instead of being masked
// by pi's own retry loop (the design mandates retry.provider.maxRetries: 0 for
// the same reason: hivemind owns retry policy).
//
// Output: fixtures/rpc-errors/<fault>.json plus a classification check that every
// sample maps to exactly one bucket.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PiRpc } from "./rpc-client.mjs";

const EXT = new URL("./mock-provider-extension.mjs", import.meta.url).pathname;
const FIXTURES = process.env.FIXTURE_DIR
  ?? new URL("../../fixtures/rpc-errors/", import.meta.url).pathname;
const OUT = process.env.POC_OUT ?? "/tmp/hivemind-poc5";
mkdirSync(FIXTURES, { recursive: true });
mkdirSync(OUT, { recursive: true });

const FAULTS = ["auth", "rate_limit", "quota", "server", "invalid_request", "transport", "mid_stream_drop"];

// Classification rules under test, in priority order: the first match wins.
// Order matters because provider payloads overlap — an insufficient_quota body
// also carries HTTP 429, and an auth failure is reported as invalid_request_error.
// Buckets follow 04-observability §9.2.
const RULES = [
  { bucket: "QUOTA", test: (s) => /insufficient_quota|exceeded your current quota|usage limit/i.test(s) },
  { bucket: "AUTH", test: (s) => /^401\b|\b401:|invalid_api_key|unauthorized|authentication/i.test(s) },
  { bucket: "RATE_LIMIT", test: (s) => /rate_limit_exceeded|rate limit reached|^429\b|\b429:/i.test(s) },
  { bucket: "INVALID_REQUEST", test: (s) => /^400\b|\b400:|invalid_value/i.test(s) },
  { bucket: "SERVER", test: (s) => /^5\d\d\b|\b5\d\d:|server_error|overloaded/i.test(s) },
  { bucket: "TRANSPORT", test: (s) => /connection error|terminated|socket hang up|ECONNRESET|fetch failed|network|premature close/i.test(s) },
];

function classify(sample) {
  const all = RULES.filter((r) => r.test(sample)).map((r) => r.bucket);
  return { bucket: all[0] ?? null, allMatches: all };
}

async function captureFault(fault) {
  const p = new PiRpc(["-e", EXT, "--provider", "mock", "--model", "mock-1", "-nt", "--no-session"], {
    cwd: OUT,
    env: { HIVEMIND_MOCK_PORT: process.env.HIVEMIND_MOCK_PORT ?? "8099" },
  });

  await p.request({ type: "set_auto_retry", enabled: false });

  const timeoutMs = fault === "timeout" ? 8000 : 30000;
  await p.request({ type: "prompt", message: `trigger ${fault}` }, timeoutMs).catch(() => {});

  // Settle, or give up and take whatever surfaced.
  await p.waitFor(
    () => p.eventsOfType("agent_settled").length >= 1 || p.eventsOfType("agent_end").length >= 1,
    `settle ${fault}`,
    timeoutMs,
    true,
  ).catch(() => {});

  const messages = await p.request({ type: "get_messages" }, 10000).catch(() => null);
  await p.close();

  return {
    fault,
    events: p.events,
    responses: p.responses,
    stderr: p.stderr.slice(0, 4000),
    exited: p.exited,
    messages: messages?.data?.messages ?? null,
  };
}

// pi reports every provider failure the same way: the assistant message carries
// stopReason "error" and a human-readable errorMessage. The same message is
// repeated on message_start / message_end / turn_end / agent_end, so one
// extraction rule covers all of them.
function errorSurface(capture) {
  const messages = [];
  const seen = new Set();
  const collect = (m) => {
    if (m?.stopReason === "error" && typeof m.errorMessage === "string" && !seen.has(m.errorMessage)) {
      seen.add(m.errorMessage);
      messages.push(m.errorMessage);
    }
  };
  for (const e of capture.events) {
    collect(e.message);
    if (Array.isArray(e.messages)) e.messages.forEach(collect);
    if (e.type === "auto_retry_start" && e.errorMessage) messages.push(e.errorMessage);
    if (e.type === "auto_retry_end" && e.finalError) messages.push(e.finalError);
  }
  const willRetry = capture.events.find((e) => e.type === "agent_end")?.willRetry ?? null;
  return { text: messages.join("\n"), errorMessages: messages, willRetry };
}

async function run() {
  const summary = [];
  for (const fault of FAULTS) {
    process.env.MOCK_FAULT_HEADER = fault;
    // The mock reads the fault from a file so it applies to pi's own requests.
    writeFileSync(process.env.MOCK_FAULT_FILE, fault);
    const capture = await captureFault(fault);
    writeFileSync(join(FIXTURES, `${fault}.json`), JSON.stringify(capture, null, 2));

    const surface = errorSurface(capture);
    const { bucket, allMatches } = classify(surface.text);
    summary.push({
      fault,
      errorMessage: surface.errorMessages[0] ?? null,
      surfacedViaStopReasonError: surface.errorMessages.length > 0,
      willRetry: surface.willRetry,
      bucket,
      allMatches,
      classified: bucket !== null,
    });
    console.log(`${fault}: bucket=${bucket} willRetry=${surface.willRetry} msg=${(surface.errorMessages[0] ?? "").slice(0, 70)}`);
  }
  writeFileSync(process.env.MOCK_FAULT_FILE, "");

  const expected = {
    auth: "AUTH", rate_limit: "RATE_LIMIT", quota: "QUOTA", server: "SERVER",
    invalid_request: "INVALID_REQUEST", transport: "TRANSPORT", mid_stream_drop: "TRANSPORT",
  };
  const misclassified = summary.filter((s) => s.bucket !== expected[s.fault]);
  const verdict = {
    poc: "PoC-5 RPC error catalog",
    autoRetryDisabled: true,
    extractionContract: "assistant message stopReason === 'error' → errorMessage (repeated on message_start/message_end/turn_end/agent_end); agent_end.willRetry signals pi's own retry intent",
    samples: summary,
    allSurfaced: summary.every((s) => s.surfacedViaStopReasonError),
    allClassifiedAsExpected: misclassified.length === 0,
    misclassified: misclassified.map((s) => ({ fault: s.fault, got: s.bucket, want: expected[s.fault] })),
    fixturesDir: FIXTURES,
  };
  writeFileSync(join(OUT, "verdict-5.json"), JSON.stringify(verdict, null, 2));
  console.log(JSON.stringify(verdict, null, 2));
  process.exit(verdict.allSurfaced && verdict.allClassifiedAsExpected ? 0 : 1);
}

run().catch((e) => { console.error("FAILED:", e); process.exit(2); });
