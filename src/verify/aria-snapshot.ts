/**
 * The accessibility tree a browser round left behind, read as a judgement
 * rather than as evidence.
 *
 * The snapshot is already captured for every screen scenario (`page-*.yml`
 * beside `page-*.png`). Until now nothing read it: a round whose every page was
 * `{"message":"Route GET:/tasks/... not found"}` still had four screenshots and
 * four confident verdicts. What was missing is a basis to compare it against,
 * which is what `visible[]` on a scenario supplies (design 08 section 6).
 *
 * The check is deterministic code, not a model reading a screen: it is the
 * third layer of the three that stop a fabricated pass (prompt, tool surface,
 * verdict validation), and a model asked whether its own page is right is the
 * weakest possible reader of it.
 *
 * Pixel comparison is deliberately absent (08 section 6): it is a criterion of
 * unbounded precision, so the failing set never repeats and the convergence
 * rule never fires. A role and a string are finite and enumerable.
 */

/** One node of the accessibility tree, flattened. Nesting carries no meaning
 * for this check: a required role and text is on the page or it is not. */
export interface AriaNode {
  role: string;
  /** The accessible name, from the quoted part of the line. */
  name: string;
  /** The text content, from after the colon. */
  text: string;
}

/** What a scenario says a person must be able to see once it passes. */
export interface VisibleRequirement {
  role: string;
  text: string;
}

/**
 * A snapshot line, which Playwright writes as one of
 *   `- role "name" [ref=..] [level=1]:`
 *   `- role [ref=..]: text`
 *   `- role "name" [ref=..]`
 * Property lines (`- /url: /tasks`) carry no role and are skipped by the role
 * group failing to match a leading slash.
 */
const NODE_LINE =
  /^-\s+(?<role>[A-Za-z][\w-]*)(?:\s+"(?<name>(?:[^"\\]|\\.)*)")?(?<attributes>(?:\s+\[[^\]]*\])*)\s*(?::\s*(?<text>.*))?$/;

/** Collapses the whitespace a renderer may add or drop, so a requirement is
 * not missed over a line break the snapshot happened to take. */
function normalize(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim().toLocaleLowerCase();
}

/** Undoes the quoting Playwright applies to a text node that contains
 * punctuation it would otherwise have to escape in YAML. */
function unquote(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"') || trimmed.length < 2) return trimmed;
  try {
    return String(JSON.parse(trimmed));
  } catch {
    // Not valid JSON despite the quotes: a snapshot that ends mid-line, which
    // is a truncated capture rather than a node with a different shape. The
    // raw text still matches on containment, so the quotes are all that go.
    return trimmed.slice(1, -1);
  }
}

/** Every node of the tree, in the order the snapshot wrote them. */
export function parseAriaSnapshot(snapshot: string): AriaNode[] {
  const nodes: AriaNode[] = [];
  for (const line of snapshot.split(/\r?\n/)) {
    const match = NODE_LINE.exec(line.trim());
    if (!match?.groups) continue;
    const { role, name, text } = match.groups;
    nodes.push({
      role: role!,
      name: name === undefined ? "" : unquote(`"${name}"`),
      text: text === undefined ? "" : unquote(text),
    });
  }
  return nodes;
}

/** Whether one node satisfies one requirement. The text may be part of a
 * longer label: a back link reading "← 返回任务列表" shows "返回任务列表". */
function satisfies(node: AriaNode, required: VisibleRequirement): boolean {
  if (normalize(node.role) !== normalize(required.role)) return false;
  const wanted = normalize(required.text);
  if (wanted === "") return true;
  return normalize(node.name).includes(wanted) || normalize(node.text).includes(wanted);
}

/**
 * The requirements this snapshot does not satisfy, in the order they were
 * declared. An empty result is the scenario's structural layer passing.
 */
export function missingFromSnapshot(
  snapshot: string,
  required: readonly VisibleRequirement[],
): VisibleRequirement[] {
  const nodes = parseAriaSnapshot(snapshot);
  return required.filter((item) => !nodes.some((node) => satisfies(node, item)));
}

/**
 * Why the scenario did not pass, for the person reading the card. Business
 * language, because this lands in `reason` (AGENTS.md: the reader decides what
 * the field may say); the file names belong in `detail`.
 */
export function describeMissing(missing: readonly VisibleRequirement[]): string {
  const items = missing.map((item) => `${item.role} “${item.text}”`).join("、");
  return `页面上没有出现这个场景声明要看见的内容：${items}`;
}
