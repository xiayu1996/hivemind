import { createClient, type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listPendingTodos } from "../orchestrator/pending-todo.js";
import { migrate } from "../persistence/migrate.js";
import { applyVerifyFixture } from "./verify-fixture.js";
import * as fixtureContract from "./verify-fixture-contract.js";
import type { VerifyFixtureRequestEffect } from "./verify-fixture-contract.js";

async function applyRequest(
  client: Client,
  method: string,
  url: string,
): Promise<VerifyFixtureRequestEffect> {
  expect(fixtureContract.classifyVerifyFixtureRequest).toBeTypeOf("function");
  const effect = fixtureContract.classifyVerifyFixtureRequest(method, url);
  if (effect.kind === "select") await applyVerifyFixture(client, effect.plan.fixture, 9_000);
  return effect;
}

describe("verification fixture request ownership", () => {
  let client: Client;

  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    await migrate(client);
  });

  afterEach(() => client.close());

  it("@scenario S-R237511TD-02-stable 页面附带的 favicon 读取保留同一条待答复事项", async () => {
    const navigation = await applyRequest(client, "GET", "/todo?scenario=S-R237511TD-02-answer");
    const before = await listPendingTodos(client);
    const asset = await applyRequest(client, "GET", "/favicon.ico");
    const after = await listPendingTodos(client);

    expect(navigation).toMatchObject({
      kind: "select",
      plan: { fixture: "answer", todoRead: "available", decisionDelivery: "confirm" },
    });
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ todoId: "answer:S-R237-ANSWER:q1", title: "提醒应在什么时候发送？" });
    expect(asset).toEqual({ kind: "preserve" });
    expect(after).toEqual(before);
  });

  it("@scenario S-R237511TD-02-stable API 与健康检查即使带场景参数也不得重置当前样例", async () => {
    await applyRequest(client, "GET", "/todo?scenario=S-R237511TD-02-answer");
    const api = await applyRequest(client, "GET", "/api/todos?scenario=S-R237511TD-02-empty");
    const health = await applyRequest(client, "GET", "/health");

    expect(api).toEqual({ kind: "preserve" });
    expect(health).toEqual({ kind: "preserve" });
    expect(await listPendingTodos(client)).toEqual([
      expect.objectContaining({ todoId: "answer:S-R237-ANSWER:q1", kind: "answer" }),
    ]);
  });

  it("@scenario S-R237511TD-02-empty 未指定验收样例的页面导航清除样例并显示真实空状态", async () => {
    await applyVerifyFixture(client, "answer", 9_000);
    expect(await listPendingTodos(client)).toHaveLength(1);

    const navigation = await applyRequest(client, "GET", "/todo");

    expect(navigation).toMatchObject({
      kind: "select",
      plan: { fixture: "empty", todoRead: "available", decisionDelivery: "confirm" },
    });
    expect(await listPendingTodos(client)).toEqual([]);
  });

  it("@scenario S-R237511TD-02-empty 空状态场景不会遗留其他场景的样例待办", async () => {
    await applyVerifyFixture(client, "full", 9_000);
    expect((await listPendingTodos(client)).length).toBeGreaterThan(1);

    const navigation = await applyRequest(client, "GET", "/todo?scenario=S-R237511TD-02-empty");

    expect(navigation).toMatchObject({ kind: "select", plan: { fixture: "empty" } });
    expect(await listPendingTodos(client)).toEqual([]);
  });

  it("@scenario S-R237511TD-02-rejected 被拒绝场景保留一条可提交的待答复事项并拒绝交付", async () => {
    expect(fixtureContract.verifyFixturePlanFor).toBeTypeOf("function");
    const plan = fixtureContract.verifyFixturePlanFor("S-R237511TD-02-rejected");

    expect(plan).toEqual({ fixture: "rejected", todoRead: "available", decisionDelivery: "reject" });
    await applyVerifyFixture(client, plan.fixture, 9_000);
    expect(await listPendingTodos(client)).toEqual([
      expect.objectContaining({
        todoId: "answer:S-R237-ANSWER:q1",
        title: "提醒应在什么时候发送？",
        decision: null,
      }),
    ]);
  });

  it("@scenario S-R237511TD-02-rejected 被拒绝场景不会沿用已处理结果或其他种类待办", async () => {
    await applyVerifyFixture(client, "full", 9_000);
    expect(fixtureContract.verifyFixturePlanFor).toBeTypeOf("function");
    const plan = fixtureContract.verifyFixturePlanFor("S-R237511TD-02-rejected");
    await applyVerifyFixture(client, plan.fixture, 9_000);

    const waiting = await listPendingTodos(client);
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({ kind: "answer", decision: null });
    expect((await client.execute("SELECT COUNT(*) AS count FROM todo_decisions")).rows[0]?.count).toBe(0);
    expect((await client.execute("SELECT COUNT(*) AS count FROM notion_outbox")).rows[0]?.count).toBe(0);
  });
});
