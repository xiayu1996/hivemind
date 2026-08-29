import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export interface ExplicitContextFile {
  /** Stable model-visible name; never an absolute host path. */
  label: string;
  path: string;
}

export interface EffectiveContextFile extends ExplicitContextFile {
  sha256: string;
}

export interface ExplicitContextBundle {
  text: string;
  files: EffectiveContextFile[];
}

export class ContextFileError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ContextFileError";
  }
}

/**
 * Loads only caller-approved context files and emits an auditable manifest.
 * Labels, rather than host paths, enter the model text so the same repository
 * produces byte-identical prefixes on another worker.
 */
export async function loadExplicitContextBundle(
  requested: readonly ExplicitContextFile[],
): Promise<ExplicitContextBundle> {
  const labels = new Set<string>();
  const sections: string[] = [];
  const files: EffectiveContextFile[] = [];

  for (const request of requested) {
    if (request.label.trim() === "" || /[\r\n]/.test(request.label)) {
      throw new ContextFileError("context label must be a non-empty single line");
    }
    if (labels.has(request.label)) throw new ContextFileError(`duplicate context label: ${request.label}`);
    labels.add(request.label);

    const path = resolve(request.path);
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch (cause) {
      throw new ContextFileError(`cannot load explicit context file ${path}: ${(cause as Error).message}`, { cause });
    }
    const content = bytes.toString("utf8");
    if (content.trim() === "") throw new ContextFileError(`explicit context file is empty: ${path}`);

    sections.push(`## Context: ${request.label}\n\n${content.trim()}`);
    files.push({
      label: request.label,
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }

  return {
    text: sections.length === 0 ? "" : `${sections.join("\n\n")}\n`,
    files,
  };
}
