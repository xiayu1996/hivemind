export type RequirementSection = "metadata" | "original" | "clarify" | "prd" | "acceptance";

export const REQUIREMENT_SECTION_ORDER: readonly RequirementSection[] = [
  "metadata",
  "original",
  "clarify",
  "prd",
  "acceptance",
];

export interface RequirementSectionSnapshot {
  anchorBlockId: string;
  /** Blocks between this section's heading and the next one, in page order. */
  blocks: readonly { id: string; content: string }[];
}

export interface RequirementPageSnapshot {
  sections: Partial<Record<RequirementSection, RequirementSectionSnapshot>>;
}

export interface DesiredRequirementPage {
  metadata: string;
  /** Written once if the person left the section empty; never rewritten. */
  original: string;
  /** Appended in order; earlier rounds are never edited away. */
  clarify: readonly string[];
  prd: readonly string[];
  /** A confirmed PRD is what the person approved, so nothing may touch it. */
  prdFrozen: boolean;
  acceptance: readonly string[];
}

export type RequirementPageOperation =
  | { type: "create_section"; section: RequirementSection }
  | { type: "insert"; section: RequirementSection; afterBlockId: string; content: string; block: "paragraph" | "callout" | "to_do" }
  | { type: "update_block"; blockId: string; content: string }
  | { type: "archive_block"; blockId: string };

function appendMissing(
  operations: RequirementPageOperation[],
  section: RequirementSection,
  snapshot: RequirementSectionSnapshot | undefined,
  desired: readonly string[],
  block: "paragraph" | "to_do",
): void {
  if (!snapshot) return;
  const present = new Set(snapshot.blocks.map((entry) => entry.content));
  // Everything new goes after the section's current last block, in one run, so
  // the delivery can append the whole batch and keep this order.
  const afterBlockId = snapshot.blocks.at(-1)?.id ?? snapshot.anchorBlockId;
  for (const content of desired) {
    if (present.has(content)) continue;
    operations.push({ type: "insert", section, afterBlockId, content, block });
    present.add(content);
  }
}

/**
 * Computes the minimal edits that bring a requirement page to the state the
 * central database describes. Two things are deliberately one-way: the
 * clarification log only grows, and a confirmed PRD is never touched again.
 * Both are what makes the page readable as a record of what actually happened.
 */
export function planRequirementPageUpdate(
  snapshot: RequirementPageSnapshot,
  desired: DesiredRequirementPage,
): RequirementPageOperation[] {
  const operations: RequirementPageOperation[] = [];
  for (const section of REQUIREMENT_SECTION_ORDER) {
    if (!snapshot.sections[section]) operations.push({ type: "create_section", section });
  }

  const metadata = snapshot.sections.metadata;
  if (metadata) {
    const current = metadata.blocks[0];
    if (!current) {
      operations.push({
        type: "insert",
        section: "metadata",
        afterBlockId: metadata.anchorBlockId,
        content: desired.metadata,
        block: "callout",
      });
    } else if (current.content !== desired.metadata) {
      operations.push({ type: "update_block", blockId: current.id, content: desired.metadata });
    }
  }

  const original = snapshot.sections.original;
  // The person owns this section. It is filled in only when they left it empty,
  // which happens when the card was created from a title alone.
  if (original && original.blocks.length === 0 && desired.original.trim() !== "") {
    operations.push({
      type: "insert",
      section: "original",
      afterBlockId: original.anchorBlockId,
      content: desired.original,
      block: "paragraph",
    });
  }

  appendMissing(operations, "clarify", snapshot.sections.clarify, desired.clarify, "paragraph");

  const prd = snapshot.sections.prd;
  if (prd && !desired.prdFrozen) {
    const current = prd.blocks.map((entry) => entry.content);
    const changed = current.length !== desired.prd.length
      || current.some((content, index) => content !== desired.prd[index]);
    if (changed) {
      for (const entry of prd.blocks) operations.push({ type: "archive_block", blockId: entry.id });
      for (const content of desired.prd) {
        operations.push({
          type: "insert",
          section: "prd",
          afterBlockId: prd.anchorBlockId,
          content,
          block: "paragraph",
        });
      }
    }
  }

  appendMissing(operations, "acceptance", snapshot.sections.acceptance, desired.acceptance, "to_do");
  return operations;
}
