import { createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../persistence/migrate.js";
import { NotionGateway, type NotionTransport } from "./gateway.js";
import { NotionUserDirectory } from "./user-directory.js";

const USER_ID = "2b230c4d-8483-4a56-be1c-d6807e9e1804";

describe("NotionUserDirectory", () => {
  let client: ReturnType<typeof createClient>;
  let requested: string[];

  function directory(reply: (path: string) => { status: number; data: unknown }): NotionUserDirectory {
    const transport: NotionTransport = async (request) => {
      requested.push(request.path);
      return reply(request.path);
    };
    return new NotionUserDirectory(
      client,
      new NotionGateway({ transport, ratePerSecond: 1_000_000, mergeWindowMs: 0 }),
      () => 5_000,
    );
  }

  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    await migrate(client);
    requested = [];
  });

  afterEach(() => client.close());

  it("puts a person's name on what they wrote, and asks Notion only once", async () => {
    const users = directory(() => ({ status: 200, data: { object: "user", id: USER_ID, name: "雨 夏" } }));

    await expect(users.displayName(USER_ID)).resolves.toBe("雨 夏");
    await expect(users.displayName(USER_ID)).resolves.toBe("雨 夏");
    expect(requested).toHaveLength(1);
  });

  it("remembers across instances, so a restart does not re-ask", async () => {
    await directory(() => ({ status: 200, data: { object: "user", id: USER_ID, name: "雨 夏" } }))
      .displayName(USER_ID);
    requested = [];

    const second = directory(() => {
      throw new Error("a cached name must not cost another request");
    });
    await expect(second.displayName(USER_ID)).resolves.toBe("雨 夏");
    expect(requested).toEqual([]);
  });

  it("falls back to the id when the workspace will not say, and keeps trying later", async () => {
    const users = directory(() => ({ status: 403, data: { message: "insufficient permissions" } }));

    await expect(users.displayName(USER_ID)).resolves.toBe(USER_ID);
    expect((await client.execute("SELECT COUNT(*) AS count FROM notion_users")).rows[0]?.count).toBe(0);
    await expect(users.displayName(USER_ID)).resolves.toBe(USER_ID);
    expect(requested.length).toBeGreaterThan(1);
  });

  it("treats a nameless account as unnamed rather than inventing something", async () => {
    const users = directory(() => ({ status: 200, data: { object: "user", id: USER_ID, name: null } }));
    await expect(users.displayName(USER_ID)).resolves.toBe(USER_ID);
  });
});
