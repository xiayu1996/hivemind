import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The interface contract a requirement with screens carries in its repository.
 *
 * The three pieces are the source of truth for what the screens are made of:
 * a token table nothing may look outside of, an inventory of the components
 * pages are built from, and runnable page prototypes. They live in the
 * repository rather than in a design tool because the phase prompt has to be
 * byte-identical for identical input -- a round that fetched the current
 * version of a drawing would produce a different prompt every time it was
 * replayed, and cross-host rebuild, failover and crash recovery all ride on
 * that one property.
 */
export interface DesignToken {
  /** Dotted path through the token groups, e.g. `color.surface.raised`. */
  name: string;
  /** W3C `$type`, inherited from the nearest ancestor group that declares one. */
  type: string;
  /** The literal value, or an alias such as `{color.brand.primary}`. */
  value: string;
}

export interface PrototypePage {
  /** Path relative to the contract root, e.g. `pages/board.html`. */
  file: string;
  /** The page's own title. */
  name: string;
  /** One sentence saying what a person does on this page. */
  purpose: string;
}

export interface InterfaceContract {
  tokens: DesignToken[];
  /** `components.md` verbatim. */
  components: string;
  /** `design.md` verbatim: why the screens look the way they do. Injected
   * whole, because a phase that has to build a screen the contract's way needs
   * the reasoning, not a summary of it. */
  design: string;
  pages: PrototypePage[];
}

export type InterfaceContractRead =
  /** No contract root on this branch: the requirement has no screens, or the
   * solution that would have produced one has not run yet. */
  | { kind: "absent" }
  /** A root that exists but cannot be consumed; every reason is named so the
   * phase that has to fix it is told what is wrong rather than that something
   * is. */
  | { kind: "incomplete"; reasons: string[] }
  | { kind: "present"; contract: InterfaceContract };

const TOKENS_FILE = "tokens.json";
const COMPONENTS_FILE = "components.md";
const DESIGN_FILE = "design.md";
const PAGES_DIR = "pages";

/**
 * Token names `design.md` cites that the table does not hold.
 *
 * A reason layer that names a token nobody defined is worse than none: every
 * phase after it builds against a name that resolves to nothing, and the
 * mistake only surfaces as a screen that looks wrong. Names are read from
 * backticked words that look like a token path -- dotted, lower case -- which
 * is how the prompt asks for them and how every other citation in the file
 * would have to be written to be readable at all.
 */
const CITED_TOKEN = /`(?<name>[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+)`/g;

export function undefinedTokenCitations(
  design: string,
  tokens: readonly DesignToken[],
): string[] {
  const known = new Set(tokens.map((token) => token.name));
  const cited = new Set<string>();
  for (const match of design.matchAll(CITED_TOKEN)) {
    const name = match.groups?.name;
    if (name !== undefined && !known.has(name)) cited.add(name);
  }
  return [...cited].toSorted();
}

/**
 * Flattens a W3C design-tokens document into one sorted row per token.
 *
 * `$type` is inherited: a group declares it once and its leaves carry it, so a
 * token that resolves to no type at all is rejected rather than guessed --
 * a size written where a colour was meant is exactly the mistake the token
 * table exists to prevent.
 */
export function parseDesignTokens(text: string): { tokens: DesignToken[] } | { reasons: string[] } {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (cause) {
    return { reasons: [`${TOKENS_FILE} is not valid JSON: ${cause instanceof Error ? cause.message : "unreadable"}`] };
  }
  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    return { reasons: [`${TOKENS_FILE} must be an object of token groups`] };
  }

  const tokens: DesignToken[] = [];
  const reasons: string[] = [];
  const walk = (node: Record<string, unknown>, path: string[], inheritedType: string | undefined): void => {
    const declaredType = typeof node.$type === "string" ? node.$type : inheritedType;
    if ("$value" in node) {
      const name = path.join(".");
      if (!declaredType) reasons.push(`token ${name} has no $type, and no group above it declares one`);
      else tokens.push({ name, type: declaredType, value: literal(node.$value) });
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      if (key.startsWith("$")) continue;
      if (child === null || typeof child !== "object" || Array.isArray(child)) {
        reasons.push(`${[...path, key].join(".")} is neither a token nor a group`);
        continue;
      }
      walk(child as Record<string, unknown>, [...path, key], declaredType);
    }
  };
  walk(document as Record<string, unknown>, [], undefined);

  if (reasons.length > 0) return { reasons };
  if (tokens.length === 0) return { reasons: [`${TOKENS_FILE} declares no tokens`] };
  return { tokens: tokens.toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) };
}

/** Composite values (a shadow, a typography set) keep their shape as compact
 * JSON; a downstream phase needs the parts, not a summary of them. */
