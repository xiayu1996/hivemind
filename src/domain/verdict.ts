import { z } from "zod";
import type { ContractScenario } from "./contract.ts";

/**
 * The evaluator's verdict and the deterministic checks that bind it to
 * evidence the harness captured itself. The evaluator's own account of what
 * it saw is never enough: a passed scenario must cite a snapshot or output the
 * harness recorded that really shows every declared expectation, and a failed
 * one must quote the contract sentence the product contradicts.
 */

export const verdictSchema = z
  .object({
    scenarios: z
      .array(
        z
          .object({
            id: z.string().min(1),
            outcome: z.enum(["passed", "failed", "inconclusive"]),
            /** For people: what was seen, in business language. */
            reason: z.string().min(1),
            /** Ids of harness-captured evidence (snapshots, command outputs). */
            evidence: z.array(z.string()).default([]),
            /** Failed only: the exact contract sentence the product contradicts. */
            cites: z.string().optional(),
          })
          .strict(),
      )
      .min(1),
    /** Observations that never fail a scenario: spacing, wording, consistency. */
    findings: z.array(z.string().min(1)).default([]),
  })
  .strict();

export type Verdict = z.infer<typeof verdictSchema>;

export type Evidence =
  | { id: string; kind: "snapshot"; path: string; text: string }
  | { id: string; kind: "output"; command: string; text: string }
  | { id: string; kind: "screenshot"; path: string };

export interface EvidenceMatcher {
  matchSnapshot(text: string, scenario: ContractScenario): { ok: boolean; missing: readonly string[] };
  matchOutput(text: string, scenario: ContractScenario): { ok: boolean; missing: readonly string[] };
}

export interface JudgedScenario {
  id: string;
  reason: string;
  evidence: readonly string[];
}

export interface JudgedVerdict {
  passed: readonly JudgedScenario[];
  failed: readonly JudgedScenario[];
  inconclusive: readonly JudgedScenario[];
  findings: readonly string[];
}

export type VerdictCheck = { ok: true; verdict: JudgedVerdict } | { ok: false; findings: readonly string[] };

function normalize(text: string): string {
  return text.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

/** A path without its query and trailing slash, the way a page is named in the contract. */
function barePath(value: string): string {
  const withoutQuery = value.split(/[?#]/)[0] ?? value;
  return withoutQuery.length > 1 ? withoutQuery.replace(/\/+$/, "") : withoutQuery;
}

function samePath(evidencePath: string, page: string): boolean {
  return barePath(evidencePath) === barePath(page);
}

function contractText(scenario: ContractScenario): string {
  const visible = scenario.visible.map((entry) => [entry.role, entry.text].filter(Boolean).join(" "));
  return normalize([scenario.title, scenario.given, scenario.when, scenario.then, ...visible].join("\n"));
}

/**
 * Findings go back to the same evaluator session: a malformed verdict is the
 * evaluator's to fix, never the builder's.
 */
export function checkVerdict(
  verdict: Verdict,
  scenarios: readonly ContractScenario[],
  evidence: ReadonlyMap<string, Evidence>,
  matcher: EvidenceMatcher,
): VerdictCheck {
  const findings: string[] = [];
  const expected = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
  const reported = new Set<string>();
  const passed: JudgedScenario[] = [];
  const failed: JudgedScenario[] = [];
  const inconclusive: JudgedScenario[] = [];

  for (const entry of verdict.scenarios) {
    const scenario = expected.get(entry.id);
    if (scenario === undefined) {
      findings.push(`scenario ${entry.id} is not one you were asked to judge; judge exactly: ${[...expected.keys()].join(", ")}`);
      continue;
    }
    if (reported.has(entry.id)) {
      findings.push(`scenario ${entry.id} is reported twice; give one outcome per scenario`);
      continue;
    }
    reported.add(entry.id);
    const judged: JudgedScenario = { id: entry.id, reason: entry.reason, evidence: entry.evidence };

    if (entry.outcome === "inconclusive") {
      inconclusive.push(judged);
      continue;
    }
    if (entry.outcome === "failed") {
      const cites = entry.cites === undefined ? "" : normalize(entry.cites);
      if (cites.length === 0 || !contractText(scenario).includes(cites)) {
        findings.push(
          `scenario ${entry.id} is marked failed without quoting the contract: put in "cites" the exact sentence from its given/when/then or visible list that the product contradicts. A problem the contract does not state is a finding, not a failure.`,
        );
        continue;
      }
      failed.push(judged);
      continue;
    }

    const cited = entry.evidence.map((id) => evidence.get(id));
    const unknown = entry.evidence.filter((_, index) => cited[index] === undefined);
    if (entry.evidence.length === 0 || unknown.length > 0) {
      findings.push(
        entry.evidence.length === 0
          ? `scenario ${entry.id} is marked passed without evidence; cite the id of the snapshot or output that shows it`
          : `scenario ${entry.id} cites evidence that was never captured: ${unknown.join(", ")}`,
      );
      continue;
    }
    let shown = false;
    const misses: string[] = [];
    for (const item of cited) {
      if (item === undefined) continue;
      if (scenario.surface === "web" && item.kind === "snapshot") {
        if (scenario.page !== undefined && !samePath(item.path, scenario.page)) {
          misses.push(`${item.id} was taken on ${item.path}, not on ${scenario.page}`);
          continue;
        }
        const match = matcher.matchSnapshot(item.text, scenario);
        if (match.ok) shown = true;
        else misses.push(`${item.id} does not show: ${match.missing.join("; ")}`);
      } else if (scenario.surface === "cli" && item.kind === "output") {
        const match = matcher.matchOutput(item.text, scenario);
        if (match.ok) shown = true;
        else misses.push(`${item.id} does not contain: ${match.missing.join("; ")}`);
      }
    }
    if (!shown) {
      findings.push(
        `scenario ${entry.id} is marked passed, but no single cited ${scenario.surface === "web" ? "snapshot" : "output"} shows everything the contract lists${misses.length > 0 ? ` (${misses.join(" | ")})` : ""}. Capture one that does, or mark it failed or inconclusive.`,
      );
      continue;
    }
    passed.push(judged);
  }
  for (const id of expected.keys()) {
    if (!reported.has(id)) findings.push(`scenario ${id} has no outcome; report every scenario you were given`);
  }
  if (findings.length > 0) return { ok: false, findings };
  return { ok: true, verdict: { passed, failed, inconclusive, findings: verdict.findings } };
}
