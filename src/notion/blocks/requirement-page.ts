import {
  requirementSectionTitle,
  solutionLine,
  stackChangeWord,
  type RequirementPageSection,
} from "../display-text.js";

export type RequirementSection = RequirementPageSection;

export const REQUIREMENT_SECTION_ORDER: readonly RequirementSection[] = ["clarify", "prd", "solution", "delivery"];

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

/** A fork the solution left open, and the option it would take. */
export interface DesiredOpenDecision {
  question: string;
  recommendation: string;
}

export interface DesiredSolutionPage {
  name: string;
  purpose: string;
  /** PRD scenario ids this screen carries, as the drawing claimed them. */
  scenarios: readonly string[];
  /** What has to be visible on it, in the words the drawing used. */
  visible: readonly string[];
}

/**
 * The solution as a person judges it: how it will be built, which way the
 * screens look, what the repository would carry afterwards, and the two things
 * they tick. Everything here is already validated -- the section renders a
 * draft the exit checks accepted, so it never has to say a field is missing.
 */
export interface DesiredSolution {
  approach: { summary: string; alternatives: readonly { option: string; reason: string }[] };
  /** Absent when the requirement puts nothing on a screen. */
  direction: { summary: string; alternatives: readonly { option: string; reason: string }[] } | null;
  stackChanges: readonly { kind: string; name: string; reason: string; impact: string }[];
  qualityGates: readonly { name: string; covers: string }[];
  pages: readonly DesiredSolutionPage[];
  /** Where the screens can be clicked through, or null when this installation
   * had nowhere to put them. */
  prototypeUrl: string | null;
  /** What the drawing found wrong with the plan itself. It may not fix those,
   * so they are the person's to settle. */
  concerns: readonly string[];
  openDecisions: readonly DesiredOpenDecision[];
  /** A confirmed solution shows that it was confirmed and stops asking. */
  confirmed: boolean;
}

/** What one block of the solution section is, so the planner and the renderer
 * cannot disagree about what the section says. */
export type SolutionBlockKind =
  | "heading"
  | "paragraph"
  /** A line that introduces the bullets under it. */
  | "label"
  | "bullet"
  | "note"
  | "link"
  | "page"
  | "todo";

export interface SolutionBlock {
  kind: SolutionBlockKind;
  /** The text a reader sees, which is what a rendered page is compared by. */
  line: string;
  /** Behind a page's fold. Not compared: it moves with the line above it. */
  children?: readonly string[];
  /** Where a link block points. */
  url?: string;
  /** Whether a box is already ticked. */
  checked?: boolean;
}

function alternativeLines(
  alternatives: readonly { option: string; reason: string }[],
  title: string,
): SolutionBlock[] {
  if (alternatives.length === 0) return [];
  return [
    { kind: "label", line: title },
    ...alternatives.map((entry): SolutionBlock => ({
      kind: "bullet",
      line: solutionLine("alternative", { option: entry.option, reason: entry.reason }),
    })),
  ];
}

/**
 * The solution section, block by block. The whole section is derived from the
 * record, so a section that differs anywhere is rewritten as a whole -- which
 * is safe because the only thing on it a person owns is a tick, and a tick is
 * only asked for while the draft it belongs to is the one on the page.
 */
export function solutionBlocks(solution: DesiredSolution): SolutionBlock[] {
  const blocks: SolutionBlock[] = [
    { kind: "heading", line: solutionLine("approachTitle") },
    { kind: "paragraph", line: solution.approach.summary },
    ...alternativeLines(solution.approach.alternatives, solutionLine("approachAlternatives")),
  ];

  if (solution.direction) {
    blocks.push(
      { kind: "heading", line: solutionLine("directionTitle") },
      { kind: "paragraph", line: solution.direction.summary },
      ...alternativeLines(solution.direction.alternatives, solutionLine("directionAlternatives")),
    );
  }

  blocks.push({ kind: "heading", line: solutionLine("stackTitle") });
  if (solution.stackChanges.length === 0) {
    blocks.push({ kind: "note", line: solutionLine("stackNone") });
  } else {
    for (const change of solution.stackChanges) {
      blocks.push({
        kind: "bullet",
        line: solutionLine("stackChange", {
          kind: stackChangeWord(change.kind),
          name: change.name,
          reason: change.reason,
          impact: change.impact,
        }),
      });
    }
  }
  if (solution.qualityGates.length > 0) {
    blocks.push({ kind: "heading", line: solutionLine("gatesTitle") });
    for (const gate of solution.qualityGates) {
      blocks.push({ kind: "bullet", line: solutionLine("gate", { name: gate.name, covers: gate.covers }) });
    }
  }

  if (solution.pages.length > 0) {
    blocks.push({ kind: "heading", line: solutionLine("pagesTitle") });
    blocks.push(solution.prototypeUrl === null
      ? { kind: "paragraph", line: solutionLine("prototypeMissing") }
      : { kind: "link", line: solutionLine("prototypeLink"), url: solution.prototypeUrl });
    for (const page of solution.pages) {
      const children = [
        ...(page.scenarios.length > 0
          ? [solutionLine("pageScenarios", { scenarios: page.scenarios.join("、") })]
          : []),
        ...(page.visible.length > 0
          ? [solutionLine("pageVisible", { visible: page.visible.join("、") })]
          : []),
        solutionLine("pageStates"),
      ];
      blocks.push({
        kind: "page",
        line: solutionLine("page", { name: page.name, purpose: page.purpose }),
        children,
      });
    }
  }

  if (solution.concerns.length > 0) {
    blocks.push({ kind: "heading", line: solutionLine("concernsTitle") });
    for (const concern of solution.concerns) blocks.push({ kind: "bullet", line: concern });
  }

  if (solution.openDecisions.length > 0) {
    blocks.push({ kind: "heading", line: solutionLine("openTitle") });
    for (const decision of solution.openDecisions) {
      blocks.push({
        kind: "todo",
        line: solutionLine("openDecision", {
          question: decision.question,
          recommendation: decision.recommendation,
        }),
        checked: solution.confirmed,
      });
    }
  }

  blocks.push({ kind: "heading", line: solutionLine("confirmTitle") });
  blocks.push(solution.confirmed
    ? { kind: "note", line: solutionLine("confirmed") }
    : { kind: "todo", line: solutionLine("confirmLine"), checked: false });
  return blocks;
}

/** The line a ticked box has to carry for the tick to mean the solution is
 * approved. Read back from the page, so it lives with what writes it. */
export function solutionConfirmLine(): string {
  return solutionLine("confirmLine");
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
  /** Absent until the solution for this requirement has been drafted. */
  solution: DesiredSolution | null;
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
  | { type: "insert_solution"; afterBlockId: string }
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

  const solution = snapshot.sections.solution;
  if (solution && desired.solution) {
    const wanted = solutionBlocks(desired.solution).map((entry) => entry.line);
    const current = solution.blocks.map((entry) => entry.content);
    const changed = current.length !== wanted.length || current.some((line, index) => line !== wanted[index]);
    if (changed) {
      for (const entry of solution.blocks) operations.push({ type: "archive_block", blockId: entry.id });
      operations.push({ type: "insert_solution", afterBlockId: solution.anchorBlockId });
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
