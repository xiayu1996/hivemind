// oxlint-disable unicorn/no-thenable -- the scenario grammar names a "then" field
import { createClient } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { migrate } from "../persistence/migrate.js";
import type { SolutionBody } from "./requirement-solution.js";
import { RequirementStore } from "./requirement-store.js";
import {
  PrototypeRunner,
  type PrototypeDelivery,
  type PrototypePort,
  type PrototypeRequest,
  type PrototypeResult,
} from "./prototype-runner.js";

/** A visual direction that satisfies the contract, so a test only has to
 * break the one thing it is about. */
const DIRECTION = { summary: "深色底、字大、一屏一件事，给值班的人走着看。", alternatives: [{ option: "浅色密集表格", reason: "值班的人不会坐下来逐行读。" }] };

const scenarios = [{ id: "R-1-01", given: "看板上有任务", when: "打开首页", then: "看得见任务列表" }];

function solution(overrides: Partial<SolutionBody> = {}): SolutionBody {
  return {
    approach: { summary: "沿用现有栈，加一个后台页面", alternatives: [] },
    stackChanges: [],
    openDecisions: [],
    qualityGates: [],
    interface: { kind: "web", direction: DIRECTION, pages: [{ name: "任务看板", purpose: "看今天要做什么" }] },
    ...overrides,
  };
}

const drawn: PrototypeResult = {
  pages: [{ file: "pages/board.html", scenarios: ["R-1-01"], visible: [{ role: "button", text: "新建任务" }] }],
  concerns: [],
};

function port(answer: () => Promise<PrototypeResult>): PrototypePort & { seen: PrototypeRequest[] } {
  const seen: PrototypeRequest[] = [];
  return {
    seen,
    run: async (input) => {
      seen.push(input);
      return answer();
    },
  };
}

function delivery(url: string | null): PrototypeDelivery {
  return { publish: vi.fn(async () => url === null ? null : { url }) };
}

describe("PrototypeRunner", () => {
  let store: RequirementStore;
  let publisher: { publish: ReturnType<typeof vi.fn> };
  let revision: number;

  beforeEach(async () => {
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    store = new RequirementStore(client);
    publisher = { publish: vi.fn(async () => undefined) };
    await store.createRequirement({
      id: "R-1",
      notionPageId: "page-1",
      title: "任务看板",
      originalRequest: "要一个看板",
      repo: "acme/widget",
    });
    await store.transition("R-1", "CLARIFY", "PRD_CONFIRM", "system", "requirement:R-1");
    await store.transition("R-1", "PRD_CONFIRM", "SOLUTION", "system", "requirement:R-1");
    revision = await store.saveDraftSolution("R-1", JSON.stringify(solution()), "requirement:R-1");
  });

  function runner(overrides: { port?: PrototypePort; delivery?: PrototypeDelivery } = {}) {
    return new PrototypeRunner(
      store,
      overrides.port ?? port(async () => drawn),
      overrides.delivery ?? delivery("https://example.invalid/mr/1"),
      publisher,
    );
  }

  const request = () => ({
    requirementId: "R-1",
    title: "任务看板",
    repository: "acme/widget",
    businessGoal: "让人看见今天要做什么",
    scenarios,
    solution: solution(),
    revision,
    contractRoot: "docs/prototype",
  });

  it("does not draw anything for a requirement with no interface", async () => {
    const drawing = port(async () => drawn);

    const outcome = await runner({ port: drawing }).draw({
      ...request(),
      solution: solution({ interface: null }),
    });

    expect(outcome.kind).toBe("skipped");
    expect(drawing.seen).toEqual([]);
  });

  it("does not draw anything for a requirement with no repository to write it into", async () => {
    const drawing = port(async () => drawn);

    const outcome = await runner({ port: drawing }).draw({ ...request(), repository: "" });

    expect(outcome.kind).toBe("skipped");
    expect(drawing.seen).toEqual([]);
  });

  it("records the contract against the solution revision it belongs to", async () => {
    const outcome = await runner().draw(request());

    expect(outcome).toEqual({ kind: "drawn", revision, concerns: [], mrUrl: "https://example.invalid/mr/1" });
    const stored = await store.getSolutionPrototype("R-1", revision);
    expect(JSON.parse(stored!.body)).toEqual(drawn);
    expect(stored!.mrUrl).toBe("https://example.invalid/mr/1");
  });

  it("tells the drawing what the person asked to change about the earlier one", async () => {
    await store.requestSolutionRevision("R-1", revision, "配色太重了", "e-1", "comment", "requirement:R-1");
    const next = await store.saveDraftSolution("R-1", JSON.stringify(solution()), "requirement:R-1");
    const drawing = port(async () => drawn);

    await runner({ port: drawing }).draw({ ...request(), revision: next });

    expect(drawing.seen[0]!.revisionFeedback).toEqual(["配色太重了"]);
    expect(drawing.seen[0]!.approach).toBe("沿用现有栈，加一个后台页面");
  });

  it("stops the requirement when the drawing never passed its own checks", async () => {
    const drawing = port(async () => {
      throw new Error("pages/board.html 上没有出现它声称能看见的内容");
    });

    const outcome = await runner({ port: drawing }).draw(request());

    expect(outcome.kind).toBe("stopped");
    const requirement = await store.getRequirement("R-1");
    expect(requirement.state).toBe("SOLUTION");
    expect(requirement.stopReason).toBe("blocking_question");
    expect(publisher.publish).toHaveBeenCalledWith("R-1");
    expect(await store.getSolutionPrototype("R-1", revision)).toBeNull();
  });

  it("records a contract that has nowhere to be published rather than losing it", async () => {
    const outcome = await runner({ delivery: delivery(null) }).draw(request());

    expect(outcome).toEqual({ kind: "drawn", revision, concerns: [], mrUrl: null });
    expect((await store.getSolutionPrototype("R-1", revision))!.mrUrl).toBeNull();
  });

  it("redrawing one revision replaces its contract instead of adding a second", async () => {
    await runner().draw(request());
    const second = { pages: drawn.pages, concerns: ["页面清单里少了一个筛选页"] };

    await runner({ port: port(async () => second) }).draw(request());

    const stored = await store.getSolutionPrototype("R-1", revision);
    expect(JSON.parse(stored!.body).concerns).toEqual(["页面清单里少了一个筛选页"]);
  });
});
