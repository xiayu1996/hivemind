import { describe, expect, it } from "vitest";
import { jsonPayloadCandidates } from "./json-payload.js";

describe("jsonPayloadCandidates", () => {
  it("finds a bare payload", () => {
    expect(jsonPayloadCandidates('{"done":true}')).toContainEqual({ done: true });
  });

  it("finds a payload wrapped in prose and a code fence", () => {
    const raw = 'Here is my judgement.\n```json\n{"done":false,"reason":"tests were not run"}\n```\nThanks.';
    expect(jsonPayloadCandidates(raw)).toContainEqual({ done: false, reason: "tests were not run" });
  });

  it("keeps both a discarded draft and the answer that follows it", () => {
    const raw = [
      "<think>",
      '```json',
      '{"done":true,"reason":"looks complete"}',
      '```',
      "on reflection the tests never ran</think>",
      '{"done":false,"reason":"no test command appears in the trajectory"}',
    ].join("\n");
    const candidates = jsonPayloadCandidates(raw);
    expect(candidates).toContainEqual({ done: true, reason: "looks complete" });
    expect(candidates).toContainEqual({ done: false, reason: "no test command appears in the trajectory" });
  });

  it("returns nothing parseable rather than guessing", () => {
    expect(jsonPayloadCandidates("no payload here")).toEqual([]);
  });
});
