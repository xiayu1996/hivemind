import { describe, expect, it } from "vitest";
import { bold, chunk, code, paragraph, plainText, runs, t, table, toggle } from "./rich-text.js";

describe("rich text", () => {
  it("splits a long paragraph instead of losing it, because Notion rejects a run over 2000 characters", () => {
    const content = `${"甲".repeat(1_500)}\n${"乙".repeat(1_200)}`;
    const parts = chunk(content);
    expect(parts.every((part) => part.length <= 2_000)).toBe(true);
    expect(parts.join("")).toBe(content);
    // The break lands on the line the text offers rather than mid-sentence.
    expect(parts[0]!.endsWith("\n")).toBe(true);
  });

  it("reads back the words a person sees, whatever runs they arrived in", () => {
    const content = runs(bold("场景 1 · 保存规则"), t(" "), code("s01"));
    expect(plainText(content)).toBe("场景 1 · 保存规则 s01");
    expect(content[0]!.annotations?.bold).toBe(true);
    expect(content.at(-1)!.annotations?.code).toBe(true);
  });

  it("pads a short row, because a table's width is fixed when it is created", () => {
    const built = table(["场景", "测试", "走查"], [["场景 1", "通过"]]) as any;
    expect(built.table.table_width).toBe(3);
    expect(built.table.children).toHaveLength(2);
    expect(built.table.children[1].table_row.cells).toHaveLength(3);
    expect(plainText(built.table.children[1].table_row.cells[2])).toBe("");
  });

  it("leaves a childless toggle without a children key, which Notion rejects as empty", () => {
    expect((toggle(t("第 1 轮")) as any).toggle.children).toBeUndefined();
    expect((toggle(t("第 1 轮"), [paragraph(t("内容"))]) as any).toggle.children).toHaveLength(1);
  });
});
