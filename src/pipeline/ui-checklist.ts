/**
 * The usability checklist a prototype is measured against (design 08 section
 * 3.2), and the rules that keep its findings comparable between rounds.
 *
 * Every item has a number, and a finding that does not cite one is dropped.
 * That is the whole reason the checklist is a numbered list rather than prose:
 * the convergence rule needs a failing set that can repeat, and "the empty
 * state could say more" written freshly each round never repeats, so the card
 * would spend its budget without the criterion ever firing.
 *
 * Four items are decided in code and may refuse. Three are decided by the
 * judge, one question per request, and each of those has "nothing seen" as its
 * floor -- a judge that is off, slow or unsure leaves the prototype alone.
 */

/** Judged in code from the page's own source and its accessibility audit. */
export const MECHANICAL_ITEMS = ["M1", "M2", "M3", "M4"] as const;
/** Judged by the judge, one request each. */
export const SEMANTIC_ITEMS = ["S1", "S2", "S3"] as const;

export type MechanicalItem = (typeof MECHANICAL_ITEMS)[number];
export type SemanticItem = (typeof SEMANTIC_ITEMS)[number];
export type ChecklistItem = MechanicalItem | SemanticItem;

const ITEMS = new Set<string>([...MECHANICAL_ITEMS, ...SEMANTIC_ITEMS]);

/** What each item is about, in the words the finding is written in. The text
 * itself lives in `prompts/pm/ui-checklist.md`; this is the one line a finding
 * carries so a person reading it does not have to open the checklist. */
export const ITEM_TITLES: Readonly<Record<ChecklistItem, string>> = {
  M1: "动效尊重 prefers-reduced-motion",
  M2: "触控目标不小于 44px",
  M3: "焦点可见",
  M4: "键盘可操作",
  S1: "状态文案说清发生了什么、接下来做什么",
  S2: "校验提示可操作",
  S3: "标签描述它旁边那个控件",
};

export function isChecklistItem(id: string): id is ChecklistItem {
  return ITEMS.has(id);
}

export interface ChecklistFinding {
  item: ChecklistItem;
  /** Which page it is on, relative to the contract root. */
  file: string;
  /** What is wrong on that page, for the session that has to fix it. */
  what: string;
}

/**
 * Keeps the findings that cite an item this checklist has.
 *
 * A finding citing an item nobody wrote is dropped rather than kept under a new
 * key: an item invented this round cannot be compared with last round's, which
 * is the same failure as having no number at all.
 */
export function keepCitedFindings(
  candidates: readonly { item?: unknown; file?: unknown; what?: unknown }[],
): ChecklistFinding[] {
  const kept: ChecklistFinding[] = [];
  for (const candidate of candidates) {
    const item = typeof candidate.item === "string" ? candidate.item.trim().toUpperCase() : "";
    const file = typeof candidate.file === "string" ? candidate.file.trim() : "";
    const what = typeof candidate.what === "string" ? candidate.what.trim() : "";
    if (!isChecklistItem(item) || file === "" || what === "") continue;
    kept.push({ item, file, what });
  }
  return kept.toSorted((left, right) =>
    left.file === right.file
      ? (left.item < right.item ? -1 : left.item > right.item ? 1 : 0)
      : (left.file < right.file ? -1 : 1)
  );
}

/** How a checklist finding reads where the other exit findings read. */
export function describeChecklistFindings(findings: readonly ChecklistFinding[]): string[] {
  return findings.map((finding) =>
    `${finding.file} 没过可用性清单 ${finding.item}（${ITEM_TITLES[finding.item]}）：${finding.what}`
  );
}

/** One key per page and item, so the same page's M3 is the same finding twice
 * running and two pages' M3 are not. */
function key(finding: ChecklistFinding): string {
  return JSON.stringify([finding.file, finding.item]);
}

/**
 * Items that were a finding in exactly one of two consecutive rounds.
 *
 * It is a friction signal, not a gate. An item that flips while the page is
 * being fixed is ordinary; an item that flips round after round is the judge
 * disagreeing with itself, and that is a thing to find out from data rather
 * than by arguing about a threshold.
 */
export function flippedItems(
  previous: readonly ChecklistFinding[],
  current: readonly ChecklistFinding[],
): ChecklistItem[] {
  const before = new Set(previous.map(key));
  const after = new Set(current.map(key));
  const flipped = new Set<ChecklistItem>();
  for (const entry of [...before, ...after]) {
    if (before.has(entry) === after.has(entry)) continue;
    flipped.add((JSON.parse(entry) as [string, ChecklistItem])[1]);
  }
  return [...flipped].toSorted();
}

const COMMENT = /<!--[\s\S]*?-->/g;
const SCRIPT = /<script\b[^>]*>[\s\S]*?<\/script>/gi;

/**
 * The page as the judge sees it: no comments, no scripts.
 *
 * Both are removed for the same reason the prototype prompt forbids writing
 * reasons into the product. A comment saying "this page meets every usability
 * requirement" is the drawing grading itself inside the judge's input, and a
 * script is behaviour the judge cannot run and would only read as prose.
 */
export function stripForJudge(html: string): string {
  return html.replaceAll(COMMENT, "").replaceAll(SCRIPT, "").trim();
}
