import { z } from "zod";
import type { Contract } from "./contract.ts";

/**
 * The build plan (`.hivemind/plan.yaml`): the order in which vertical slices
 * are built on the integration branch. It is disposable: the planner rewrites
 * it after a milestone or when an item cannot be finished, and the loop only
 * ever reads the current version.
 */

const planItemSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/, "plan item ids are lowercase words joined by hyphens"),
    /** enabling: foundation work no user sees directly (stack, scaffold, checks); feature/fix: a user-visible slice. */
    kind: z.enum(["enabling", "feature", "fix"]),
    title: z.string().min(1),
    /** What done means, for the builder. */
    goal: z.string().min(1),
    /** Acceptance item ids this slice makes pass. */
    covers: z.array(z.string().regex(/^A\d+$/)).default([]),
    dependsOn: z.array(z.string()).default([]),
    /** Stop for a milestone review after this item lands. */
    milestone: z.boolean().default(false),
  })
  .strict();

export const planSchema = z.object({ items: z.array(planItemSchema).min(1) }).strict();

export type Plan = z.infer<typeof planSchema>;
export type PlanItem = Plan["items"][number];
export type ItemStatus = "pending" | "passed" | "blocked";

/** Returns the ids forming a dependency cycle, or null. */
export function findDependencyCycle(items: readonly PlanItem[]): string[] | null {
  const byId = new Map(items.map((item) => [item.id, item]));
  const state = new Map<string, "visiting" | "done">();
  const path: string[] = [];
  const visit = (id: string): string[] | null => {
    if (state.get(id) === "done") return null;
    if (state.get(id) === "visiting") return [...path.slice(path.indexOf(id)), id];
    state.set(id, "visiting");
    path.push(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) {
      if (!byId.has(dependency)) continue;
      const cycle = visit(dependency);
      if (cycle !== null) return cycle;
    }
    path.pop();
    state.set(id, "done");
    return null;
  };
  for (const item of items) {
    const cycle = visit(item.id);
    if (cycle !== null) return cycle;
  }
  return null;
}

/**
 * Cross-file rules. Every acceptance item must be covered by exactly one plan
 * item: an uncovered one is a gap nobody builds, a doubly covered one is two
 * slices judged against the same screen.
 */
export function checkPlan(plan: Plan, contract: Contract): string[] {
  const findings: string[] = [];
  const ids = new Set<string>();
  for (const item of plan.items) {
    if (ids.has(item.id)) findings.push(`plan item id ${item.id} is used twice`);
    ids.add(item.id);
  }
  for (const item of plan.items) {
    for (const dependency of item.dependsOn) {
      if (!ids.has(dependency)) findings.push(`plan item ${item.id} depends on ${dependency}, which is not in the plan`);
      if (dependency === item.id) findings.push(`plan item ${item.id} depends on itself`);
    }
  }
  const cycle = findDependencyCycle(plan.items);
  if (cycle !== null) findings.push(`plan items depend on each other in a cycle: ${cycle.join(" -> ")}`);

  const acceptanceIds = new Set(contract.items.map((item) => item.id));
  const coveredBy = new Map<string, string[]>();
  for (const item of plan.items) {
    for (const covered of item.covers) {
      if (!acceptanceIds.has(covered)) findings.push(`plan item ${item.id} covers ${covered}, which is not in the acceptance contract`);
      coveredBy.set(covered, [...(coveredBy.get(covered) ?? []), item.id]);
    }
  }
  for (const acceptanceId of acceptanceIds) {
    const owners = coveredBy.get(acceptanceId) ?? [];
    if (owners.length === 0) findings.push(`acceptance item ${acceptanceId} is covered by no plan item; add it to the covers of the slice that builds it`);
    if (owners.length > 1) findings.push(`acceptance item ${acceptanceId} is covered by ${owners.join(" and ")}; exactly one plan item must own it`);
  }
  return findings;
}

export type NextItem =
  | { kind: "item"; item: PlanItem }
  | { kind: "done" }
  | { kind: "blocked"; waitingOn: readonly string[] };

/**
 * The first pending item, in plan order, whose dependencies have all passed.
 * Plan order is the planner's priority; dependencies only hold items back.
 */
export function pickNext(plan: Plan, statuses: ReadonlyMap<string, ItemStatus>): NextItem {
  const pending = plan.items.filter((item) => (statuses.get(item.id) ?? "pending") !== "passed");
  if (pending.length === 0) return { kind: "done" };
  for (const item of pending) {
    if ((statuses.get(item.id) ?? "pending") !== "pending") continue;
    if (item.dependsOn.every((dependency) => statuses.get(dependency) === "passed")) return { kind: "item", item };
  }
  return { kind: "blocked", waitingOn: pending.map((item) => item.id) };
}
