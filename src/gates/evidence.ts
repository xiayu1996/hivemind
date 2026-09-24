/**
 * Whether the page state a passed scenario cites really shows what the
 * acceptance contract declared a person would see.
 *
 * This is deterministic code, not a model reading a screen. A round whose every
 * page answered `{"message":"Route GET:/tasks/... not found"}` still came back
 * with screenshots and four confident verdicts: the evaluator asked whether its
 * own page is right is the weakest possible reader of it.
 *
 * Only roles and text are compared, never pixels. A criterion of unbounded
 * precision lets every round find a new difference, so the failing set never
 * repeats and the convergence rule never fires; roles and strings are finite.
 */

import { stripVTControlCharacters } from "node:util";

/** One node of the accessibility tree, flattened: a required role and text is
 * on the page or it is not, so nesting carries no meaning here. */
export interface AriaNode {
  role: string;
  /** The accessible name, from the quoted part of the key. */
  name: string;
  /** The text content, from after the colon. */
  text: string;
}

/** Something a person must be able to see once the scenario passes. */
export interface VisibleExpectation {
  role?: string | undefined;
  text?: string | undefined;
}

export interface VisibleMatch {
  ok: boolean;
  /** The expectations not satisfied, in the order they were declared. */
  missing: readonly VisibleExpectation[];
}

/**
 * One item after its `- `, as Playwright writes it: `role "name" [attr] [attr=value]`,
 * optionally followed by `:` and a text. The name is JSON, or bare when it
 * starts and ends with a slash (`link /tasks/`). Property items (`/url: /tasks`)
 * fail the role, which must start with a letter.
 */
const NODE =
  /^(?<role>[A-Za-z][\w-]*)(?:\s+(?:"(?<name>(?:[^"\\]|\\.)*)"|(?<bareName>\/(?:.*?\/)?)))?(?:\s+\[[^\]]*\])*\s*(?::\s*(?<text>.*))?$/;

/**
 * A key YAML would misread (a name holding `: `, ` #`, a brace or a backtick)
 * is single-quoted whole, a quote inside doubled: `'button "Don''t: stop"': x`.
 */
const QUOTED_KEY = /^'(?<key>(?:[^']|'')*)'\s*(?::\s*(?<text>.*))?$/;

const ESCAPES: Readonly<Record<string, string>> = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

/**
 * Every node of the tree, in the order the snapshot wrote them.
 *
 * Read line by line rather than as a YAML document: each line is one node, so a
 * capture cut short keeps every node before the cut, and a value such as `~` or
 * `.inf` stays the text it is instead of becoming a null or a number. Lines that
 * are not nodes are skipped, so input that is no snapshot yields no nodes.
 */
export function parseAriaSnapshot(yaml: string): readonly AriaNode[] {
  const nodes: AriaNode[] = [];
  for (const line of yaml.split(/\r?\n/)) {
    const item = /^-\s+(?<item>.*)$/.exec(line.trim())?.groups?.item;
    if (item === undefined) continue;
    const quoted = QUOTED_KEY.exec(item)?.groups;
    const node = NODE.exec(quoted ? quoted.key!.replaceAll("''", "'") : item)?.groups;
    if (!node) continue;
    const text = quoted ? quoted.text : node.text;
    nodes.push({
      role: node.role!,
      name: node.name === undefined ? (node.bareName ?? "") : unquoteName(node.name),
      text: text === undefined ? "" : unquoteText(text),
    });
  }
  return nodes;
}

/**
 * Every expectation against the one snapshot. A role must equal the node's,
 * ignoring case; a text must be part of the node's name or of its text, so a
 * back link reading "<- back to the list" shows "back to the list". An
 * expectation without a role is met by any node, one without a text by any
 * node of its role, and one with neither is missing: it asks for nothing, so
 * it cannot be what proves a scenario.
 */
export function matchVisible(snapshot: string, expected: readonly VisibleExpectation[]): VisibleMatch {
  const nodes = parseAriaSnapshot(snapshot).map((node) => ({
    role: normalize(node.role),
    name: normalize(node.name),
    text: normalize(node.text),
  }));
  const missing = expected.filter((item) => {
    const role = normalize(item.role ?? "");
    const text = normalize(item.text ?? "");
    if (role === "" && text === "") return true;
    return !nodes.some((node) =>
      (role === "" || node.role === role) && (text === "" || node.name.includes(text) || node.text.includes(text)));
  });
  return { ok: missing.length === 0, missing };
}

/**
 * Whether one of several snapshots shows every expectation. Never their union:
 * a scenario that found one expectation on each of three pages has not seen
 * them together, and together is what a person sees. When none does, the
 * snapshot missing the fewest is reported (the first on a tie), so the gap
 * named is the smallest real one rather than whichever was tried first. With
 * no snapshot every expectation is missing; whether that is the page's fault or
 * the evidence's is for the caller to say.
 */
export function matchAnySnapshot(snapshots: readonly string[], expected: readonly VisibleExpectation[]): VisibleMatch {
  let best: VisibleMatch | undefined;
  for (const snapshot of snapshots) {
    const match = matchVisible(snapshot, expected);
    if (match.ok) return match;
    if (!best || match.missing.length < best.missing.length) best = match;
  }
  return best ?? matchVisible("", expected);
}

/**
 * The same check for a command-line surface, which has no tree: every expected
 * text must be part of the captured output. Terminal control sequences go
 * first, since a colored `3 passed` arrives as `\x1b[32m3\x1b[39m passed`. A
 * role means nothing in a terminal and is ignored; an expectation without a
 * text is missing, because nothing in the output can confirm it.
 */
export function matchOutput(output: string, expected: readonly VisibleExpectation[]): VisibleMatch {
  const haystack = normalize(stripVTControlCharacters(output));
  const missing = expected.filter((item) => {
    const text = normalize(item.text ?? "");
    return text === "" || !haystack.includes(text);
  });
  return { ok: missing.length === 0, missing };
}

/**
 * Collapses the whitespace a renderer may add or drop and folds case, so a
 * requirement is not missed over a line break the page happened to take. Not
 * `toLocaleLowerCase`: the verdict must not depend on the machine's locale.
 */
function normalize(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim().toLowerCase();
}

/** A name is JSON, as `JSON.stringify` wrote it into the key. */
function unquoteName(name: string): string {
  try {
    return String(JSON.parse(`"${name}"`));
  } catch {
    // Only a writer other than Playwright produces an escape JSON rejects;
    // the raw characters still match on containment.
    return name;
  }
}

/**
 * A text Playwright had to quote is a YAML double-quoted scalar: JSON's escapes
 * plus `\xNN` for control characters, which JSON.parse rejects. A value that
 * opens a quote it never closes is a capture cut mid-line and stays as written;
 * its raw text still matches on containment.
 */
function unquoteText(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2 || !trimmed.startsWith('"') || !trimmed.endsWith('"')) return trimmed;
  return trimmed.slice(1, -1).replaceAll(
    /\\(?:x([0-9A-Fa-f]{2})|u([0-9A-Fa-f]{4})|(.))/g,
    (_escape, byte: string | undefined, unit: string | undefined, char: string | undefined) => {
      const hex = byte ?? unit;
      if (hex !== undefined) return String.fromCharCode(Number.parseInt(hex, 16));
      return ESCAPES[char!] ?? char!;
    },
  );
}
