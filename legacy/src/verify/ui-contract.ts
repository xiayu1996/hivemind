import type { DesignToken } from "../pipeline/interface-contract.js";

/**
 * The second of the three interface layers (design 08 section 6): is every
 * colour, size and spacing on the screen one the token table allows?
 *
 * It can refuse for the same reason the structural layer can and the third
 * cannot: the token table is a finite set, so a page either uses a value from
 * it or uses one that is not in it, and the failing set shrinks or repeats.
 * "Does this look right" has neither property.
 *
 * Values are compared, not provenance, because computed styles carry no
 * provenance: the browser reports `rgb(17, 24, 39)` whether that came from a
 * token or from somebody typing it. Both sides are therefore normalised into
 * one canonical form first -- and lengths are resolved against the root font
 * size the page actually reported, so `1rem` and `16px` are the same value
 * rather than two the check would have had to guess between.
 */

/** Where a value was found, for a finding a person can act on. */
export interface StyleUsage {
  /** A readable path to the element, e.g. `main > .card:nth-of-type(2)`. */
  selector: string;
  /** The CSS property, as the browser names it. */
  property: string;
  /** The computed value, as the browser reports it. */
  value: string;
}

export interface PageStyles {
  /** `font-size` of the document element, in px. Lengths resolve against it. */
  rootFontSizePx: number;
  usages: StyleUsage[];
}

export interface ContractViolation {
  page: string;
  selector: string;
  property: string;
  value: string;
  /** Which part of the token table should have supplied it. */
  expected: "color" | "length";
}

/** How much power the contract layer has. `warn` is the default: 08 section 6
 * asks for one requirement's worth of real findings before it may stop a card,
 * because a criterion that refuses wrongly costs the card its whole budget. */
export type ContractEnforcement = "off" | "warn" | "block";

/**
 * The configured setting, narrowed. The config registry validates against its
 * own schema and hands back a plain string; anything this module does not know
 * is read as `warn`, which neither hides a finding nor stops a card.
 */
export function contractEnforcement(value: string): ContractEnforcement {
  return value === "off" || value === "block" ? value : "warn";
}

const HEX = /^#(?<digits>[0-9a-f]{3,8})$/i;
const RGB = /^rgba?\(\s*(?<parts>[^)]*)\)$/i;
const LENGTH = /^(?<amount>-?\d*\.?\d+)(?<unit>px|rem|em)$/i;

/** Colour properties a token table is responsible for. */
const COLOR_PROPERTIES = new Set([
  "color",
  "background-color",
  "border-top-color",
  "border-right-color",
  "border-bottom-color",
  "border-left-color",
  "outline-color",
]);

/** Size and spacing properties a token table is responsible for. */
const LENGTH_PROPERTIES = new Set([
  "font-size",
  "border-top-left-radius",
  "border-top-right-radius",
  "border-bottom-right-radius",
  "border-bottom-left-radius",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "row-gap",
  "column-gap",
]);

/**
 * The properties the browser is asked for. Exported so the collector and the
 * checker cannot drift into asking about one set and judging another.
 */
export const CONTRACT_PROPERTIES: readonly string[] = [
  ...COLOR_PROPERTIES,
  ...LENGTH_PROPERTIES,
].toSorted();

/**
 * `rgb(r, g, b, a)` with a in the range 0..1, or null when the text is not a
 * colour this check understands. Unknown syntax is not a violation: a value
 * nothing can parse cannot be said to be outside a set.
 */
export function normalizeColor(value: string): string | null {
  const text = value.trim().toLowerCase();
  if (text === "transparent") return "rgb(0, 0, 0, 0)";
  const hex = HEX.exec(text)?.groups?.digits;
  if (hex) {
    const digits = hex.length === 3 || hex.length === 4
      ? [...hex].map((digit) => digit + digit).join("")
      : hex;
    if (digits.length !== 6 && digits.length !== 8) return null;
    const channel = (index: number): number => Number.parseInt(digits.slice(index * 2, index * 2 + 2), 16);
    const alpha = digits.length === 8 ? channel(3) / 255 : 1;
    return `rgb(${channel(0)}, ${channel(1)}, ${channel(2)}, ${round(alpha)})`;
  }
  const parts = RGB.exec(text)?.groups?.parts;
  if (parts === undefined) return null;
  const numbers = parts.split(/[\s,/]+/).filter(Boolean).map(Number);
  if (numbers.length < 3 || numbers.slice(0, 3).some((number) => !Number.isFinite(number))) return null;
  const alpha = numbers.length > 3 && Number.isFinite(numbers[3]!) ? numbers[3]! : 1;
  return `rgb(${numbers[0]}, ${numbers[1]}, ${numbers[2]}, ${round(alpha)})`;
}

