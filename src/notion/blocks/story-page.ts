export type StorySection = "requirement" | "specification" | "design" | "verification" | "questions";

const SECTION_ORDER: readonly StorySection[] = [
  "requirement",
  "specification",
  "design",
  "verification",
  "questions",
];

export interface SectionSnapshot {
  anchorBlockId: string;
  contentBlockId?: string;
  content?: string;
}

export interface SpecSnapshot {
  id: string;
  seq: number;
  status: string;
  text: string;
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

export interface DesiredSpec {
  id: string;
  seq: number;
  status: string;
  text: string;
}

export interface DesiredStoryPage {
  metadata: string;
  design: string;
  questions?: string;
  specs: DesiredSpec[];
  verificationRound?: { round: number; summary: string };
}

export type StoryPageOperation =
  | { type: "create_section"; section: StorySection }
  | { type: "insert_content"; section: StorySection; afterBlockId: string; content: string }
  | { type: "update_block"; blockId: string; content: string }
  | { type: "insert_spec"; afterBlockId: string; specId: string; seq: number; content: string }
  | { type: "insert_verification_round"; afterBlockId: string; round: number; summary: string }
  | { type: "archive_verification_rounds"; rounds: Array<{ round: number; toggleBlockId: string }> }
  | { type: "archive_block"; blockId: string };

function specContent(spec: Pick<DesiredSpec, "id" | "status" | "text">): string {
  return `${spec.id} [${spec.status}] ${spec.text}`;
}

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

  if (snapshot.metadata) {
    if (snapshot.metadata.content !== desired.metadata) {
      operations.push({ type: "update_block", blockId: snapshot.metadata.blockId, content: desired.metadata });
    }
  }
  planSectionContent(operations, "design", snapshot.sections.design, desired.design);
  planSectionContent(operations, "questions", snapshot.sections.questions, desired.questions);

  const existingSpecs = new Map(snapshot.specs.map((spec) => [spec.id, spec]));
  const desiredIds = new Set(desired.specs.map((spec) => spec.id));
  const specificationAnchor = snapshot.sections.specification?.anchorBlockId;
  for (const spec of desired.specs.toSorted((a, b) => a.seq - b.seq || a.id.localeCompare(b.id, "en"))) {
    const current = existingSpecs.get(spec.id);
    const content = specContent(spec);
    if (current) {
      if (specContent(current) !== content) {
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
    if (!desiredIds.has(current.id) && current.status !== "withdrawn") {
      operations.push({
        type: "update_block",
        blockId: current.blockId,
        content: specContent({ ...current, status: "withdrawn" }),
      });
    }
  }

  const verificationAnchor = snapshot.sections.verification?.anchorBlockId;
  const newRound = desired.verificationRound;
  const roundExists = newRound && snapshot.verificationRounds.some((round) => round.round === newRound.round);
  if (newRound && !roundExists && verificationAnchor) {
    operations.push({
      type: "insert_verification_round",
      afterBlockId: verificationAnchor,
      round: newRound.round,
      summary: newRound.summary,
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
