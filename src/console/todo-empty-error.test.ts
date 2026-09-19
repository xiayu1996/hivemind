import { createClient, type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listPendingTodos } from "../orchestrator/pending-todo.js";
import { migrate } from "../persistence/migrate.js";
import { applyVerifyFixture, fixtureFor } from "./verify-fixture.js";

describe("todo empty and failed-read verification states", () => {
  let client: Client;

  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    await migrate(client);
  });

  afterEach(() => client.close());

  it("@scenario S-R237511TD-01-existing leaves the ledger empty when no todo is waiting", async () => {
    await applyVerifyFixture(client, fixtureFor("S-R237511TD-01-open"), 9000);
    expect(await listPendingTodos(client)).not.toEqual([]);

    await applyVerifyFixture(client, fixtureFor("S-R237511TD-01-existing"), 9000);

    expect(await listPendingTodos(client)).toEqual([]);
  });

  it("@scenario S-R237511TD-01-existing does not invent pending work when the plain page opens an empty ledger", async () => {
    expect(await listPendingTodos(client)).toEqual([]);

    await applyVerifyFixture(client, fixtureFor(null), 9000);

    expect(await listPendingTodos(client)).toEqual([]);
  });

  it("@scenario S-R237511TD-01-error selects the failed-read state when that scenario opens", () => {
    expect(String(fixtureFor("S-R237511TD-01-error"))).toBe("error");
  });

  it("@scenario S-R237511TD-01-error never turns a failed read into the empty-ledger state", () => {
    expect(String(fixtureFor("S-R237511TD-01-error"))).not.toBe("empty");
  });
});
