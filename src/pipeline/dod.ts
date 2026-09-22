import { parse } from "yaml";
import { directoryOf } from "../util/repository-path.js";
import { z } from "zod";
import { lintHumanSentence } from "../report/business-language.js";

const storyId = z.string().regex(/^S-[A-Z0-9]+-\d{2}$/);
const scenarioId = z.string().regex(/^S-[A-Z0-9]+-\d{2}-[a-z0-9]+$/);
const layer = z.enum(["unit", "integration", "snapshot", "e2e", "ui"]);
export type TestLayer = z.infer<typeof layer>;

/**
 * Who produces the evidence for a layer. CODE is test-driven and fast: it owns
 * the layers a test runner settles. Anything that needs a browser and a screen
 * is VERIFY's, so CODE never buys a slow browser round and VERIFY never trusts
 * CODE's account of one. Fixed by the system, not declared by the author, so a
 * DoD cannot move a layer to the side that will not look at it.
 */
export const LAYER_OWNER: Readonly<Record<TestLayer, "code" | "verify">> = {
  unit: "code",
  integration: "code",
  snapshot: "code",
  e2e: "verify",
  ui: "verify",
};

const example = z.object({
  kind: z.enum(["shows", "excludes"]),
  /** Literal text or state a person sees (shows) or must not see (excludes). */
  text: z.string().trim().min(1),
}).strict();

const scenario = z.object({
  id: scenarioId,
  /**
   * What the scenario is, in at most twenty Chinese characters: it is the line
   * a person reads on the card and in every verification round, where the
   * given/when/then is detail they open only when they care. Optional in the
   * schema because a DoD frozen before this existed still has to parse; the
   * SHAPE exit gate requires it of anything written from now on.
   */
  title: z.string().trim().min(1).max(20).optional(),
  given: z.string().trim().min(1),
  when: z.string().trim().min(1),
  // oxlint-disable-next-line unicorn/no-thenable -- Given/When/Then is the external DoD contract.
  then: z.string().trim().min(1),
  layers: z.array(layer).min(1),
  /** Where the shown data comes from: table, event type, existing endpoint. */
  source: z.string().trim().min(1).optional(),
  examples: z.array(example).optional(),
  /**
   * The sample data the given needs on a screen, in plain language, e.g. "one
   * repository with 3 stories, 1 delivered, 1 parked". The repository's seed
   * command receives it verbatim before the interface is reviewed; without it
   * the reviewer looks at whatever the application starts with, which is how a
   * review ends inconclusive for lack of anything to look at.
   */
  seed: z.string().trim().min(1).optional(),
  /**
   * What a person must be able to see once this scenario passes, as roles and
   * text the accessibility tree will carry. Required of scenarios a browser
   * settles and meaningless on the others, which is why the schema leaves it
   * optional and the SHAPE exit gate asks for it per layer (design 08 6).
   *
   * This is the structural layer's basis: without it a round that rendered
   * nothing but a 404 body still produced four screenshots and four confident
   * verdicts, because no code had anything to compare the page against.
   */
  /**
   * Where the application serves this scenario's screen, as a path beginning
   * with `/`. Required of scenarios a browser settles; optional in the schema
   * because a DoD frozen before this existed still has to parse.
   *
   * It is what turns "is the screen reachable at all" into a question code can
   * answer before a browser is involved. A component that was written and
   * never mounted passes every unit test it has, and a verifier that stands up
   * its own server finds the screen there because it wired the module itself.
   * Only the product's own entry point can say whether a person reaches it.
   *
   * A screen reached by clicking -- a dialog, a tab -- names the page carrying
   * it: reachability proves that page is served, not that the dialog opens.
   */
  page: z.string().trim().regex(/^\/\S*$/, "page must be an application path beginning with /").optional(),
  /**
   * Whether acting out this scenario changes something the system keeps. Asked
   * of every screen scenario, because the answer decides whether a read-back
   * scenario is owed and a scenario that never answers it owes nothing.
   *
   * Optional in the schema because a DoD frozen before this existed still has
   * to parse; the SHAPE exit gate requires it of anything written from now on.
   */
  mutates: z.boolean().optional(),
  /**
   * The scenario that proves this one's change outlived the page. Required of
   * a scenario that mutates.
   *
   * Without it a screen that writes is only ever judged in the moment it
   * writes, and a store that forgets everything between visits satisfies it:
   * R237511RC and R237511TR were each built on sample data that reseeded on
   * every page open, passed every round, and were accepted for screens that
   * could not keep a single edit. A save that does not survive a reload is the
   * one failure such a screen has, and it fails deterministically, so it
   * belongs in the definition of done rather than in a reviewer's eye.
   */
  persisted_by: scenarioId.optional(),
  visible: z.array(z.object({
    /** The ARIA role, as the snapshot names it: heading, link, button, list. */
    role: z.string().trim().min(1),
    /** Text a person reads. Matched as part of a longer label, so a back link
     * reading "<- return to the list" satisfies "return to the list". */
    text: z.string().trim().min(1),
  }).strict()).min(1).optional(),
}).strict();

