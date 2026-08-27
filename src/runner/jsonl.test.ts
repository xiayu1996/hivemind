import { describe, expect, it } from "vitest";
import { JsonlDecoder, encodeCommand } from "./jsonl.js";

describe("JsonlDecoder", () => {
  it("splits on LF", () => {
    const d = new JsonlDecoder();
    expect(d.push('{"a":1}\n{"b":2}\n')).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("holds an incomplete record until its delimiter arrives", () => {
    const d = new JsonlDecoder();
    expect(d.push('{"a":')).toEqual([]);
    expect(d.pending).toBe('{"a":');
    expect(d.push('1}\n')).toEqual(['{"a":1}']);
    expect(d.pending).toBe("");
  });

  it("reassembles a record split across many chunks", () => {
    const d = new JsonlDecoder();
    const record = JSON.stringify({ type: "message_update", text: "x".repeat(200) });
    for (const ch of record) expect(d.push(ch)).toEqual([]);
    expect(d.push("\n")).toEqual([record]);
  });

  it("strips a trailing CR so CRLF output parses", () => {
    const d = new JsonlDecoder();
    expect(d.push('{"a":1}\r\n')).toEqual(['{"a":1}']);
  });

  it("does not split on U+2028 or U+2029 inside a JSON string", () => {
    // The reason readline cannot be used: both characters are legal in JSON strings.
    const record = JSON.stringify({ text: "line break here" });
    const d = new JsonlDecoder();
    expect(d.push(`${record}\n`)).toEqual([record]);
    expect(JSON.parse(d.push(`${record}\n`)[0]!).text).toBe("line break here");
  });

  it("keeps a lone CR inside the payload intact", () => {
    const record = JSON.stringify({ text: "a\rb" });
    const d = new JsonlDecoder();
    expect(JSON.parse(d.push(`${record}\n`)[0]!).text).toBe("a\rb");
  });

  it("ignores blank and whitespace-only lines", () => {
    const d = new JsonlDecoder();
    expect(d.push('\n   \n{"a":1}\n\n')).toEqual(['{"a":1}']);
  });

  it("handles several records arriving in one chunk", () => {
    const d = new JsonlDecoder();
    expect(d.push('{"a":1}\n{"b":2}\n{"c":3}')).toEqual(['{"a":1}', '{"b":2}']);
    expect(d.pending).toBe('{"c":3}');
  });

  it("reset discards buffered bytes", () => {
    const d = new JsonlDecoder();
    d.push('{"partial"');
    d.reset();
    expect(d.pending).toBe("");
  });
});

describe("encodeCommand", () => {
  it("emits one LF-terminated line", () => {
    expect(encodeCommand({ type: "abort" })).toBe('{"type":"abort"}\n');
  });

  it("escapes embedded newlines so a message stays one record", () => {
    const line = encodeCommand({ type: "prompt", message: "a\nb" });
    expect(line.split("\n").filter((s) => s.length > 0)).toHaveLength(1);
  });
});