function literal(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

const TITLE = /<title>([\s\S]*?)<\/title>/i;
const DESCRIPTION = /<meta\s+[^>]*name=["']description["'][^>]*>/i;
const CONTENT = /content=["']([^"']*)["']/i;

/**
 * What a page says about itself.
 *
 * The title and the description are required because they are what every
 * downstream reader gets: the page list in a phase prompt, the section a
 * person confirms in Notion and the name a screenshot is filed under. A page
 * that does not say what it is for leaves all three to guess.
 */
export function describePrototypePage(file: string, html: string): PrototypePage | { reasons: string[] } {
  const reasons: string[] = [];
  const name = TITLE.exec(html)?.[1]?.trim() ?? "";
  const description = DESCRIPTION.exec(html)?.[0] ?? "";
  const purpose = CONTENT.exec(description)?.[1]?.trim() ?? "";
  if (name === "") reasons.push(`${file} has no <title>, so the page has no name`);
  if (purpose === "") reasons.push(`${file} has no <meta name="description">, so nothing says what the page is for`);
  return reasons.length > 0 ? { reasons } : { file, name, purpose };
}

/**
 * Reads the contract out of a checkout.
 *
 * `root` is the contract directory inside the worktree, not the worktree: the
 * caller owns the repository layout, and a test owns a directory it wrote.
 */
export async function readInterfaceContract(root: string): Promise<InterfaceContractRead> {
  const tokensText = await read(join(root, TOKENS_FILE));
  const componentsText = await read(join(root, COMPONENTS_FILE));
  const designText = await read(join(root, DESIGN_FILE));
  const pageFiles = await listPages(join(root, PAGES_DIR));
  if (tokensText === null && componentsText === null && designText === null && pageFiles.length === 0) {
    return { kind: "absent" };
  }

  const reasons: string[] = [];
  if (tokensText === null) reasons.push(`${TOKENS_FILE} is missing`);
  if (componentsText === null) reasons.push(`${COMPONENTS_FILE} is missing`);
  else if (componentsText.trim() === "") reasons.push(`${COMPONENTS_FILE} is empty`);
  if (designText === null) reasons.push(`${DESIGN_FILE} is missing`);
  else if (designText.trim() === "") reasons.push(`${DESIGN_FILE} is empty`);
  if (pageFiles.length === 0) reasons.push(`${PAGES_DIR}/ has no page to look at`);

  const parsed = tokensText === null ? { reasons: [] } : parseDesignTokens(tokensText);
  if ("reasons" in parsed) reasons.push(...parsed.reasons);
  if (designText !== null && "tokens" in parsed) {
    for (const name of undefinedTokenCitations(designText, parsed.tokens)) {
      reasons.push(`${DESIGN_FILE} names ${name}, which ${TOKENS_FILE} does not define`);
    }
  }

  const pages: PrototypePage[] = [];
  for (const file of pageFiles) {
    const html = await read(join(root, file));
    if (html === null) continue;
    const described = describePrototypePage(file, html);
    if ("reasons" in described) reasons.push(...described.reasons);
    else pages.push(described);
  }

  if (reasons.length > 0) return { kind: "incomplete", reasons };
  return {
    kind: "present",
    contract: {
      tokens: "tokens" in parsed ? parsed.tokens : [],
      components: componentsText!.trim(),
      design: designText!.trim(),
      pages,
    },
  };
}

async function read(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    // Absent or unreadable are the same answer here: the caller reports the
    // file as missing, and a directory that exists but denies reads is a box
    // problem the operator sees in that same report.
    return null;
  }
}

/** Page files, sorted, relative to the contract root. Nested directories are
 * not walked: a flat list is what the page inventory and the screenshots are
 * both keyed by. */
async function listPages(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory))
      .filter((entry) => entry.endsWith(".html"))
      .toSorted()
      .map((entry) => `${PAGES_DIR}/${entry}`);
  } catch {
    // No pages directory; reported by the caller as a missing piece unless the
    // whole contract is absent.
    return [];
  }
}

/**
 * The section injected into a downstream phase.
 *
 * Tokens are rendered as a sorted flat list rather than as the file's own
 * text: reformatting the JSON or reordering its keys would otherwise change
 * the prompt bytes without changing a single token. The page HTML is not
 * injected -- it is large, and a phase that needs a page reads the file.
 */
export function renderInterfaceContract(contract: InterfaceContract): string {
  const tokens = contract.tokens.map((token) => `- ${token.name} (${token.type}): ${token.value}`);
  const pages = contract.pages.map((page) => `- ${page.file} - ${page.name}: ${page.purpose}`);
  return [
    "## Interface contract",
    "",
    "The screens this requirement is made of, as the repository declares them. "
      + "Every colour, size, spacing and radius comes from the token table below; "
      + "a value that is not in it is not yours to invent. Build screens out of the "
      + "components listed here, and read the page prototype itself when you need its structure.",
    "",
    "### Design tokens",
    "",
    ...tokens,
    "",
    "### Components",
    "",
    contract.components,
    "",
    "### Why the screens look this way",
    "",
    contract.design,
    "",
    "### Pages",
    "",
    ...pages,
  ].join("\n");
}