const baseline = z.discriminatedUnion("type", [
  z.object({ type: z.literal("acceptance_test") }).strict(),
  z.object({ type: z.literal("bug_repro") }).strict(),
  z.object({ type: z.literal("exempt"), reason: z.string().trim().min(1) }).strict(),
]);

/**
 * Every criterion has a home: the scenarios whose tests prove it, or a named
 * code check that enforces it as a constraint. A criterion with neither is one
 * only a reviewer's eye can catch, which is how a card gets refused for
 * something no round was ever asked to build.
 */
const criterion = z.union([
  z.object({ text: z.string().trim().min(1), scenarios: z.array(scenarioId).min(1) }).strict(),
  z.object({ text: z.string().trim().min(1), constraint: z.string().trim().min(1) }).strict(),
]);

const dodSchema = z.object({
  story_id: storyId,
  design_summary: z.string().trim().min(1),
  scenarios: z.array(scenario).min(1),
  baseline,
  acceptance_criteria: z.array(criterion).min(1),
  /** What the screen reviewer may not refuse the card for. May be empty, must be decided. */
  out_of_scope: z.array(z.string().trim().min(1)),
  /** Existing pages, routes or services this Story assumes work; their failure is not this card's. */
  relies_on: z.array(z.string().trim().min(1)),
  predicted_footprint: z.array(z.string().trim().min(1)),
  depends_on: z.array(storyId),
}).strict().superRefine((value, context) => {
  const seen = new Set<string>();
  for (const entry of value.scenarios) {
    if (!entry.id.startsWith(`${value.story_id}-`)) {
      context.addIssue({
        code: "custom",
        path: ["scenarios", entry.id],
        message: `scenario id must be namespaced by ${value.story_id}`,
      });
    }
    if (seen.has(entry.id)) {
      context.addIssue({
        code: "custom",
        path: ["scenarios", entry.id],
        message: `duplicate scenario id: ${entry.id}`,
      });
    }
    seen.add(entry.id);
    // A scenario somebody will look at has to say what they will see. "A
    // concise summary" was read one way by CODE and another by the reviewer;
    // a literal example is read one way.
    if (hasScreen(entry)) {
      const kinds = new Set((entry.examples ?? []).map((item) => item.kind));
      if (!kinds.has("shows") || !kinds.has("excludes")) {
        context.addIssue({
          code: "custom",
          path: ["scenarios", entry.id, "examples"],
          message: `${entry.id} is judged on a screen and needs at least one "shows" and one "excludes" example`,
        });
      }
      if (!entry.source) {
        context.addIssue({
          code: "custom",
          path: ["scenarios", entry.id, "source"],
          message: `${entry.id} is judged on a screen and needs a source for what it shows`,
        });
      }
    }
  }
  for (const [index, item] of value.acceptance_criteria.entries()) {
    if (!("scenarios" in item)) continue;
    for (const id of item.scenarios) {
      if (!seen.has(id)) {
        context.addIssue({
          code: "custom",
          path: ["acceptance_criteria", index],
          message: `criterion "${item.text}" names an undeclared scenario ${id}`,
        });
      }
    }
  }
});

export type DefinitionOfDone = z.infer<typeof dodSchema>;
export type DoDScenario = DefinitionOfDone["scenarios"][number];
export type DoDCriterion = DefinitionOfDone["acceptance_criteria"][number];

/** Whether any of the scenario's layers is settled by looking at a screen. */
export function hasScreen(entry: Pick<DoDScenario, "layers">): boolean {
  return entry.layers.some((item) => LAYER_OWNER[item] === "verify");
}

/** The scenarios VERIFY has to reach in a browser; the rest are proved by tests alone. */
export function screenScenarios(dod: DefinitionOfDone): DoDScenario[] {
  return dod.scenarios.filter((entry) => hasScreen(entry));
}

