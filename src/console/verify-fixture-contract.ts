import { fixtureFor, scenarioOfUrl, type VerifyFixture } from "./verify-fixture.js";

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

/** The behavior a scenario asks for, before any row is touched. `error` is a
 * todo the page cannot read; `rejected` is a todo the delivery refuses. */
export function verifyFixturePlanFor(scenarioId: string | null): VerifyFixturePlan {
  const fixture = fixtureFor(scenarioId);
  return {
    fixture,
    todoRead: fixture === "error" ? "unavailable" : "available",
    decisionDelivery: fixture === "rejected" ? "reject" : "confirm",
  };
}

/**
 * A page a browser navigates to, as opposed to the content it pulls in.
 *
 * A document navigation is a GET or HEAD for a path that is not the API, not a
 * built asset and not a file with an extension: a favicon, a bundle or an
 * image is something the page reads, and reading it must never be mistaken for
 * opening a page.
 */
function isDocumentNavigation(method: string, url: string): boolean {
  const verb = method.toUpperCase();
  if (verb !== "GET" && verb !== "HEAD") return false;
  const path = url.split("?")[0] ?? url;
  if (path.startsWith("/api/") || path.startsWith("/assets/")) return false;
  if (path === "/health" || path === "/favicon.ico") return false;
  return !(path.slice(path.lastIndexOf("/") + 1)).includes(".");
}

/** Reads one request: a document navigation selects a fixture, everything else
 * leaves the running one alone. */
export function classifyVerifyFixtureRequest(
  method: string,
  url: string,
): VerifyFixtureRequestEffect {
  if (!isDocumentNavigation(method, url)) return { kind: "preserve" };
  return { kind: "select", plan: verifyFixturePlanFor(scenarioOfUrl(url)) };
}

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

/**
 * Serializes fixture selection and reset onto one queue.
 *
 * Two browser requests can arrive at once -- a navigation and the content it
 * pulls in -- and an unsynchronized reset would let the later one erase what
 * the earlier one seeded. A selection runs after the previous one finished,
 * and a failure does not wedge the queue for the next request.
 */
export function createVerifyFixtureCoordinator(options: {
  apply(fixture: VerifyFixture, now?: number): Promise<void>;
  now?: () => number;
}): VerifyFixtureCoordinator {
  let current: VerifyFixturePlan | null = null;
  let tail: Promise<unknown> = Promise.resolve();
  return {
    get current() {
      return current;
    },
    apply(effect) {
      const run = tail.then(async () => {
        if (effect.kind === "preserve") return current;
        await options.apply(effect.plan.fixture, options.now?.());
        current = effect.plan;
        return current;
      });
      tail = run.then(() => undefined, () => undefined);
      return run;
    },
  };
}
