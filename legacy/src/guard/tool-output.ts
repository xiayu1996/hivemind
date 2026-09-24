import type { GuardPhase } from "./policy.js";

/**
 * Upper bounds on what one tool result may put into the model context.
 *
 * Every byte of a tool result is billed as uncached input on the turn that
 * produced it, and read-only exploration phases tend to fan out several large
 * searches in one turn. The bounds are set per phase because CODE and VERIFY
 * need complete test output, while a Story plan does not need a whole file.
 */
export interface ToolOutputLimits {
  maxBytes: number;
  maxLines: number;
}

export interface ToolResultContent {
  type: string;
  text?: string;
}

/** pi's own built-in truncation, kept explicit so a phase that wants it says so. */
export const PI_DEFAULT_TOOL_OUTPUT_LIMITS: ToolOutputLimits = { maxBytes: 50 * 1024, maxLines: 2000 };

const EXPLORATION_LIMITS: ToolOutputLimits = { maxBytes: 8 * 1024, maxLines: 200 };

const EXPLORATION_PHASES = new Set<GuardPhase>(["DECOMPOSE", "DESIGN"]);

export function toolOutputLimitsFor(phase: GuardPhase): ToolOutputLimits {
  return EXPLORATION_PHASES.has(phase) ? { ...EXPLORATION_LIMITS } : { ...PI_DEFAULT_TOOL_OUTPUT_LIMITS };
}

export interface TruncatedToolOutput {
  content: ToolResultContent[];
  truncated: boolean;
  originalBytes: number;
}

/**
 * Keeps the head of each text block within the limits. The head is kept, not
 * the tail, because reads and searches put the most relevant lines first and
 * the marker tells the model exactly how much it did not see, so it can ask
 * for a narrower range instead of guessing.
 */
export function truncateToolResult(
  content: readonly ToolResultContent[],
  limits: ToolOutputLimits,
): TruncatedToolOutput {
  let truncated = false;
  let originalBytes = 0;
  const output = content.map((block) => {
    if (block.type !== "text" || typeof block.text !== "string") return block;
    const bytes = Buffer.byteLength(block.text, "utf8");
    originalBytes += bytes;
    const lines = block.text.split("\n");
    if (bytes <= limits.maxBytes && lines.length <= limits.maxLines) return block;

    truncated = true;
    let kept = lines.slice(0, limits.maxLines).join("\n");
    if (Buffer.byteLength(kept, "utf8") > limits.maxBytes) {
      kept = Buffer.from(kept, "utf8").subarray(0, limits.maxBytes).toString("utf8");
      // A cut inside a multi-byte sequence decodes to U+FFFD; drop it rather than
      // hand the model a replacement character it may echo back.
      kept = kept.replace(/�+$/u, "");
    }
    const keptLines = kept.split("\n").length;
    const marker = `\n\n[hivemind: output truncated for this phase, ${bytes} bytes / ${lines.length} lines total, ` +
      `showing the first ${keptLines} lines. Request a narrower range if the rest matters.]`;
    return { ...block, text: kept + marker };
  });
  return { content: output, truncated, originalBytes };
}
