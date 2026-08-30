import { createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate } from "../persistence/migrate.js";
import { NotionEpicPlanDelivery } from "./epic-plan-delivery.js";
import type { NotionGateway } from "./gateway.js";
import type { NotionOutboxRecord } from "./outbox.js";

const PLAN = {
  epicId: "M2",
  businessGoal: "Customers see one review request per initiative.",
  stories: [{ id: "S-M2-01", title: "Split the initiative" }, { id: "S-M2-02", title: "Approve the split" }],
};

function record(operation: string, payload: unknown, overrides: Partial<NotionOutboxRecord> = {}): NotionOutboxRecord {
  return {
    id: 1,
    cardId: "M2",
    operation,
    target: "epic-page",
    payload,
    payloadHash: "a".repeat(64),
    priority: 1,
    ...overrides,
  } as NotionOutboxRecord;
}

describe("NotionEpicPlanDelivery", () => {
  let client: ReturnType<typeof createClient>;
  let requests: Array<{ method: string; path: string; body?: unknown }>;
  let children: unknown[];

  function gateway(): NotionGateway {
    return {
      request: vi.fn(async (request: { method: string; path: string; body?: unknown }) => {
        requests.push(request);
        if (request.method === "GET" && request.path.includes("/children")) {
          return { status: 200, data: { results: children, has_more: false } };
        }
        if (request.path.endsWith("/query")) {
          return { status: 200, data: { results: children, has_more: false } };
        }
        return { status: 200, data: { id: "created-page" } };
      }),
    } as unknown as NotionGateway;
  }

  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    await migrate(client);
    requests = [];
    children = [];
  });

  afterEach(() => client.close());

  describe("present_epic_plan", () => {
    it("puts the decomposition on the Epic page for a human to read", async () => {
      const delivery = new NotionEpicPlanDelivery(gateway(), client, "stories-ds");

      await delivery.send(record("present_epic_plan", PLAN));

      const append = requests.find((request) => request.method === "PATCH");
      const text = JSON.stringify(append?.body);
      expect(append?.path).toContain("epic-page");
      expect(text).toContain("Customers see one review request per initiative.");
      expect(text).toContain("S-M2-01");
      expect(text).toContain("S-M2-02");
      // The marker is what makes a replay a no-op rather than a duplicate plan.
      expect(text).toContain(`hivemind-plan:${"a".repeat(64)}`);
    });

    it("carries the split recommendation when the decomposition made one", async () => {
      const delivery = new NotionEpicPlanDelivery(gateway(), client, "stories-ds");
      await delivery.send(record("present_epic_plan", { ...PLAN, recommendation: "考虑拆分 Epic" }));
      expect(JSON.stringify(requests.at(-1)?.body)).toContain("考虑拆分 Epic");
    });

    it("recognises a plan it already delivered and does not post it twice", async () => {
      children = [{
        id: "block-1",
        type: "paragraph",
        paragraph: { rich_text: [{ plain_text: `hivemind-plan:${"a".repeat(64)}` }] },
      }];
      const delivery = new NotionEpicPlanDelivery(gateway(), client, "stories-ds");

      await expect(delivery.isApplied(record("present_epic_plan", PLAN))).resolves.toBe(true);
    });

    it("posts a revised plan even though an older one is on the page", async () => {
      children = [{
        id: "block-1",
        type: "paragraph",
        paragraph: { rich_text: [{ plain_text: `hivemind-plan:${"b".repeat(64)}` }] },
      }];
      const delivery = new NotionEpicPlanDelivery(gateway(), client, "stories-ds");

      await expect(delivery.isApplied(record("present_epic_plan", PLAN))).resolves.toBe(false);
    });
  });

  describe("create_story_page", () => {
    beforeEach(async () => {
      await client.batch([
        "INSERT INTO epics (id, notion_page_id, title, state, created_at, updated_at) VALUES ('M2','epic-page','Delivery','PLAN_APPROVAL',1,1)",
        `INSERT INTO stories (id, epic_id, notion_page_id, title, requirement, state, repo, target_branch, priority, created_at, updated_at)
           VALUES ('S-M2-01','M2','placeholder-id','Split the initiative','A large initiative becomes reviewable stories.','QUEUED','owner/repo','main',1,1,1)`,
      ], "write");
    });

    it("creates the Story page and replaces the placeholder id with the real one", async () => {
      const delivery = new NotionEpicPlanDelivery(gateway(), client, "stories-ds");

      await delivery.send(record("create_story_page", { epicId: "M2", storyId: "S-M2-01" }, { cardId: "S-M2-01", target: "M2" }));

      const create = requests.find((request) => request.path === "/v1/pages");
      const body = JSON.stringify(create?.body);
      expect(body).toContain("stories-ds");
      expect(body).toContain("S-M2-01");
      expect(body).toContain("Split the initiative");
      expect(body).toContain("epic-page");
      const stored = (await client.execute("SELECT notion_page_id FROM stories WHERE id = 'S-M2-01'")).rows[0];
      expect(stored?.notion_page_id).toBe("created-page");
    });

    it("adopts a page that already carries the task id instead of creating a second one", async () => {
      children = [{ id: "existing-page", properties: { "任务 ID": { rich_text: [{ plain_text: "S-M2-01" }] } } }];
      const delivery = new NotionEpicPlanDelivery(gateway(), client, "stories-ds");

      await expect(delivery.isApplied(record("create_story_page", { epicId: "M2", storyId: "S-M2-01" }, { cardId: "S-M2-01" })))
        .resolves.toBe(true);
      const stored = (await client.execute("SELECT notion_page_id FROM stories WHERE id = 'S-M2-01'")).rows[0];
      expect(stored?.notion_page_id).toBe("existing-page");
      expect(requests.some((request) => request.path === "/v1/pages")).toBe(false);
    });
  });

  it("refuses an operation it does not implement rather than reporting success", async () => {
    const delivery = new NotionEpicPlanDelivery(gateway(), client, "stories-ds");
    await expect(delivery.send(record("sync_story_page", {}))).rejects.toThrow(/unsupported/);
  });
});
