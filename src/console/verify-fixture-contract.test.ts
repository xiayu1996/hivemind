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
});
