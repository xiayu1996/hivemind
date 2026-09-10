import { createClient } from "@libsql/client";
import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../persistence/migrate.js";
import { LibsqlConsoleDataSource } from "./libsql-data-source.js";
import { createConsoleServer, type ConsoleDataSource } from "./server.js";

const decision = {
  recommendedChoice: "Only export paid customers",
  recommendationReason: "This meets the current contract scope first",
  otherOptions: JSON.stringify(["Export all customers"]),
  confirmationReason: "Customer scope changes contractual commitments and needs an owner decision",
};

async function insertOpenGate(client: ReturnType<typeof createClient>, overrides: Partial<typeof decision> = {}) {
  const values = { ...decision, ...overrides };
  await client.batch([
    { sql: `INSERT INTO requirements (id, notion_page_id, title, state, original_request, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO NOTHING`, args: ["requirement-exports", "requirement-page-exports", "Export customers", "EXECUTING", "Export customers", 1, 1] },
    { sql: `INSERT INTO human_gates (
              id, object_type, object_id, required_action, phase, recommended_choice,
              recommendation_reason, other_options, confirmation_reason, navigation_target, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, args: [
      "gate-exports", "requirement", "requirement-exports", "Which customers should be exported?", "DESIGN",
      values.recommendedChoice, values.recommendationReason, values.otherOptions, values.confirmationReason,
      "/requirements/requirement-exports", 1, 1,
    ] },
  ], "write");
}

describe("work status", () => {
  let client: ReturnType<typeof createClient>;

  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    await migrate(client);
  });

  afterEach(() => client.close());

  // @scenario S-E1ACTION-03-decisiondetails
  it("S-E1ACTION-03-decisiondetails projects only complete decision details and the handling link", async () => {
    await insertOpenGate(client);

    const source = new LibsqlConsoleDataSource(client, async () => []);
    await expect(source.workStatus()).resolves.toMatchObject({
      pendingResponses: [{
        requiredAction: "Which customers should be exported?",
        recommendedChoice: decision.recommendedChoice,
        recommendationReason: decision.recommendationReason,
        otherOptions: ["Export all customers"],
        whereThisArose: "DESIGN",
        confirmationReason: decision.confirmationReason,
        navigationTarget: "/requirements/requirement-exports",
      }],
    });
    const app = await createConsoleServer(source, { serveUi: false });
    await expect(app.inject({ method: "GET", url: "/api/work-status" }).then((response) => response.json())).resolves.toMatchObject({
      pendingResponses: [{ recommendedChoice: decision.recommendedChoice, otherOptions: ["Export all customers"] }],
    });
    await app.close();

    const ui = await readFile("console-ui/src/App.vue", "utf8");
    for (const label of ["Recommended choice", "Why this is recommended", "Other options", "Where this arose", "Why you need to confirm", "Open handling location"]) {
      expect(ui).toContain(label);
    }
    for (const excluded of ["Started waiting:", "Waiting for", "Context", "{{ gate.otherOptions }}", "{{ gate.id }}"]) {
      expect(ui).not.toContain(excluded);
    }
  });

  // @scenario S-E1ACTION-03-incompletedetails
  it("S-E1ACTION-03-incompletedetails makes the entire view unavailable for missing, empty, or duplicate decision details", async () => {
    await insertOpenGate(client, { recommendationReason: "" });
    const source = new LibsqlConsoleDataSource(client, async () => []);
    await expect(source.workStatus()).rejects.toThrow("incomplete open human gate");

    const app = await createConsoleServer(source, { serveUi: false });
    const response = await app.inject({ method: "GET", url: "/api/work-status" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "work_status_unavailable", retry: true });
    expect(response.json()).not.toHaveProperty("pendingResponses");
    await app.close();

    await client.execute("DELETE FROM human_gates");
    await insertOpenGate(client, { otherOptions: JSON.stringify([decision.recommendedChoice]) });
    await expect(source.workStatus()).rejects.toThrow("incomplete open human gate");

    const ui = await readFile("console-ui/src/App.vue", "utf8");
    expect(ui).toContain("Unable to load work status: {{ error }}");
    expect(ui).toContain("Retry");
    expect(ui).toContain('<div v-if="error"');
  });

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
  });
});
