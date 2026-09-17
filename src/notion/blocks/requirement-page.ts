import { requirementSectionTitle, type RequirementPageSection } from "../display-text.js";

export type RequirementSection = RequirementPageSection;

export const REQUIREMENT_SECTION_ORDER: readonly RequirementSection[] = ["clarify", "prd", "delivery"];

export interface RequirementSectionSnapshot {
  anchorBlockId: string;
  /** The heading text the page currently carries, which an older page wrote
   * under a name this version has since changed. */
  title?: string;
  /** Blocks between this section's heading and the next one, in page order. */
  blocks: readonly { id: string; content: string }[];
}

export interface RequirementPageSnapshot {
  /** What sits before the first heading: the words the person wrote. */
  preface: readonly { id: string; content: string }[];
  /** The callout at the top, whichever heading an older page filed it under. */
  callout?: { id: string; content: string };
  sections: Partial<Record<RequirementSection, RequirementSectionSnapshot>>;
  /** Headings this page no longer has, with everything under them. */
  retired: readonly string[];
}

/** One clarification round as the page shows it: a line to fold, and what is
 * behind the fold. */
export interface DesiredClarifyRound {
  round: number;
  line: string;
  items: ReadonlyArray<{
    question: string;
    options: readonly string[];
    answer?: string | undefined;
    reading?: string | undefined;
  }>;
}

export interface DesiredPrd {
  goal: string;
  nonGoals: readonly string[];
  scenarios: ReadonlyArray<{ id: string; given: string; when: string; then: string }>;
  openQuestions: readonly string[];
  /** A confirmed PRD is what the person approved, so the page says so and
   * nothing rewrites it afterwards. */
  frozen: boolean;
}

export interface DesiredRequirementPage {
  /** What the page says at the top: the action when it is the person's turn,
   * and that there is nothing to do when it is not. */
  callout: string;
  /** Written into the page's preface only when the card arrived as a title
   * alone; a person's own words are never copied next to themselves. */
  original: string;
  clarify: readonly DesiredClarifyRound[];
  prd: DesiredPrd | null;
  /** One read-only line: scenarios are judged per Epic, and this only reports. */
  delivery: string;
}

export type RequirementPageOperation =
  | { type: "create_section"; section: RequirementSection }
  | { type: "rename_section"; section: RequirementSection; blockId: string }
  | { type: "insert_callout"; content: string }
  | { type: "insert_preface"; content: string }
  | { type: "insert_round"; afterBlockId: string; round: number }
  | { type: "update_round"; blockId: string; round: number }
  | { type: "insert_prd"; afterBlockId: string }
  | { type: "insert_prd_banner"; afterBlockId: string }
  | { type: "insert_delivery"; afterBlockId: string; content: string }
  | { type: "update_block"; blockId: string; content: string }
  | { type: "archive_block"; blockId: string };

/** Which round a folded line belongs to, whichever version wrote it. */
export function parseClarifyRound(content: string): number | undefined {
  const match = /^第 (\d+) 轮/.exec(content);
  return match ? Number(match[1]) : undefined;
}

/** What the PRD section reads as, so a draft that changed is recognised
 * without the renderer and the planner having to agree on blocks. */
export function prdLines(prd: DesiredPrd): string[] {
  return [
    ...(prd.frozen ? [prdFrozenLine()] : []),
    prd.goal,
    ...prd.nonGoals.map((item) => `不做：${item}`),
    ...prd.scenarios.map((scenario, index) => `场景 ${index + 1} · ${scenario.then} ${scenario.id}`),
    ...prd.openQuestions.map((question) => `等你裁决：${question}`),
  ];
}

export function prdFrozenLine(): string {
  return "这份 PRD 你已经确认过，不会再被改写。";
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

  // A page with nothing on it arrived as a title: the request is written into
  // its preface once, where a person would have written it.
  if (snapshot.preface.length === 0 && desired.original.trim() !== "") {
    operations.push({ type: "insert_preface", content: desired.original });
  }

  if (!snapshot.callout) {
    operations.push({ type: "insert_callout", content: desired.callout });
  } else if (snapshot.callout.content !== desired.callout) {
    operations.push({ type: "update_block", blockId: snapshot.callout.id, content: desired.callout });
  }

  for (const section of REQUIREMENT_SECTION_ORDER) {
    if (!snapshot.sections[section]) operations.push({ type: "create_section", section });
  }
  // A heading keeps its block: every block under it, and every comment a
  // person left on those, hangs off that id.
  for (const section of REQUIREMENT_SECTION_ORDER) {
    const current = snapshot.sections[section];
    if (current && current.title !== undefined && current.title !== requirementSectionTitle(section)) {
      operations.push({ type: "rename_section", section, blockId: current.anchorBlockId });
    }
  }
  for (const blockId of snapshot.retired) operations.push({ type: "archive_block", blockId });

  const clarify = snapshot.sections.clarify;
  if (clarify) {
    const present = new Map(clarify.blocks.flatMap((entry) => {
      const round = parseClarifyRound(entry.content);
      return round === undefined ? [] : [[round, entry] as const];
    }));
    let afterBlockId = clarify.blocks.at(-1)?.id ?? clarify.anchorBlockId;
    for (const round of desired.clarify) {
      const current = present.get(round.round);
      if (!current) {
        operations.push({ type: "insert_round", afterBlockId, round: round.round });
        continue;
      }
      // A round that was waiting and is now answered says so in its own line,
      // and what is behind the fold changed with it.
      if (current.content !== round.line) {
        operations.push({ type: "update_round", blockId: current.id, round: round.round });
      }
      afterBlockId = current.id;
    }
  }

  const prd = snapshot.sections.prd;
  if (prd && desired.prd) {
    const wanted = prdLines(desired.prd);
    const current = prd.blocks.map((entry) => entry.content);
    const frozenAlready = current[0] === prdFrozenLine();
    const changed = current.length !== wanted.length || current.some((line, index) => line !== wanted[index]);
    // Freezing only adds the banner: the words a person approved are the same
    // ones the page already shows, so they are not rewritten to add a line.
    const bannerOnly = desired.prd.frozen && !frozenAlready
      && current.length === wanted.length - 1
      && current.every((line, index) => line === wanted[index + 1]);
    if (bannerOnly) {
      operations.push({ type: "insert_prd_banner", afterBlockId: prd.anchorBlockId });
    } else if (changed && !frozenAlready) {
      for (const entry of prd.blocks) operations.push({ type: "archive_block", blockId: entry.id });
      operations.push({ type: "insert_prd", afterBlockId: prd.anchorBlockId });
    }
  }

  const delivery = snapshot.sections.delivery;
  if (delivery) {
    const [current, ...extra] = delivery.blocks;
    for (const entry of extra) operations.push({ type: "archive_block", blockId: entry.id });
    if (!current) {
      operations.push({ type: "insert_delivery", afterBlockId: delivery.anchorBlockId, content: desired.delivery });
    } else if (current.content !== desired.delivery) {
      operations.push({ type: "update_block", blockId: current.id, content: desired.delivery });
    }
  }
  return operations;
}
