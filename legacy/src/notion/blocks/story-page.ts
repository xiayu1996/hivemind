import { quietText, sectionTitle } from "../display-text.js";
import { isWithdrawn, specLine, withdrawnLine, type DesiredRound, type DesiredSpec } from "./story-render.js";

export type StorySection =
  | "requirement"
  | "specification"
  | "design"
  | "verification"
  | "questions"
  | "technical";

const SECTION_ORDER: readonly StorySection[] = [
  "requirement",
  "specification",
  "design",
  "verification",
  "questions",
  "technical",
];

export interface SectionSnapshot {
  anchorBlockId: string;
  /** The heading text the page currently carries, which an older page wrote
   * under a name this version has since changed. */
  title?: string;
  contentBlockId?: string;
  content?: string;
}

export interface SpecSnapshot {
  id: string;
  seq: number;
  /** The line as the page currently reads, whichever version wrote it. */
  line: string;
  blockId: string;
}

export interface VerificationRoundSnapshot {
  round: number;
  toggleBlockId: string;
  summary: string;
}

export interface StoryPageSnapshot {
  sections: Partial<Record<StorySection, SectionSnapshot>>;
  metadata?: { blockId: string; content: string };
  specs: SpecSnapshot[];
  verificationRounds: VerificationRoundSnapshot[];
}

export type { DesiredSpec } from "./story-render.js";

export interface DesiredStoryPage {
  /** What the callout at the top says, when it is a person's turn. Absent
   * otherwise: the board columns already carry state, waiting and cost, and a
   * page that repeats them spends attention without adding anything. */
  metadata?: string;
  design: string;
  questions?: string;
  /** The fixed words of the fold; what it holds is compared by hash, not here. */
  technical?: string;
  specs: DesiredSpec[];
  verificationRound?: DesiredRound;
}

export type StoryPageOperation =
  | { type: "create_section"; section: StorySection }
  | { type: "rename_section"; section: StorySection; blockId: string }
  | { type: "insert_metadata"; content: string }
  | { type: "insert_content"; section: StorySection; afterBlockId: string; content: string }
  | { type: "update_block"; blockId: string; content: string }
  | { type: "insert_spec"; afterBlockId: string; specId: string; seq: number; content: string }
  | { type: "insert_verification_round"; afterBlockId: string; round: DesiredRound }
  | { type: "archive_verification_rounds"; rounds: Array<{ round: number; toggleBlockId: string }> }
  | { type: "archive_block"; blockId: string };



function planSectionContent(
  operations: StoryPageOperation[],
  section: StorySection,
  snapshot: SectionSnapshot | undefined,
  desired: string | undefined,
): void {
  if (!desired || !snapshot) return;
  if (snapshot.contentBlockId) {
    if (snapshot.content !== desired) {
      operations.push({ type: "update_block", blockId: snapshot.contentBlockId, content: desired });
    }
  } else {
    operations.push({ type: "insert_content", section, afterBlockId: snapshot.anchorBlockId, content: desired });
  }
}

/**
 * Computes minimal in-place edits. Existing Spec and section block IDs are
 * never replaced, which preserves the comments attached to those anchors.
 */
export function planStoryPageUpdate(
  snapshot: StoryPageSnapshot,
  desired: DesiredStoryPage,
  visibleRoundLimit = 8,
): StoryPageOperation[] {
  const operations: StoryPageOperation[] = [];
  for (const section of SECTION_ORDER) {
    if (!snapshot.sections[section]) operations.push({ type: "create_section", section });
  }

  // A heading keeps its block: the section anchors, the Spec paragraphs under
  // it and every comment a person left on them hang off that id, so a rename
  // is an edit to the words and never a new block.
  for (const section of SECTION_ORDER) {
    const current = snapshot.sections[section];
    if (current && current.title !== undefined && current.title !== sectionTitle(section)) {
      operations.push({ type: "rename_section", section, blockId: current.anchorBlockId });
    }
  }

  // The callout is the one block that must sit at the top, and Notion can only
  // append after a block, so it is written rather than archived: a quiet day
  // says so in one line instead of losing the anchor.
  const callout = desired.metadata ?? quietText().action;
  if (snapshot.metadata) {
    if (snapshot.metadata.content !== callout) {
      operations.push({ type: "update_block", blockId: snapshot.metadata.blockId, content: callout });
    }
  } else if (desired.metadata !== undefined) {
    operations.push({ type: "insert_metadata", content: desired.metadata });
  }
  planSectionContent(operations, "design", snapshot.sections.design, desired.design);
  planSectionContent(operations, "questions", snapshot.sections.questions, desired.questions);
  planSectionContent(operations, "technical", snapshot.sections.technical, desired.technical);

  const existingSpecs = new Map(snapshot.specs.map((spec) => [spec.id, spec]));
  const desiredIds = new Set(desired.specs.map((spec) => spec.id));
  const specificationAnchor = snapshot.sections.specification?.anchorBlockId;
  for (const spec of desired.specs.toSorted((a, b) => a.seq - b.seq || a.id.localeCompare(b.id, "en"))) {
    const current = existingSpecs.get(spec.id);
    const content = specLine(spec);
    if (current) {
      if (current.line !== content) {
        operations.push({ type: "update_block", blockId: current.blockId, content });
      }
    } else if (specificationAnchor) {
      operations.push({
        type: "insert_spec",
        afterBlockId: specificationAnchor,
        specId: spec.id,
        seq: spec.seq,
        content,
      });
    }
  }
  for (const current of snapshot.specs.toSorted((a, b) => a.seq - b.seq)) {
    if (!desiredIds.has(current.id) && !isWithdrawn(current.line)) {
      // The words stay as the page has them: nothing here knows what the
      // scenario was called, and inventing a name for it is worse than a tick.
      operations.push({ type: "update_block", blockId: current.blockId, content: withdrawnLine(current.line) });
    }
  }

  const verificationAnchor = snapshot.sections.verification?.anchorBlockId;
  const newRound = desired.verificationRound;
  const roundExists = newRound && snapshot.verificationRounds.some((round) => round.round === newRound.round);
  if (newRound && !roundExists && verificationAnchor) {
    operations.push({
      type: "insert_verification_round",
      afterBlockId: verificationAnchor,
      round: newRound,
    });
  }

  const totalRounds = snapshot.verificationRounds.length + (newRound && !roundExists ? 1 : 0);
  const archiveCount = Math.max(0, totalRounds - visibleRoundLimit);
  if (archiveCount > 0) {
    const rounds = snapshot.verificationRounds
      .toSorted((a, b) => a.round - b.round)
      .slice(0, archiveCount)
      .map(({ round, toggleBlockId }) => ({ round, toggleBlockId }));
    if (rounds.length > 0) operations.push({ type: "archive_verification_rounds", rounds });
  }

  return operations;
}
