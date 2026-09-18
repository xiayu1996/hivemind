import type { DesignToken } from "../pipeline/interface-contract.js";
import { missingFromSnapshot, type VisibleRequirement } from "./aria-snapshot.js";
import {
  allowedValues,
  contractViolations,
  describeContractViolations,
  type PageStyles,
} from "./ui-contract.js";

/**
 * What a prototype has to satisfy before it enters the repository (design 08
 * section 3.2).
 *
 * The same two layers that judge the delivered screens judge the prototype
 * first, so what later phases are measured against has already passed the
 * measurement. Every rule here is finite and enumerable -- a claimed page
 * exists or it does not, a role and a string are on the page or they are not,
 * a colour is in the token table or it is not -- which is what lets these
 * findings be fed back for another round without the failing set growing new
 * members forever. Taste is judged nowhere in this file.
 */

/** The four states every page must be able to show on its own, as query
 * values. They are states of the whole page, not overlays: a person who lands
 * on an empty list sees a page, not a spinner on top of one. */
export const PROTOTYPE_STATES = ["empty", "loading", "error", "waiting"] as const;
export type PrototypeState = (typeof PROTOTYPE_STATES)[number];

/** What the prototype says one page carries. The claim is the thing checked:
 * a page that claims nothing proves nothing, so the schema requires both a
 * scenario and something to see. */
export interface PrototypePageClaim {
  /** Path relative to the contract root, as `pages/board.html`. */
  file: string;
  /** PRD scenario ids this page is the screen for. */
  scenarios: readonly string[];
  /** Roles and texts that must be visible on it. */
  visible: readonly VisibleRequirement[];
}

/** What a browser saw when it opened one page. */
export interface PrototypePageEvidence {
  file: string;
  /** The page with no query, or null when it would not open. */
  snapshot: string | null;
  /** One snapshot per state that rendered. A state that did not is absent. */
  states: Readonly<Partial<Record<PrototypeState, string>>>;
  /** Computed styles of the page with no query, or null when it would not open. */
  styles: PageStyles | null;
}

export interface PrototypeExitInput {
  claims: readonly PrototypePageClaim[];
  evidence: readonly PrototypePageEvidence[];
  /** Page files the contract actually holds, from `readInterfaceContract`. */
  contractPages: readonly string[];
  /** Scenario ids of the requirement this prototype is the interface for. */
  scenarios: readonly string[];
  tokens: readonly DesignToken[];
  /** Why the contract could not be read as a whole, if it could not. */
  contractReasons: readonly string[];
}

/**
 * Everything wrong with the prototype, in a stable order, written to be fed
 * back into the session that drew it.
 *
 * Findings, not a verdict: the caller decides whether a round remains. They
 * are addressed to the model rather than to a person, so they name files and
 * roles; what a person reads about the prototype is `design.md`.
 */
export function evaluatePrototypeExit(input: PrototypeExitInput): string[] {
  const findings: string[] = [];
  for (const reason of [...input.contractReasons].toSorted()) {
    findings.push(`界面契约还不完整：${reason}`);
  }

  const claims = [...input.claims].toSorted((left, right) => compare(left.file, right.file));
  const evidence = new Map(input.evidence.map((page) => [page.file, page]));
  const pages = new Set(input.contractPages);
  const scenarios = new Set(input.scenarios);
  const claimed = new Set<string>();

  for (const claim of claims) {
    for (const scenario of claim.scenarios) {
      if (scenarios.has(scenario)) claimed.add(scenario);
      else findings.push(`${claim.file} 声称承接的 ${scenario} 不是这条需求的场景`);
    }
    if (!pages.has(claim.file)) {
      findings.push(`页面清单里的 ${claim.file} 在契约里不存在`);
      continue;
    }
    const seen = evidence.get(claim.file);
    if (!seen || seen.snapshot === null) {
      findings.push(`${claim.file} 打不开，没法判断它画了什么`);
      continue;
    }
    for (const missing of missingFromSnapshot(seen.snapshot, claim.visible)) {
      findings.push(`${claim.file} 上没有出现它声称能看见的内容：${missing.role} “${missing.text}”`);
    }
    findings.push(...stateFindings(claim.file, seen.states));
    if (seen.styles !== null) {
      findings.push(...describeContractViolations(contractViolations(
        claim.file,
        seen.styles,
        allowedValues(input.tokens, seen.styles.rootFontSizePx),
      )));
    }
  }

  for (const scenario of [...scenarios].toSorted()) {
    if (!claimed.has(scenario)) findings.push(`场景 ${scenario} 没有任何一页承接`);
  }
  return findings;
}

/**
 * The four states, present and distinct.
 *
 * Distinct because a page that ignores the query renders the same thing four
 * times, and four identical snapshots is exactly what "the states were never
 * built" looks like from outside.
 */
function stateFindings(file: string, states: Readonly<Partial<Record<PrototypeState, string>>>): string[] {
  const findings: string[] = [];
  const rendered: Array<[PrototypeState, string]> = [];
  for (const state of PROTOTYPE_STATES) {
    const snapshot = states[state];
    if (snapshot === undefined || snapshot.trim() === "") {
      findings.push(`${file} 的 ?state=${state} 没有渲染出内容`);
      continue;
    }
    rendered.push([state, snapshot]);
  }
  for (let index = 0; index < rendered.length; index++) {
    for (let other = index + 1; other < rendered.length; other++) {
      const [state, snapshot] = rendered[index]!;
      const [otherState, otherSnapshot] = rendered[other]!;
      if (snapshot === otherSnapshot) {
        findings.push(`${file} 的 ?state=${state} 与 ?state=${otherState} 画出来是同一页，四态没有真的分开`);
      }
    }
  }
  return findings;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
