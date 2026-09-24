import { describe, expect, it } from "vitest";
import {
  ARRAY_LIMIT,
  RUN_LIMIT,
  chunk,
  code,
  paragraphs,
  plainText,
  text,
  toggle,
  type Block,
  type RichTextRun,
} from "./rich-text.ts";

function runsOf(block: Block): RichTextRun[] {
  return (block[block.type] as { rich_text: RichTextRun[] }).rich_text;
}

function contentOf(block: Block): string {
  return runsOf(block).map((run) => run.text.content).join("");
}

describe("chunk", () => {
  it("splits a long text instead of losing it, because Notion rejects a run over 2000 characters", () => {
    const content = `${"\u7532".repeat(1_500)}\n${"\u4e59".repeat(1_200)}`;
    const parts = chunk(content);
    expect(parts.every((part) => part.length <= RUN_LIMIT)).toBe(true);
    expect(parts.join("")).toBe(content);
    // The cut lands on the line break the text offers rather than mid-sentence.
    expect(parts[0]!.endsWith("\n")).toBe(true);
  });

  it("never cuts between the two halves of a character outside the basic plane", () => {
    const content = `${"a".repeat(RUN_LIMIT - 1)}\u{1F600}tail`;
    const parts = chunk(content);
    expect(parts[0]).toBe("a".repeat(RUN_LIMIT - 1));
    expect(parts[1]!.startsWith("\u{1F600}")).toBe(true);
    expect(parts.join("")).toBe(content);
  });

  it("produces no run at all for empty text", () => {
    expect(chunk("")).toEqual([]);
    expect(text("")).toEqual([]);
  });
});

describe("builders", () => {
  it("marks inline code so a marker reads as a handle", () => {
    expect(code("hivemind:report:r-1")).toEqual([
      { type: "text", text: { content: "hivemind:report:r-1" }, annotations: { code: true } },
    ]);
  });

  it("leaves a childless toggle without a children key, which Notion rejects as empty", () => {
    expect((toggle(text("empty")).toggle as Record<string, unknown>).children).toBeUndefined();
    expect((toggle(text("full"), paragraphs("inside")).toggle as { children: Block[] }).children).toHaveLength(1);
  });
});

describe("paragraphs", () => {
  it("makes one block per paragraph and keeps line breaks inside a paragraph", () => {
    const blocks = paragraphs("first line\nsecond line\n\n\n  indented\r\n\r\nlast\n");
    expect(blocks.map(contentOf)).toEqual(["first line\nsecond line", "  indented", "last"]);
    expect(blocks.every((block) => block.type === "paragraph")).toBe(true);
  });

  it("merges paragraphs beyond the block budget rather than dropping any", () => {
    const content = Array.from({ length: 250 }, (_, index) => `paragraph ${index}`).join("\n\n");
    const blocks = paragraphs(content, ARRAY_LIMIT);
    expect(blocks.length).toBeLessThanOrEqual(ARRAY_LIMIT);
    expect(blocks.map(contentOf).join("\n\n")).toBe(content);
  });

  it("continues a paragraph too long for one rich text in the next block", () => {
    const blocks = paragraphs("x".repeat(RUN_LIMIT * ARRAY_LIMIT + 10));
    expect(blocks).toHaveLength(2);
    expect(runsOf(blocks[0]!)).toHaveLength(ARRAY_LIMIT);
    expect(blocks.map(contentOf).join("")).toHaveLength(RUN_LIMIT * ARRAY_LIMIT + 10);
  });

  it("returns nothing for blank text", () => {
    expect(paragraphs(" \n\n \n")).toEqual([]);
  });
});

describe("plainText", () => {
  it("reads the words a person sees from the runs Notion returns, mentions included", () => {
    expect(plainText([
      { type: "text", text: { content: "Ask " }, plain_text: "Ask " },
      { type: "mention", mention: { type: "user", user: { id: "u-1" } }, plain_text: "@Ryan" },
    ])).toBe("Ask @Ryan");
    expect(plainText(undefined)).toBe("");
  });
});
