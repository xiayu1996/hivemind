import { createClient, type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../persistence/migrate.js";
import { listPendingTodos, readPendingTodo } from "../orchestrator/pending-todo.js";
import { applyVerifyFixture, fixtureFor, scenarioOfUrl } from "./verify-fixture.js";

describe("the sample data a verification round opens the console on", () => {
  let client: Client;

  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    await migrate(client);
  });

  afterEach(() => client.close());

  it("@scenario S-R237511TD-01-open a named todo scenario yields a waiting todo of that kind with its content", async () => {
    await applyVerifyFixture(client, fixtureFor("S-R237511TD-01-open"), 9000);

    const waiting = await listPendingTodos(client);
    const approval = waiting.find((todo) => todo.kind === "approve");
    expect(approval).toBeDefined();
    const detail = await readPendingTodo(client, approval!.todoId);
    expect(detail).toMatchObject({
      kind: "approve",
      notionTarget: { kind: "requirement" },
      conclusions: [
        { id: "approve", recommended: false },
        { id: "rework", recommended: false },
      ],
    });
    expect(detail!.sections).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "prd_goal", text: "让本人处理已有待办" }),
    ]));
  });

  it("@scenario S-R237511TD-01-answer the answer scenario yields a waiting question with a suggested answer", async () => {
    await applyVerifyFixture(client, fixtureFor("S-R237511TD-01-answer"), 9000);

    const waiting = await listPendingTodos(client);
    const answer = waiting.find((todo) => todo.kind === "answer");
    expect(answer).toBeDefined();
    const detail = await readPendingTodo(client, answer!.todoId);
    expect(detail).toMatchObject({
      kind: "answer",
      notionTarget: { kind: "story" },
      questions: [{ index: 1, question: "提醒应在什么时候发送？", suggestion: "每天上午九点" }],
    });
  });

  it("@scenario S-R237511TD-01-choose the choice scenario yields a waiting round with its options", async () => {
    await applyVerifyFixture(client, fixtureFor("S-R237511TD-01-choose"), 9000);

    const waiting = await listPendingTodos(client);
    const choice = waiting.find((todo) => todo.kind === "choose");
    expect(choice).toBeDefined();
    const detail = await readPendingTodo(client, choice!.todoId);
    expect(detail).toMatchObject({
      kind: "choose",
      notionTarget: { kind: "requirement" },
      questions: [{ index: 1, question: "待办入口应放在哪里？" }],
    });
    expect(detail!.questions[0]!.options.map((option) => option.id)).toEqual(["A", "B"]);
    expect(detail!.questions[0]!.options.every((option) => option.recommended === false || option.recommended === true)).toBe(true);
  });

  it("@scenario S-R237511TD-01-savefail the save scenario yields a decision still waiting on Notion", async () => {
    await applyVerifyFixture(client, fixtureFor("S-R237511TD-01-savefail"), 9000);

    const waiting = await listPendingTodos(client);
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({
      kind: "answer",
      decision: { status: "awaiting_notion" },
    });
  });

  it("@scenario S-R237511TD-01-existing the scenarios about nothing waiting yield an empty ledger", async () => {
    await applyVerifyFixture(client, fixtureFor("S-R237511TD-01-open"), 9000);
    expect((await listPendingTodos(client)).length).toBeGreaterThan(0);

    await applyVerifyFixture(client, fixtureFor("S-R237511TD-01-existing"), 9000);
    expect(await listPendingTodos(client)).toEqual([]);
  });

  it("an unnamed request keeps the full sample set so a plain page still has something to judge", async () => {
    await applyVerifyFixture(client, fixtureFor(null), 9000);

    const kinds = (await listPendingTodos(client)).map((todo) => todo.kind);
    expect(new Set(kinds)).toEqual(new Set(["answer", "approve", "choose"]));
    expect((await listPendingTodos(client)).some((todo) => todo.decision !== null)).toBe(true);
  });

  it("reads the scenario out of the page request the round opens", () => {
    expect(scenarioOfUrl("/?scenario=S-R237511TD-01-open")).toBe("S-R237511TD-01-open");
    expect(scenarioOfUrl("/")).toBeNull();
    expect(scenarioOfUrl("/api/todos")).toBeNull();
  });
});
