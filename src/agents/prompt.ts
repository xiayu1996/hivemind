import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * A session's system prompt is a stack of layers, most stable first: the base
 * rules, the role, the step, then the product documents the step reads. A
 * provider caches the longest prefix it has seen before, so everything that is
 * the same for every session of a requirement comes before anything that
 * changes between attempts, and what changes on every attempt (the item, the
 * findings of the last one) goes in the task message instead.
 *
 * Assembly is a pure function of its input: no clock, no randomness, no file
 * reads. The same layers always give the same bytes, which is what makes the
 * cache hit and what lets a run be replayed from its recorded inputs.
 */

export interface PromptLayer {
  name: string;
  text: string;
}

export interface ProductDocument {
  /** Path relative to the repository root. */
  path: string;
  content: string;
}

export function assembleSystemPrompt(layers: readonly PromptLayer[], documents: readonly ProductDocument[] = []): string {
  const sections = layers.filter((layer) => layer.text.trim() !== "").map((layer) => layer.text.trim());
  const sorted = [...documents].toSorted((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  for (const document of sorted) {
    sections.push(`<document path="${document.path}">\n${document.content.trimEnd()}\n</document>`);
  }
  return `${sections.join("\n\n")}\n`;
}

export function promptDigest(systemPrompt: string, task: string): string {
  return createHash("sha256").update(systemPrompt).update("\u0000").update(task).digest("hex");
}

/** Reads prompt files from one directory, each once per process. */
export class PromptLibrary {
  readonly #root: string;
  readonly #cache = new Map<string, Promise<string>>();

  constructor(root: string) {
    this.#root = root;
  }

  read(name: string): Promise<string> {
    let text = this.#cache.get(name);
    if (text === undefined) {
      text = readFile(join(this.#root, `${name}.md`), "utf8");
      this.#cache.set(name, text);
    }
    return text;
  }

  async layer(name: string): Promise<PromptLayer> {
    return { name, text: await this.read(name) };
  }
}
