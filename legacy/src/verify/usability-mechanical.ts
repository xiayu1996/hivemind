import type { AccessibilityViolation } from "./accessibility-audit.js";
import type { ChecklistFinding } from "../pipeline/ui-checklist.js";

/**
 * The four usability items a machine can decide (design 08 section 3.2, items
 * M1 to M4).
 *
 * They are judged from the page's own source and from what axe-core already
 * reported on it, because both are finite and enumerable: the same page gives
 * the same answer every time, so a failing set shrinks or repeats and the
 * convergence rule can fire. Anything that needed an opinion is a semantic
 * item and is not decided here.
 *
 * The source is read rather than the rendered page for M1 and M3 on purpose. A
 * reduced-motion block and a focus style are things a stylesheet either
 * declares or does not; asking the browser would mean simulating a preference
 * and a focus ring, which is a great deal of machinery for a question the text
 * answers exactly.
 */

/** axe rules that are this checklist's items, so one audit answers both. */
const AXE_ITEMS: Readonly<Record<string, "M2" | "M4">> = {
  "target-size": "M2",
  "scrollable-region-focusable": "M4",
  "nested-interactive": "M4",
};

const MOTION = /(^|[;{\s])(transition|animation)(-[a-z-]+)?\s*:/i;
const REDUCED_MOTION = /@media[^{]*prefers-reduced-motion\s*:\s*reduce/i;
const OUTLINE_OFF = /outline\s*:\s*(none|0)\b/i;
/** A focus rule that draws something, rather than the rule that took the
 * system ring away: `outline: none` is what M3 is about, so it cannot also be
 * what satisfies M3. */
const FOCUS_VISIBLE = /:focus(-visible)?\b[^{]*\{[^}]*(outline|box-shadow|border)\s*:(?!\s*(?:none|0)\s*[;}])[^;}]+/i;
/** A click handler on something the tab key never reaches. */
const HANDLER_ON_PLAIN_NODE = /<(div|span|li|td)\b(?![^>]*\btabindex=)[^>]*\bon(click|keydown|keyup)\s*=/i;
/** A declared box smaller than the smallest thing a finger reliably hits. */
const SMALL_BOX = /(?:min-)?(?:width|height)\s*:\s*(\d+(?:\.\d+)?)px/gi;
const MIN_TARGET_PX = 44;
const INTERACTIVE_SELECTOR = /(^|[,\s>+~])(button|a|input|select|textarea|\[role=["']?(button|link|checkbox|radio|switch|tab)["']?\])\b/i;

export interface MechanicalPage {
  /** Path relative to the contract root. */
  file: string;
  /** The page as written, comments and scripts included: M4 is about what the
   * markup does, and a handler inside a script tag still needs a node to sit on. */
  html: string;
  /** What axe-core reported on this page, if it ran. */
  violations?: readonly AccessibilityViolation[];
}

/**
 * Every mechanical item this page fails, in a stable order.
 *
 * Nothing here is reported unless the page gives a reason to look: a page with
 * no animation cannot fail the reduced-motion item, and a page that never
 * hides an outline cannot fail the focus item. An item that fires on pages
 * that do not do the thing it is about would be noise on every page forever.
 */
export function mechanicalFindings(page: MechanicalPage): ChecklistFinding[] {
  const findings: ChecklistFinding[] = [];
  const styles = styleBlocks(page.html);

  if (MOTION.test(styles) && !REDUCED_MOTION.test(styles)) {
    findings.push({
      item: "M1",
      file: page.file,
      what: "页面里有 transition 或 animation，但没有 @media (prefers-reduced-motion: reduce) 把它们关掉",
    });
  }

  for (const target of smallInteractiveBoxes(styles)) {
    findings.push({
      item: "M2",
      file: page.file,
      what: `${target.selector} 写死了 ${target.declarations.join("、")}，小于 ${MIN_TARGET_PX}px 的可点区域`,
    });
  }

  if (OUTLINE_OFF.test(styles) && !FOCUS_VISIBLE.test(styles)) {
    findings.push({
      item: "M3",
      file: page.file,
      what: "去掉了系统焦点环（outline: none），又没在 :focus-visible 里自己画一个",
    });
  }

  if (HANDLER_ON_PLAIN_NODE.test(page.html)) {
    findings.push({
      item: "M4",
      file: page.file,
      what: "点击处理器挂在不可聚焦的节点上，键盘走不到",
    });
  }

  for (const violation of page.violations ?? []) {
    const item = AXE_ITEMS[violation.id];
    if (!item) continue;
    findings.push({
      item,
      file: page.file,
      what: `${violation.help}（${violation.id}）：${violation.nodes.join("、")}`,
    });
  }

  return findings.toSorted((left, right) => (left.item < right.item ? -1 : left.item > right.item ? 1 : 0));
}

/** Only what is inside `<style>`: an inline `transition` on one node is not the
 * page declaring motion, and matching the whole document would read the copy. */
function styleBlocks(html: string): string {
  return [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((match) => match[1] ?? "").join("\n");
}

/**
 * Rules that name something interactive and give it a box below the minimum,
 * one entry per rule rather than per declaration: a 20 by 20 icon is one thing
 * to fix, and reporting its width and its height separately would make the
 * failing set grow with the number of ways the same box was written.
 */
function smallInteractiveBoxes(styles: string): Array<{ selector: string; declarations: string[] }> {
  const found: Array<{ selector: string; declarations: string[] }> = [];
  for (const match of styles.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const selector = (match[1] ?? "").trim().replaceAll(/\s+/g, " ");
    const body = match[2] ?? "";
    if (selector === "" || selector.startsWith("@") || !INTERACTIVE_SELECTOR.test(selector)) continue;
    const declarations: string[] = [];
    for (const size of body.matchAll(SMALL_BOX)) {
      const pixels = Number(size[1]);
      if (Number.isFinite(pixels) && pixels < MIN_TARGET_PX) declarations.push(size[0]!.trim());
    }
    if (declarations.length > 0) found.push({ selector, declarations });
  }
  return found;
}
