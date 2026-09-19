import { createClient, type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../persistence/migrate.js";
import { listPendingTodos } from "../orchestrator/pending-todo.js";
import { applyVerifyFixture, fixtureFor } from "./verify-fixture.js";

/**
 * The waiting state each todo scenario is judged on, re-established on the
 * branch the regression loop rebased onto the Epic head.
 *
 * The Epic head already carries the fixes these scenarios needed, so their
 * first red/green commits sit below the point the branch now shares with the
 * Epic. These tests state the same behaviour again on this branch: each one
 * asserts the ledger state its scenario opens on, so a change that quietly
 * removes one of those states is red here before it is red on a screen.
 */
describe("the waiting state each todo scenario is judged on", () => {
  let client: Client;

  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    await migrate(client);
  });

  afterEach(() => client.close());
  it("@scenario S-R237511TD-01-open the open scenario is judged on a waiting approval", async () => {
    await applyVerifyFixture(client, fixtureFor("S-R237511TD-01-open"), 9000);

    expect((await listPendingTodos(client)).map((todo) => todo.kind)).toContain("approve");
  });

  it("@scenario S-R237511TD-01-answer the answer scenario is judged on a waiting question", async () => {
    await applyVerifyFixture(client, fixtureFor("S-R237511TD-01-answer"), 9000);

    expect((await listPendingTodos(client)).map((todo) => todo.kind)).toContain("answer");
  });

  it("@scenario S-R237511TD-01-approve the approve scenario is judged on a waiting approval", async () => {
    await applyVerifyFixture(client, fixtureFor("S-R237511TD-01-approve"), 9000);

    expect((await listPendingTodos(client)).map((todo) => todo.kind)).toContain("approve");
  });

  it("@scenario S-R237511TD-01-choose the choose scenario is judged on a waiting choice", async () => {
    await applyVerifyFixture(client, fixtureFor("S-R237511TD-01-choose"), 9000);

    expect((await listPendingTodos(client)).map((todo) => todo.kind)).toContain("choose");
  });

  it("@scenario S-R237511TD-01-savefail the save scenario is judged on a decision still waiting on Notion", async () => {
    await applyVerifyFixture(client, fixtureFor("S-R237511TD-01-savefail"), 9000);

    expect((await listPendingTodos(client))[0]?.decision?.status).toBe("awaiting_notion");
  });

  it("@scenario S-R237511TD-01-loading the loading scenario is judged on a ledger with nothing waiting", async () => {
    expect(fixtureFor("S-R237511TD-01-loading")).toBe("empty");
    await applyVerifyFixture(client, fixtureFor("S-R237511TD-01-loading"), 9000);

    expect(await listPendingTodos(client)).toEqual([]);
  });

  it("@scenario S-R237511TD-01-error the failed-read scenario is its own state, not the empty ledger", async () => {
    expect(fixtureFor("S-R237511TD-01-error")).toBe("error");
    await applyVerifyFixture(client, fixtureFor("S-R237511TD-01-error"), 9000);

    expect(await listPendingTodos(client)).toEqual([]);
  });

});
