/**
 * The one place a Notion rich text run or block is built. Notion caps a run at
 * 2000 characters and answers a longer one with a 400, so the builders here
 * split rather than throw: a page that drops a paragraph because a person
 * wrote a long one is worse than a page that shows it in two runs.
 */
const RUN_LIMIT = 2_000;

export interface RichTextRun {
  type: "text" | "mention";
  text?: { content: string; link?: { url: string } };
  mention?: { type: "page"; page: { id: string } };
  annotations?: { bold?: boolean; italic?: boolean; code?: boolean; color?: string };
}

/** Splits on the run limit, preferring a line break so a break never lands
 * mid-word when the text has one to use. */
export function chunk(content: string): string[] {
  const parts: string[] = [];
  let rest = content;
  while (rest.length > RUN_LIMIT) {
    const window = rest.slice(0, RUN_LIMIT);
    const cut = window.lastIndexOf("\n");
    const take = cut > RUN_LIMIT / 2 ? cut + 1 : RUN_LIMIT;
    parts.push(rest.slice(0, take));
    rest = rest.slice(take);
  }
  if (rest.length > 0 || parts.length === 0) parts.push(rest);
  return parts;
}

export function t(content: string): RichTextRun[] {
  return chunk(content).map((part) => ({ type: "text" as const, text: { content: part } }));
}

function annotated(content: string, annotations: NonNullable<RichTextRun["annotations"]>): RichTextRun[] {
  return chunk(content).map((part) => ({ type: "text" as const, text: { content: part }, annotations }));
}

export function bold(content: string): RichTextRun[] {
  return annotated(content, { bold: true });
}

export function italic(content: string): RichTextRun[] {
  return annotated(content, { italic: true });
}

/** Inline code, which is also how an internal id reaches a page: it reads as a
 * handle rather than as a word, and the language lint skips it. */
export function code(content: string): RichTextRun[] {
  return annotated(content, { code: true });
}

export function link(content: string, url: string): RichTextRun[] {
  return chunk(content).map((part) => ({ type: "text" as const, text: { content: part, link: { url } } }));
}

export function pageMention(pageId: string): RichTextRun[] {
  return [{ type: "mention", mention: { type: "page", page: { id: pageId } } }];
}

export function runs(...parts: RichTextRun[][]): RichTextRun[] {
  return parts.flat();
}

/** The text a reader sees, which is what two renderings are compared by: the
 * same words in a different run split are the same page. */
export function plainText(content: RichTextRun[]): string {
  return content.map((run) => run.text?.content ?? "").join("");
}

export type Block = Record<string, unknown>;

function block(type: string, body: Record<string, unknown>): Block {
  return { object: "block", type, [type]: body };
}

export function paragraph(content: RichTextRun[], color?: string): Block {
  return block("paragraph", { rich_text: content, ...(color ? { color } : {}) });
}

export function heading2(content: RichTextRun[], toggleable = false): Block {
  return block("heading_2", { rich_text: content, ...(toggleable ? { is_toggleable: true } : {}) });
}

export function callout(content: RichTextRun[], icon: string, color: string): Block {
  return block("callout", { rich_text: content, icon: { type: "emoji", emoji: icon }, color });
}

export function bullet(content: RichTextRun[], children?: Block[]): Block {
  return block("bulleted_list_item", { rich_text: content, ...(children?.length ? { children } : {}) });
}

export function numbered(content: RichTextRun[], children?: Block[]): Block {
  return block("numbered_list_item", { rich_text: content, ...(children?.length ? { children } : {}) });
}

export function quote(content: RichTextRun[]): Block {
  return block("quote", { rich_text: content });
}

export function todo(content: RichTextRun[], checked: boolean): Block {
  return block("to_do", { rich_text: content, checked });
}

export function toggle(content: RichTextRun[], children?: Block[]): Block {
  return block("toggle", { rich_text: content, ...(children?.length ? { children } : {}) });
}

export function mermaid(diagram: string): Block {
  return block("code", { rich_text: t(diagram), language: "mermaid" });
}

/**
 * A table has to be built with its width, which Notion fixes at creation: a
 * row with a different cell count is rejected, so every row is padded here
 * rather than at each call site.
 */
export function table(header: string[], rows: string[][]): Block {
  const width = header.length;
  const row = (cells: string[]): Block =>
    block("table_row", { cells: Array.from({ length: width }, (_, index) => t(cells[index] ?? "")) });
  return block("table", {
    table_width: width,
    has_column_header: true,
    has_row_header: false,
    children: [row(header), ...rows.map(row)],
  });
}
