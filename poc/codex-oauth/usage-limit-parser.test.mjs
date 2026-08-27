// Cases are generated from pi's own template so the fixtures cannot drift from
// the string pi actually produces.
import { parseUsageLimit, isUsageLimit } from "./usage-limit-parser.mjs";
import assert from "node:assert/strict";

const build = (planType, resetsAtSec, nowMs) => {
  const plan = planType ? ` (${planType.toLowerCase()} plan)` : "";
  const mins = resetsAtSec ? Math.max(0, Math.round((resetsAtSec * 1000 - nowMs) / 60000)) : undefined;
  const when = mins !== undefined ? ` Try again in ~${mins} min.` : "";
  return `You have hit your ChatGPT usage limit${plan}.${when}`.trim();
};

const NOW = 1_700_000_000_000;
let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (e) { failures++; console.log(`  FAIL ${name}: ${e.message}`); }
};

check("plus plan with reset window", () => {
  const msg = build("Plus", (NOW + 47 * 60_000) / 1000, NOW);
  assert.equal(msg, "You have hit your ChatGPT usage limit (plus plan). Try again in ~47 min.");
  const r = parseUsageLimit(msg, NOW);
  assert.equal(r.plan, "plus");
  assert.equal(r.resetMinutes, 47);
  assert.equal(r.resetAtMs, NOW + 47 * 60_000);
  assert.equal(r.action, "failover");
});

check("short window defers instead of switching provider", () => {
  const msg = build("Pro", (NOW + 9 * 60_000) / 1000, NOW);
  const r = parseUsageLimit(msg, NOW);
  assert.equal(r.resetMinutes, 9);
  assert.equal(r.action, "defer");
});

check("boundary at 15 minutes defers", () => {
  const r = parseUsageLimit(build("Plus", (NOW + 15 * 60_000) / 1000, NOW), NOW);
  assert.equal(r.action, "defer");
});

check("no plan_type and no resets_at", () => {
  const msg = build(null, null, NOW);
  assert.equal(msg, "You have hit your ChatGPT usage limit.");
  const r = parseUsageLimit(msg, NOW);
  assert.equal(r.plan, null);
  assert.equal(r.resetMinutes, null);
  assert.equal(r.action, "failover");
});

check("plan without window", () => {
  const r = parseUsageLimit(build("Business", null, NOW), NOW);
  assert.equal(r.plan, "business");
  assert.equal(r.resetMinutes, null);
});

check("already-expired window clamps to zero", () => {
  const msg = build("Plus", (NOW - 5 * 60_000) / 1000, NOW);
  assert.match(msg, /~0 min/);
  assert.equal(parseUsageLimit(msg, NOW).resetMinutes, 0);
});

check("wrapped in surrounding text still parses", () => {
  const r = parseUsageLimit(`429: You have hit your ChatGPT usage limit (plus plan). Try again in ~3 min.`, NOW);
  assert.equal(r.resetMinutes, 3);
});

check("unrelated errors are not usage limits", () => {
  assert.equal(parseUsageLimit("429: rate_limit_exceeded"), null);
  assert.equal(isUsageLimit("Connection error."), false);
  assert.equal(parseUsageLimit(undefined), null);
});

console.log(failures === 0 ? "\nPoC-C2 parser: PASS" : `\nPoC-C2 parser: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
