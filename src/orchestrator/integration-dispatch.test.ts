// @scenario S-M2-05-dependency
import { createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../persistence/migrate.js";
import { IntegrationDispatchStore } from "./integration-dispatch.js";

describe("IntegrationDispatchStore", () => {
  let client: ReturnType<typeof createClient>;

  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    await migrate(client);
    await client.execute("INSERT INTO epics (id, notion_page_id, title, state, created_at, updated_at) VALUES ('E-1', 'epic-page', 'Epic', 'EXECUTING', 1, 1)");
    await client.batch([
      { sql: "INSERT INTO stories (id, epic_id, notion_page_id, title, requirement, state, depends_on, created_at, updated_at) VALUES ('S-A', 'E-1', 'page-a', 'A', 'A', 'QUEUED', '[]', 1, 1)" },
      { sql: "INSERT INTO stories (id, epic_id, notion_page_id, title, requirement, state, depends_on, created_at, updated_at) VALUES ('S-B', 'E-1', 'page-b', 'B', 'B', 'QUEUED', '[\"S-A\"]', 1, 1)" },
    ], "write");
  });
  afterEach(() => client.close());

  it("S-M2-05-dependency does not create a dependent Story branch before its dependency is integrated", async () => {
    const store = new IntegrationDispatchStore(client);
    await expect(store.claimStart("S-B", "story/E-1-S-B")).resolves.toEqual({ kind: "blocked", waitingFor: ["S-A"] });
    await expect(client.execute("SELECT branch FROM stories WHERE id = 'S-B'")).resolves.toMatchObject({ rows: [{ branch: null }] });

    await client.execute("UPDATE stories SET state = 'DELIVERED' WHERE id = 'S-A'");
    await expect(store.claimStart("S-B", "story/E-1-S-B")).resolves.toEqual({ kind: "started", integrationBranch: "epic/E-1" });
    await expect(client.execute("SELECT branch, target_branch FROM stories WHERE id = 'S-B'")).resolves.toMatchObject({ rows: [{ branch: "story/E-1-S-B", target_branch: "epic/E-1" }] });
  });
});