/** The sample data a screen scenario asks for, or undefined when it declares none. */
export function seedOf(entry: Pick<DoDScenario, "seed">): string | undefined {
  return entry.seed;
}

/** The sentences a reviewer may refuse this scenario for, verbatim. */
export function refusableStatements(entry: DoDScenario): string[] {
  return [entry.then, ...(entry.examples ?? []).map((item) => item.text)];
}

/** The line a person reads for this scenario, and its place in the list. */
export function scenarioTitle(entry: Pick<DoDScenario, "title">, seq: number): string {
  // A DoD written before titles existed is never machine-translated into one:
  // a made-up name reads like the author's and is nobody's.
  return entry.title ?? `场景 ${seq}`;
}

export interface DoDLanguageFinding {
  /** Which sentence, named the way the author will look for it. */
  where: string;
  what: string;
  excerpt: string;
}

/**
 * The DoD is the card's contract, and a person judges the delivery by reading
 * it. Every sentence in it that reaches a page is held to Chinese business
 * language here: the prompt asks, this refuses, and the two together are why
 * the page does not need a translation step (design 01 section 2.3).
 */
export function lintDoDLanguage(dod: DefinitionOfDone): DoDLanguageFinding[] {
  const findings: DoDLanguageFinding[] = [];
  const check = (where: string, text: string): void => {
    for (const finding of lintHumanSentence(where, text)) {
      findings.push({ where, what: finding.what, excerpt: finding.excerpt });
    }
  };
  check("design_summary", dod.design_summary);
  for (const entry of dod.scenarios) {
    if (!entry.title) {
      findings.push({ where: `scenarios.${entry.id}.title`, what: "is missing", excerpt: "" });
    } else {
      check(`scenarios.${entry.id}.title`, entry.title);
    }
    check(`scenarios.${entry.id}.given`, entry.given);
    check(`scenarios.${entry.id}.when`, entry.when);
    check(`scenarios.${entry.id}.then`, entry.then);
  }
  for (const [index, item] of dod.acceptance_criteria.entries()) {
    check(`acceptance_criteria[${index}]`, item.text);
  }
  return findings;
}

/** What SHAPE is told to fix, in the language the prompt is written in. */
export function renderDoDLanguageFindings(findings: readonly DoDLanguageFinding[]): string {
  return [
    "The DoD is read by the person who ordered this card, so every sentence in it must be Chinese business language: what a user does and what they then see, with no implementation words, file paths or English prose. Rewrite these and return the whole DoD again:",
    ...findings.map((finding) => `- ${finding.where} ${finding.what}${finding.excerpt ? `: ${finding.excerpt}` : ""}`),
  ].join("\n");
}

/**
 * Screen scenarios that said nothing about what a person would see.
 *
 * The structural layer is the only interface criterion that can refuse and
 * still converge (08 section 6), and it has nothing to work from unless SHAPE
 * writes `visible[]` here. Asked at the DoD exit rather than at VERIFY because
 * by then the scenario is already being judged, and the basis of a judgement
 * cannot be written by the round it judges.
 */
export function scenariosMissingVisible(definition: DefinitionOfDone): string[] {
  return definition.scenarios
    .filter((entry) => hasScreen(entry) && entry.visible === undefined)
    .map((entry) => entry.id);
}

/**
 * Screen scenarios that did not say where their screen is served.
 *
 * Asked here for the same reason as `visible[]`: the basis of a judgement
 * cannot be written by the round it judges. Without it the only witness that
 * a screen exists is a browser, and a browser pointed at a server the verifier
 * assembled itself sees screens the product never mounts.
 */
export function scenariosMissingPage(definition: DefinitionOfDone): string[] {
  return definition.scenarios
    .filter((entry) => hasScreen(entry) && entry.page === undefined)
    .map((entry) => entry.id);
}

/**
 * What a screen scenario still owes about the change it makes.
 *
 * Three questions, one pass, because they are one sentence to whoever writes
 * the DoD: does this screen change anything kept, which scenario proves the
 * change survived, and does that scenario actually revisit the same page.
 */
export interface PersistenceGap {
  scenarioId: string;
  what: "unanswered" | "no_read_back" | "read_back_missing" | "read_back_elsewhere" | "read_back_not_in_browser";
  detail?: string;
}

