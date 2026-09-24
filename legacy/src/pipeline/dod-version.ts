import { createHash } from "node:crypto";
import type { DefinitionOfDone, DoDCriterion, DoDScenario } from "./dod.js";

/**
 * Content hashes over the frozen acceptance contract.
 *
 * Two levels, because they answer different questions. `dodVersion` says
 * whether the card's contract is the one the downstream artifacts were built
 * against. `scenarioVersion` says whether one scenario's own bar moved, and it
 * is the per-row invalidation judgment: hanging that on the card-level hash
 * would void every scenario whenever any one of them was reworded, which is
 * the same as tearing the whole card down.
 *
 * Normalisation is structural only: NFC, a stable order for the arrays that
 * are sets rather than sequences, and canonical key order. **No whitespace is
 * folded.** `examples[].text` is the literal a person will see on a screen and
 * `seed` is verbatim input to a repository's seed command, so a changed line
 * break or indent is a changed acceptance bar. Leading and trailing whitespace
 * is already gone: `dod.ts` applies `z.string().trim()` at the schema layer.
 *
 * This is a hash, not a semantic comparison. Rewording a `then` without
 * changing its meaning still changes the version, and the cost of that is one
 * re-verification -- much cheaper than carrying forward a conclusion that no
 * longer holds.
 */

function nfc(value: string): string {
  return value.normalize("NFC");
}

/** Canonical JSON: object keys in code-point order, arrays left as given.
 * Callers sort the arrays that are sets before they get here. */
function canonical(value: unknown): unknown {
  if (typeof value === "string") return nfc(value);
  if (Array.isArray(value)) return value.map((item) => canonical(item));
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(source).toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (source[key] === undefined) continue;
      result[key] = canonical(source[key]);
    }
    return result;
  }
  return value;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value)), "utf8").digest("hex");
}

function sortedStrings(values: readonly string[]): string[] {
  return [...values].map((item) => nfc(item)).toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The acceptance-bearing shape of one scenario. Everything the schema carries
 * is here: `source` and `seed` decide what the screen shows and what data it
 * shows it with, so a change to either is a change to what passing means. */
function scenarioShape(entry: DoDScenario): unknown {
  return {
    id: entry.id,
    given: entry.given,
    when: entry.when,
    // oxlint-disable-next-line unicorn/no-thenable -- the DoD grammar names the field and this object is only ever hashed
    then: entry.then,
    layers: sortedStrings(entry.layers),
    ...(entry.source === undefined ? {} : { source: entry.source }),
    ...(entry.seed === undefined ? {} : { seed: entry.seed }),
    // Examples are a set of constraints, not a sequence; keyed so that moving
    // a "shows" above an "excludes" is not a contract change but editing
    // either one's text is.
    examples: (entry.examples ?? [])
      .map((item) => ({ kind: item.kind, text: nfc(item.text) }))
      .toSorted((a, b) => (a.kind === b.kind ? (a.text < b.text ? -1 : a.text > b.text ? 1 : 0) : a.kind < b.kind ? -1 : 1)),
  };
}

function criterionShape(item: DoDCriterion): unknown {
  return "scenarios" in item
    ? { text: nfc(item.text), scenarios: sortedStrings(item.scenarios) }
    : { text: nfc(item.text), constraint: nfc(item.constraint) };
}

function sortedCriteria(items: readonly DoDCriterion[]): unknown[] {
  return items
    .map((item) => criterionShape(item))
    .toSorted((a, b) => {
      const left = JSON.stringify(canonical(a));
      const right = JSON.stringify(canonical(b));
      return left < right ? -1 : left > right ? 1 : 0;
    });
}

/**
 * Fields that bind every scenario at once: the baseline decides what kind of
 * proof counts, and `out_of_scope` / `relies_on` decide what a reviewer may and
 * may not refuse the card for. Changing one of them moves every scenario's bar.
 */
function globalShape(dod: DefinitionOfDone): unknown {
  return {
    baseline: dod.baseline,
    out_of_scope: sortedStrings(dod.out_of_scope),
    relies_on: sortedStrings(dod.relies_on),
  };
}

/** The whole card's acceptance contract. `predicted_footprint` and
 * `depends_on` are deliberately outside it: they steer scheduling and say
 * nothing about whether the work is done. */
export function dodVersion(dod: DefinitionOfDone): string {
  return sha256({
    story_id: dod.story_id,
    scenarios: dod.scenarios.map((entry) => scenarioShape(entry)).toSorted((a, b) => {
      const left = (a as { id: string }).id;
      const right = (b as { id: string }).id;
      return left < right ? -1 : left > right ? 1 : 0;
    }),
    acceptance_criteria: sortedCriteria(dod.acceptance_criteria),
    global: globalShape(dod),
  });
}

/** One scenario's own bar: its fields, the globally binding fields, and the
 * criteria that name it. A criterion moving between scenarios changes the
 * version of both the scenario it left and the one it joined. */
export function scenarioVersion(dod: DefinitionOfDone, scenarioId: string): string {
  const entry = dod.scenarios.find((item) => item.id === scenarioId);
  if (!entry) throw new Error(`DoD has no scenario ${scenarioId}`);
  const owned = dod.acceptance_criteria.filter((item) => "scenarios" in item && item.scenarios.includes(scenarioId));
  return sha256({
    scenario: scenarioShape(entry),
    acceptance_criteria: sortedCriteria(owned),
    global: globalShape(dod),
  });
}

/** Every scenario's version, keyed by id. */
export function scenarioVersions(dod: DefinitionOfDone): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of dod.scenarios) result[entry.id] = scenarioVersion(dod, entry.id);
  return result;
}