function round(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

/**
 * A length in px, resolved against the page's own root font size. `em` is
 * treated as `rem`: the token table is written in one scale, and a token that
 * meant a different one relative to its parent is not a token.
 */
export function normalizeLength(value: string, rootFontSizePx: number): string | null {
  const text = value.trim().toLowerCase();
  if (text === "0") return "0px";
  const match = LENGTH.exec(text)?.groups;
  if (!match) return null;
  const amount = Number(match.amount);
  if (!Number.isFinite(amount)) return null;
  const px = match.unit === "px" ? amount : amount * rootFontSizePx;
  return `${round(px)}px`;
}

export interface AllowedValues {
  colors: ReadonlySet<string>;
  lengths: ReadonlySet<string>;
}

/**
 * What the token table permits, with aliases followed.
 *
 * An alias chain that does not end at a literal contributes nothing rather
 * than throwing: `readInterfaceContract` already refuses a contract it cannot
 * consume, and this function is also called on a half-written prototype whose
 * own exit gate is what should report the problem.
 */
export function allowedValues(tokens: readonly DesignToken[], rootFontSizePx: number): AllowedValues {
  const byName = new Map(tokens.map((token) => [token.name, token]));
  const colors = new Set<string>();
  const lengths = new Set<string>();
  for (const token of tokens) {
    const literal = resolveAlias(token, byName);
    if (literal === null) continue;
    const color = normalizeColor(literal);
    if (color !== null) colors.add(color);
    const length = normalizeLength(literal, rootFontSizePx);
    if (length !== null) lengths.add(length);
  }
  // Zero and fully transparent are not decisions a token table has to make:
  // they are the absence of the thing, and requiring a token for "no padding"
  // would fill the table with names nobody reads.
  lengths.add("0px");
  colors.add("rgb(0, 0, 0, 0)");
  return { colors, lengths };
}

function resolveAlias(token: DesignToken, byName: ReadonlyMap<string, DesignToken>): string | null {
  let current: DesignToken | undefined = token;
  // A chain longer than the table cannot terminate, so the bound is the table.
  for (let hop = 0; hop <= byName.size && current; hop++) {
    const alias = /^\{(?<name>[^}]+)\}$/.exec(current.value.trim())?.groups?.name;
    if (alias === undefined) return current.value;
    current = byName.get(alias);
  }
  return null;
}

/**
 * Every usage whose value the token table does not contain.
 *
 * `auto`, `normal` and the other keywords a browser reports for an unset
 * property are skipped by normalisation returning null: they are not values
 * anybody chose, and reporting them would bury the ones that were.
 */
export function contractViolations(
  page: string,
  styles: PageStyles,
  allowed: AllowedValues,
): ContractViolation[] {
  const violations: ContractViolation[] = [];
  const seen = new Set<string>();
  for (const usage of styles.usages) {
    const isColor = COLOR_PROPERTIES.has(usage.property);
    if (!isColor && !LENGTH_PROPERTIES.has(usage.property)) continue;
    const normalized = isColor
      ? normalizeColor(usage.value)
      : normalizeLength(usage.value, styles.rootFontSizePx);
    if (normalized === null) continue;
    if ((isColor ? allowed.colors : allowed.lengths).has(normalized)) continue;
    // One finding per property and value: the same hard-coded grey on forty
    // elements is one decision to undo, and forty lines of it would read as
    // forty problems.
    const key = `${usage.property}=${normalized}`;
    if (seen.has(key)) continue;
    seen.add(key);
    violations.push({
      page,
      selector: usage.selector,
      property: usage.property,
      value: usage.value,
      expected: isColor ? "color" : "length",
    });
  }
  return violations;
}

/** What a person reads about the page, in the words the card is written in. */
export function describeContractViolations(violations: readonly ContractViolation[]): string[] {
  return violations.map((violation) =>
    `${violation.page} 的 ${violation.selector} 用了不在设计规范里的${
      violation.expected === "color" ? "颜色" : "尺寸"
    }：${violation.property} 是 ${violation.value}`
  );
}
