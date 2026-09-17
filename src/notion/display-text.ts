import type { EpicState, StoryState, StoryStopReason } from "../orchestrator/state-machine.js";
import type { RequirementState } from "../orchestrator/requirement-machine.js";
import type { StorySection } from "./blocks/story-page.js";
import text from "./display-text.json" with { type: "json" };

/**
 * Every word a person reads on a Notion page comes from here. The tables are
 * declared as complete records over the enums they cover, so a new state or
 * stop reason is a compile error at this file rather than an English word
 * leaking onto a page months later.
 */
const storyStates: Record<StoryState, string> = text.states.story;
const epicStates: Record<EpicState, string> = text.states.epic;
const requirementStates: Record<RequirementState, string> = text.states.requirement;
const stopReasons: Record<StoryStopReason, string> = text.stopReasons;

/** The story page carries one section the pipeline has no state for. */
export type PageSection = StorySection | "technical";

interface SectionName { title: string; aliases: readonly string[] }

const sectionTitles: Record<PageSection, SectionName> = text.sections.story;

/** The Epic page's own sections. It shares no heading with the Story page:
 * what an Epic owns is the batch, not the work inside it. */
export type EpicPageSection = "goal" | "plan" | "dependencies" | "technical";

const epicSectionTitles: Record<EpicPageSection, SectionName> = text.sections.epic;

/** The requirement page's sections. The original request is the page's own
 * preface, not a section: the person wrote it there. */
export type RequirementPageSection = "clarify" | "prd" | "delivery";

const requirementSectionTitles: Record<RequirementPageSection, SectionName> = text.sections.requirement;

export function requirementSectionTitle(section: RequirementPageSection): string {
  return requirementSectionTitles[section].title;
}

export function requirementSectionForTitle(heading: string): RequirementPageSection | undefined {
  const wanted = heading.trim();
  for (const [section, names] of Object.entries(requirementSectionTitles) as Array<[RequirementPageSection, SectionName]>) {
    if (names.title === wanted || names.aliases.includes(wanted)) return section;
  }
  return undefined;
}

export function epicSectionTitle(section: EpicPageSection): string {
  return epicSectionTitles[section].title;
}

/** Recognises an Epic heading whichever version of the page wrote it. */
export function epicSectionForTitle(heading: string): EpicPageSection | undefined {
  const wanted = heading.trim();
  for (const [section, names] of Object.entries(epicSectionTitles) as Array<[EpicPageSection, SectionName]>) {
    if (names.title === wanted || names.aliases.includes(wanted)) return section;
  }
  return undefined;
}

export const DISPLAY_TIME_ZONE = text.timeZone;
export const ICONS = text.icons;

export function storyStateWord(state: StoryState | string): string {
  return storyStates[state as StoryState] ?? String(state);
}

export function epicStateWord(state: EpicState | string): string {
  return epicStates[state as EpicState] ?? String(state);
}

export function requirementStateWord(state: RequirementState | string): string {
  return requirementStates[state as RequirementState] ?? String(state);
}

export function stopReasonWord(reason: StoryStopReason | string): string {
  return stopReasons[reason as StoryStopReason] ?? String(reason);
}

export function verdictWord(verdict: string): string {
  return (text.verdicts as Record<string, string>)[verdict] ?? verdict;
}

export function specStatusWord(status: string): string {
  return (text.specStatuses as Record<string, string>)[status] ?? status;
}

/** How a scenario says it will be proven, in the words a person uses. */
export function layerWords(layers: readonly string[]): string[] {
  return layers.map((layer) => (text.layers as Record<string, string>)[layer] ?? layer);
}

export function sectionTitle(section: PageSection): string {
  return sectionTitles[section].title;
}

/** Recognises a heading a page already carries, whatever version wrote it, so
 * a rename is an edit to that heading rather than a new anchor. */
export function sectionForTitle(heading: string): PageSection | undefined {
  const wanted = heading.trim();
  for (const [section, names] of Object.entries(sectionTitles) as Array<[PageSection, typeof sectionTitles[PageSection]]>) {
    if (names.title === wanted || names.aliases.includes(wanted)) return section;
  }
  return undefined;
}

/**
 * The emoji a card wears on its page and in every list Notion shows it in.
 * It answers one question before the card is opened: does this want me?
 */
export function storyIcon(state: StoryState | string): string {
  if (state === "NEEDS_INPUT") return ICONS.waiting;
  if (state === "HUMAN_PARKED") return ICONS.parked;
  if (state === "DELIVERED") return ICONS.done;
  if (state === "FAILED") return ICONS.failed;
  return ICONS.running;
}

export interface WaitingText {
  icon: string;
  color: string;
  action: string;
}

/**
 * What the page says when it is a person's turn, and nothing at all otherwise:
 * state, waiting and cost are board columns already, and a page that repeats
 * them costs attention without adding anything (design 01 section 2.3).
 */
/**
 * What the callout says when nothing is waiting. The block itself stays: a
 * Notion block can only be appended after another one, so a callout archived
 * on a quiet day comes back at the bottom of the page rather than at the top.
 */
export function quietText(): WaitingText {
  return text.quiet;
}

export function waitingText(level: "story" | "epic" | "requirement", situation: string): WaitingText | undefined {
  const table = text.waiting[level] as Record<string, WaitingText | undefined>;
  return table[situation];
}

const timeFormat = new Intl.DateTimeFormat("zh-CN", {
  timeZone: DISPLAY_TIME_ZONE,
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** "09-15 17:28": the page reads in the reader's own day, and the format is
 * fixed so the same record renders the same bytes on every machine. */
export function displayTime(epochMs: number): string {
  const parts = new Map(timeFormat.formatToParts(new Date(epochMs)).map((part) => [part.type, part.value]));
  return `${parts.get("month")}-${parts.get("day")} ${parts.get("hour")}:${parts.get("minute")}`;
}
