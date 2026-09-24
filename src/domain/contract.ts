import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * The acceptance contract (`.hivemind/acceptance.yaml`): what the finished
 * product must visibly do, written by the planner, approved by a person, and
 * judged by an evaluator that never sees the builder's session.
 *
 * Every field exists because its absence let a broken product pass:
 * - `page` is required for a screen: a component written but never mounted at
 *   the product entry passes every unit test.
 * - `visible` is required: a round that served a 404 page once reported four
 *   scenarios as passed from prose alone.
 * - `mutates` / `persistedBy`: a screen that saves something was accepted
 *   against a store that reset on every reload, twice, because nothing asked
 *   whether the change survived a reopen.
 */

const visibleSchema = z
  .object({
    role: z.string().min(1).optional(),
    text: z.string().min(1).optional(),
  })
  .strict()
  .refine((value) => value.role !== undefined || value.text !== undefined, {
    message: "a visible expectation names a role, a text, or both",
  });

const scenarioSchema = z
  .object({
    id: z.string().regex(/^A\d+\.\d+$/, "scenario ids look like A1.1 (item id, dot, number)"),
    title: z.string().min(1),
    given: z.string().min(1),
    when: z.string().min(1),
    // oxlint-disable-next-line unicorn/no-thenable -- given/when/then is the contract's own vocabulary; the value is a string, never a function, so no object holding it is a thenable.
    then: z.string().min(1),
    /** Web: the path inside the application where the scenario is judged. */
    page: z.string().startsWith("/").optional(),
    /** CLI: the command a user would type, run from the repository root. */
    command: z.string().min(1).optional(),
    visible: z.array(visibleSchema).min(1),
    /** Name passed to the project's seed command before the scenario runs. */
    seed: z.string().min(1).optional(),
    mutates: z.boolean().default(false),
    /** The scenario that reopens the page and shows the change is still there. */
    persistedBy: z.string().optional(),
  })
  .strict();

const itemSchema = z
  .object({
    id: z.string().regex(/^A\d+$/, "acceptance item ids look like A1"),
    title: z.string().min(1),
    surface: z.enum(["web", "cli"]),
    scenarios: z.array(scenarioSchema).min(1),
  })
  .strict();

export const contractSchema = z
  .object({
    items: z.array(itemSchema).min(1),
    outOfScope: z.array(z.string().min(1)).default([]),
  })
  .strict();

export type Contract = z.infer<typeof contractSchema>;
export type AcceptanceItem = Contract["items"][number];
export type Scenario = AcceptanceItem["scenarios"][number];
export type VisibleExpectation = Scenario["visible"][number];

/** A scenario together with the surface of the item it belongs to. */
export interface ContractScenario extends Scenario {
  itemId: string;
  surface: AcceptanceItem["surface"];
}

/** Cross-field rules a schema cannot express. Each finding says what to change. */
export function checkContract(contract: Contract): string[] {
  const findings: string[] = [];
  const itemIds = new Set<string>();
  const scenarios = new Map<string, ContractScenario>();
  for (const item of contract.items) {
    if (itemIds.has(item.id)) findings.push(`acceptance item id ${item.id} is used twice; give each item its own id`);
    itemIds.add(item.id);
    for (const scenario of item.scenarios) {
      if (!scenario.id.startsWith(`${item.id}.`)) {
        findings.push(`scenario ${scenario.id} sits under item ${item.id}; its id must start with "${item.id}."`);
      }
      if (scenarios.has(scenario.id)) findings.push(`scenario id ${scenario.id} is used twice`);
      scenarios.set(scenario.id, { ...scenario, itemId: item.id, surface: item.surface });
      if (item.surface === "web" && scenario.page === undefined) {
        findings.push(`scenario ${scenario.id} is on a web item and needs "page": the path a user opens to see it`);
      }
      if (item.surface === "cli" && scenario.command === undefined) {
        findings.push(`scenario ${scenario.id} is on a cli item and needs "command": what a user types`);
      }
    }
  }
  for (const scenario of scenarios.values()) {
    if (!scenario.mutates) {
      if (scenario.persistedBy !== undefined) {
        findings.push(`scenario ${scenario.id} names persistedBy but does not change anything; drop persistedBy or set mutates: true`);
      }
      continue;
    }
    if (scenario.surface !== "web") continue;
    if (scenario.persistedBy === undefined) {
      findings.push(
        `scenario ${scenario.id} changes something; add a scenario that reopens ${scenario.page ?? "the page"} and shows the change is still there, and point persistedBy at it`,
      );
      continue;
    }
    const witness = scenarios.get(scenario.persistedBy);
    if (witness === undefined) {
      findings.push(`scenario ${scenario.id} names persistedBy ${scenario.persistedBy}, which does not exist`);
    } else if (witness.surface !== "web" || witness.page !== scenario.page) {
      findings.push(`scenario ${scenario.id} is persisted by ${witness.id}, which must reopen the same page ${scenario.page ?? ""}`);
    } else if (witness.id === scenario.id) {
      findings.push(`scenario ${scenario.id} cannot be its own persistence witness`);
    }
  }
  return findings;
}

export function contractScenarios(contract: Contract, itemIds?: readonly string[]): ContractScenario[] {
  const wanted = itemIds === undefined ? null : new Set(itemIds);
  return contract.items
    .filter((item) => wanted === null || wanted.has(item.id))
    .flatMap((item) => item.scenarios.map((scenario) => ({ ...scenario, itemId: item.id, surface: item.surface })));
}

export function hasWebSurface(contract: Contract): boolean {
  return contract.items.some((item) => item.surface === "web");
}

/**
 * Identifies what a set of acceptance items asks for. An item that passed is
 * reopened when this changes, so a person's change to a finished screen is
 * built instead of being replayed against the old expectation forever.
 */
export function coverageDigest(contract: Contract, itemIds: readonly string[]): string {
  const wanted = new Set(itemIds);
  const covered = contract.items.filter((item) => wanted.has(item.id)).toSorted((left, right) => (left.id < right.id ? -1 : 1));
  return createHash("sha256").update(JSON.stringify(covered)).digest("hex");
}

/** Each plan item's current coverage digest, keyed by plan item id. */
export function coverageDigests(contract: Contract, plan: { items: readonly { id: string; covers: readonly string[] }[] }): Map<string, string> {
  return new Map(plan.items.map((item) => [item.id, coverageDigest(contract, item.covers)]));
}