/**
 * Screen scenarios that say nothing about whether their change outlives the
 * page, and the read-backs they name that could not prove it.
 *
 * A read-back has to be settled in a browser and has to open the same page:
 * one proved by a unit test proves the function was called, and one on another
 * page proves something else entirely. Both would leave the only failure such
 * a screen has -- the edit is gone when you come back -- outside the criteria.
 */
export function persistenceGaps(definition: DefinitionOfDone): PersistenceGap[] {
  const byId = new Map(definition.scenarios.map((entry) => [entry.id, entry]));
  const gaps: PersistenceGap[] = [];
  for (const entry of screenScenarios(definition)) {
    if (entry.mutates === undefined) {
      gaps.push({ scenarioId: entry.id, what: "unanswered" });
      continue;
    }
    if (!entry.mutates) continue;
    const readBackId = entry.persisted_by;
    if (readBackId === undefined) {
      gaps.push({ scenarioId: entry.id, what: "no_read_back" });
      continue;
    }
    const readBack = byId.get(readBackId);
    if (!readBack) {
      gaps.push({ scenarioId: entry.id, what: "read_back_missing", detail: readBackId });
      continue;
    }
    if (!hasScreen(readBack)) {
      gaps.push({ scenarioId: entry.id, what: "read_back_not_in_browser", detail: readBackId });
      continue;
    }
    if (entry.page !== undefined && readBack.page !== undefined && readBack.page !== entry.page) {
      gaps.push({ scenarioId: entry.id, what: "read_back_elsewhere", detail: `${readBackId} -> ${readBack.page}` });
    }
  }
  return gaps;
}

export function renderPersistenceGaps(gaps: readonly PersistenceGap[]): string {
  const lines: Record<PersistenceGap["what"], string> = {
    unanswered: "要回答这条会不会改变系统里存着的东西（`mutates: true` 或 `false`）",
    no_read_back: "这条会改东西，所以要再写一条「重新打开这一页，改动还在」的 scenario，并用 `persisted_by` 指向它",
    read_back_missing: "`persisted_by` 指的 scenario 不存在",
    read_back_elsewhere: "`persisted_by` 指的 scenario 打开的是另一页，证不了这一页的改动还在",
    read_back_not_in_browser: "`persisted_by` 指的 scenario 不在浏览器里判定，证不了重新打开之后的事",
  };
  return [
    "改东西的页面要有「改完之后还在」这条验收：只在改的那一刻判定的页面，换成一个每次打开都重置的假存储也照样通过，而人打开它会发现自己刚存的东西没了。",
    ...gaps.map((gap) => `- ${gap.scenarioId} ${lines[gap.what]}${gap.detail ? `：${gap.detail}` : ""}`),
  ].join("\n");
}

export function renderMissingPage(ids: readonly string[]): string {
  return [
    "这些 scenario 要打开页面才能判定，所以每条都要写 `page`：这一页在应用里的路径，例如 `/operator/costs`。",
    "写完代码那一步系统会把应用起起来访问它——组件写好了却没在入口挂上，单测照样全绿，只有这一步看得出来。",
    "靠点击才出现的弹窗或子页签，写承载它的那一页。",
    ...ids.map((id) => `- ${id}`),
  ].join("\n");
}

/**
 * What the structural layer compares each screen against.
 *
 * Only the scenarios a browser settles, even though `visible[]` may outlive a
 * screen layer: a scenario moved to the code layers because its given could
 * not be built in a browser still carries what it once promised to show, and
 * asking a lane that never ran for a page structure record refuses it every
 * round for something no round could have produced.
 */
export function structuralRequirements(definition: DefinitionOfDone): Map<string, DoDScenario["visible"] & {}> {
  return new Map(
    screenScenarios(definition)
      .filter((entry) => entry.visible !== undefined)
      .map((entry) => [entry.id, entry.visible!]),
  );
}

/** What the session is asked to add, in the words it wrote the DoD in. */
/**
 * What a person is told when a card has screens and its repository has no
 * interface contract for them.
 *
 * Addressed to a person rather than to the phase: no round of SHAPE can put a
 * token table in the tree, and which one the repository gets is decided once
 * for every card, at the requirement's solution gate (design 08 section 1).
 */
export function renderMissingInterfaceContract(scenarioIds: readonly string[]): string {
  const ids = [...scenarioIds].toSorted().join("、");
  return [
    `这张卡有要看的界面（${ids}），但目标分支上还没有界面契约。`,
    "没有契约的话，这张卡只能自己发明一套样子，下一张卡会发明另一套。",
    "先在需求的方案关确认一份界面契约（token 表、组件清单、可运行的页面原型），再把这张卡放回去。",
  ].join("\n");
}

