/**
 * Builders for the rich text and blocks the board writes, and the reader for
 * the rich text Notion returns.
 *
 * Notion answers a text run over 2000 characters, and any array over 100
 * elements (runs in one rich text, children in one request), with a 400. The
 * builders split instead of throwing: a page that loses a paragraph because
 * someone wrote a long one is worse than a page that shows it in two runs.
 */

export const RUN_LIMIT = 2_000;
export const ARRAY_LIMIT = 100;

export interface Annotations {
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
}

export interface RichTextRun {
  type: "text";
  text: { content: string };
  annotations?: Annotations;
}

export interface Block {
  object: "block";
  type: string;
  [payload: string]: unknown;
}

/** Moves a cut at `index` back by one when it would split a surrogate pair. */
export function safeCut(content: string, index: number): number {
  if (index <= 0) return 0;
  if (index >= content.length) return content.length;
  const before = content.charCodeAt(index - 1);
  return before >= 0xd800 && before <= 0xdbff ? index - 1 : index;
}

/** Splits on the run limit, preferring a line break in the second half of the
 * window so a cut lands between lines when the text offers one. */
export function chunk(content: string): string[] {
  const parts: string[] = [];
  let rest = content;
  while (rest.length > RUN_LIMIT) {
    const newline = rest.lastIndexOf("\n", RUN_LIMIT - 1);
    const take = newline > RUN_LIMIT / 2 ? newline + 1 : safeCut(rest, RUN_LIMIT);
    parts.push(rest.slice(0, take));
    rest = rest.slice(take);
  }
  if (rest.length > 0) parts.push(rest);
  return parts;
}

export function text(content: string, annotations?: Annotations): RichTextRun[] {
  return chunk(content).map((part) => {
    const run: RichTextRun = { type: "text", text: { content: part } };
    if (annotations) run.annotations = annotations;
    return run;
  });
}

/** Inline code, which is how an internal marker reaches a page: it reads as a
 * handle rather than as a word. */
export function code(content: string): RichTextRun[] {
  return text(content, { code: true });
}

function block(type: string, payload: Record<string, unknown>): Block {
  return { object: "block", type, [type]: payload };
}

export function paragraph(runs: RichTextRun[]): Block {
  return block("paragraph", { rich_text: runs });
}

export function heading(runs: RichTextRun[]): Block {
  return block("heading_2", { rich_text: runs });
}

/** A toggle without children carries no children key: Notion refuses an empty array. */
export function toggle(runs: RichTextRun[], children: readonly Block[] = []): Block {
  return block("toggle", { rich_text: runs, ...(children.length > 0 ? { children } : {}) });
}

export function todo(runs: RichTextRun[], checked = false): Block {
  return block("to_do", { rich_text: runs, checked });
}

/**
 * Plain text as paragraph blocks, one per blank-line separated paragraph.
 * Line breaks inside a paragraph stay inside its block. More paragraphs than
 * `maxBlocks` are merged into neighbours rather than dropped, and a paragraph
 * too long for one rich text continues in the next block.
 */
export function paragraphs(content: string, maxBlocks = ARRAY_LIMIT): Block[] {
  const parts = content
    .replaceAll(/\r\n?/g, "\n")
    .split(/\n[ \t]*\n/)
    .map((part) => part.replace(/^\n+/, "").trimEnd())
    .filter((part) => part.trim() !== "");
  const perBlock = Math.max(1, Math.ceil(parts.length / Math.max(1, maxBlocks)));
  const blocks: Block[] = [];
  for (let index = 0; index < parts.length; index += perBlock) {
    const runs = text(parts.slice(index, index + perBlock).join("\n\n"));
    for (let start = 0; start < runs.length; start += ARRAY_LIMIT) {
      blocks.push(paragraph(runs.slice(start, start + ARRAY_LIMIT)));
    }
  }
  return blocks;
}

/** The words of a rich text array as Notion returns it, mentions included. */
export function plainText(richText: unknown): string {
  if (!Array.isArray(richText)) return "";
  return richText
    .map((run: unknown) =>
      typeof run === "object" && run !== null && "plain_text" in run && typeof run.plain_text === "string"
        ? run.plain_text
        : "")
    .join("");
}
