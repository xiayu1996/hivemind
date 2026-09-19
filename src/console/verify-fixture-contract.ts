import type { VerifyFixture } from "./verify-fixture.js";

export type VerifyTodoReadMode = "available" | "unavailable";
export type VerifyDecisionDeliveryMode = "confirm" | "reject";

/** The complete behavior selected by one verification page navigation. */
export interface VerifyFixturePlan {
  readonly fixture: VerifyFixture;
  readonly todoRead: VerifyTodoReadMode;
  readonly decisionDelivery: VerifyDecisionDeliveryMode;
}

/**
 * Only a document navigation may select and reset a verification fixture.
 * Browser assets, health probes, and API calls preserve the current plan, so a
 * favicon request cannot erase the todo selected by the page that caused it.
 */
export type VerifyFixtureRequestEffect =
  | { readonly kind: "select"; readonly plan: VerifyFixturePlan }
  | { readonly kind: "preserve" };

export declare function verifyFixturePlanFor(scenarioId: string | null): VerifyFixturePlan;

export declare function classifyVerifyFixtureRequest(
  method: string,
  url: string,
): VerifyFixtureRequestEffect;

/**
 * The verification server is the sole owner of the active fixture plan.
 * Selections are serialized with fixture resets; reads and submissions observe
 * the last completed selection and never mutate it. A rejected delivery must
 * leave its seeded todo waiting and must not mark its outbox write as sent.
 */
export interface VerifyFixtureCoordinator {
  readonly current: VerifyFixturePlan | null;
  apply(effect: VerifyFixtureRequestEffect): Promise<VerifyFixturePlan | null>;
}