/**
 * Footprint entries that name a place the repository has no room for.
 *
 * The footprint is a prediction, so an entry may name something the card is
 * about to create: `console-ui/src/pages/records` is a fair thing to write
 * before that directory exists. What is not fair is an entry with no existing
 * ancestor above the repository root, because a card almost never starts a new
 * top-level directory and a near-miss on an existing one costs the scheduler
 * everything it has. `S-R237511MB-02` declared `console/` and worked in
 * `src/console`: the scheduler widens an entry to the directory it names, read
 * `console` as intersecting nothing, and planned the card beside one that
 * shares `src/console` with it -- which is the merge conflict the footprint
 * exists to prevent, arranged by the mechanism meant to prevent it.
 *
 * `exists` is asked rather than the filesystem, so the rule is testable
 * without a tree and identical on every host.
 */
export function footprintWithoutGround(
  definition: DefinitionOfDone,
  exists: (path: string) => boolean,
): string[] {
  const grounded = (raw: string): boolean => {
    let path = directoryOf(raw);
    if (exists(path)) return true;
    for (;;) {
      const cut = path.lastIndexOf("/");
      // The root is not an ancestor that grounds anything: every entry has it.
      if (cut <= 0) return false;
      path = path.slice(0, cut);
      if (exists(path)) return true;
    }
  };
  return definition.predicted_footprint.filter((entry) => !grounded(entry));
}

/** What the session is asked to correct, with the tree in front of it. */
export function renderFootprintWithoutGround(entries: readonly string[]): string {
  return [
    "`predicted_footprint` 里这几条在仓库里找不到落点：它们本身不存在，往上也没有任何一层存在的目录。",
    "调度器按这些路径决定哪些卡不能同时动，一条落不到地的路径等于告诉它这张卡谁也不碰，",
    "于是另一张真正改同一处的卡会被安排在旁边跑，合流时撞在一起。",
    "请对着树把它们改成这张卡真正会动的路径（新建的目录可以写，只要它的上层已经存在）。",
    ...entries.map((entry) => `- ${entry}`),
  ].join("\n");
}

export function renderMissingVisible(ids: readonly string[]): string {
  return [
    "这些 scenario 要靠打开页面才能判定，所以每条都要写 `visible`：一个人验收通过时，在那一页上必须看见哪些东西。",
    "每项是一个角色加一段文字（例如 `- role: heading` / `text: 运行控制台`），文字取页面上真会出现的那句话，",
    "不要写实现细节或元素选择器。系统之后会按这份清单逐条核对页面，所以写不出来的就不要写。",
    ...ids.map((id) => `- ${id}`),
  ].join("\n");
}

export class DoDValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DoDValidationError";
  }
}

export function parseDoD(source: string): DefinitionOfDone {
  let document: unknown;
  try {
    document = parse(source) as unknown;
  } catch (cause) {
    throw new DoDValidationError(`DoD YAML is invalid: ${(cause as Error).message}`, { cause });
  }
  const result = dodSchema.safeParse(document);
  if (!result.success) {
    const message = result.error.issues.map((issue) => issue.message).join("; ");
    throw new DoDValidationError(`DoD contract is invalid: ${message}`, { cause: result.error });
  }
  return result.data;
}

export interface TestSource {
  path: string;
  content: string;
}

export interface ScenarioCoverage {
  pass: boolean;
  missing: string[];
  unexpected: string[];
}

export function scanScenarioCoverage(dod: DefinitionOfDone, sources: readonly TestSource[]): ScenarioCoverage {
  const declared = new Set(dod.scenarios.map((entry) => entry.id));
  const marked = new Set<string>();
  const marker = /@scenario\s+(S-[A-Z0-9]+-\d{2}-[a-z0-9]+)\b/g;
  for (const source of sources.toSorted((a, b) => a.path.localeCompare(b.path, "en"))) {
    for (const match of source.content.matchAll(marker)) marked.add(match[1]!);
  }
  const missing = [...declared].filter((id) => !marked.has(id)).toSorted();
  const unexpected = [...marked].filter((id) => !declared.has(id)).toSorted();
  return { pass: missing.length === 0 && unexpected.length === 0, missing, unexpected };
}
