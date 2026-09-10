import { createClient } from "@libsql/client";
import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../persistence/migrate.js";
import { LibsqlConsoleDataSource } from "./libsql-data-source.js";
import { createConsoleServer, type ConsoleDataSource } from "./server.js";

describe("S-E1ACTION-01-ignorecomments", () => {
  let client: ReturnType<typeof createClient>;

  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    await migrate(client);
  });

  afterEach(() => client.close());

  // @scenario S-E1ACTION-01-ignorecomments
  it("does not turn an unresolved Notion comment into a pending response", async () => {
    await client.execute({
      sql: `INSERT INTO ingested_comments (comment_id, page_id, author, body, created_time, ingested_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: ["comment-1", "notion-page-1", "operator", "Can someone answer this?", 10, 10],
    });

    const source = new LibsqlConsoleDataSource(client, async () => []);
    await expect(source.workStatus()).resolves.toMatchObject({ pendingResponses: [] });
  });

  // @scenario S-E1ACTION-01-mixedempty
  it("reports distinct successful empty states when no gate or active requirement exists", async () => {
    const source = new LibsqlConsoleDataSource(client, async () => []);
    await expect(source.workStatus()).resolves.toEqual({
      status: "success",
      pendingResponseState: "no_pending_responses",
      pendingResponses: [],
      activeRequirementState: "no_active_requirements",
      activeRequirements: [],
    });
  });

  // @scenario S-E1ACTION-01-nopending
  it("keeps the pending-response section explicit when no centrally recorded human gate exists", async () => {
    const source = new LibsqlConsoleDataSource(client, async () => []);
    await expect(source.workStatus()).resolves.toMatchObject({
      status: "success",
      pendingResponseState: "no_pending_responses",
      pendingResponses: [],
    });
    await expect(readFile("console-ui/src/App.vue", "utf8")).resolves.toContain("No pending responses");
  });

  // @scenario S-E1ACTION-01-pending
  it("lists a centrally recorded human gate before active requirements with its action, object, phase, and destination", async () => {
    await client.batch([
      { sql: `INSERT INTO requirements (id, notion_page_id, title, state, original_request, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`, args: ["requirement-1", "requirement-page-1", "Status overview", "EXECUTING", "Show work status", 1, 5] },
      { sql: `INSERT INTO human_gates (id, object_type, object_id, required_action, phase, navigation_target, priority, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, args: ["gate-1", "requirement", "requirement-1", "Approve the plan", "PRD_CONFIRM", "/requirements/requirement-1", 0, 2, 2] },
    ], "write");

    const source = new LibsqlConsoleDataSource(client, async () => []);
    await expect(source.workStatus()).resolves.toMatchObject({
      pendingResponses: [{
        requiredAction: "Approve the plan",
        relatedRequirementOrObject: "Status overview",
        currentPhase: "PRD_CONFIRM",
        navigationTarget: "/requirements/requirement-1",
      }],
      activeRequirements: [{ id: "requirement-1" }],
    });
  });

  // @scenario S-E1ACTION-01-readfailure
  it("returns an observable loading failure rather than empty sections when projection fails", async () => {
    const failingData: ConsoleDataSource = {
      nodes: async () => [], tasks: async () => [], costs: async () => [], config: async () => [],
      stats: async () => ({}), providers: async () => [],
      workStatus: async () => { throw new Error("database unavailable"); },
    };
    const app = await createConsoleServer(failingData, { serveUi: false });
    const response = await app.inject({ method: "GET", url: "/api/work-status" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "work_status_unavailable", retry: true });
    await app.close();
    await expect(readFile("console-ui/src/App.vue", "utf8")).resolves.toContain("Retry");
  });

  // @scenario S-E1ACTION-01-noactive
  it("keeps the active-requirements section explicit when no requirement is executing", async () => {
    await client.batch([
      {
        sql: `INSERT INTO requirements (id, notion_page_id, title, state, original_request, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: ["requirement-1", "requirement-page-1", "Awaiting clarification", "CLARIFY", "Clarify the request", 1, 1],
      },
      {
        sql: `INSERT INTO human_gates (id, object_type, object_id, required_action, phase, navigation_target, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: ["gate-1", "story", "story-1", "Answer the question", "CODE", "/tasks/story-1", 1, 1],
      },
    ], "write");

    const source = new LibsqlConsoleDataSource(client, async () => []);
    await expect(source.workStatus()).resolves.toMatchObject({
      activeRequirementState: "no_active_requirements",
      activeRequirements: [],
    });
    await expect(readFile("console-ui/src/App.vue", "utf8")).resolves.toContain("No active requirements");
  });
});
