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

  // @scenario S-E1ACTION-04-progress
  it("S-E1ACTION-04-progress shows the selected Story phase, work, duration, and sanitized progress", async () => {
    const phaseStartedAt = 1_700_000_000_000;
    await client.batch([
      { sql: `INSERT INTO requirements (id, notion_page_id, title, state, original_request, created_at, updated_at)
              VALUES ('requirement-progress', 'requirement-page-progress', 'Show activity summary', 'EXECUTING', 'Show activity summary', ?, ?)`, args: [phaseStartedAt, phaseStartedAt] },
      { sql: `INSERT INTO epics (id, notion_page_id, title, state, requirement_id, created_at, updated_at)
              VALUES ('EPIC-progress', 'epic-page-progress', 'Activity', 'EXECUTING', 'requirement-progress', ?, ?)`, args: [phaseStartedAt, phaseStartedAt] },
      { sql: `INSERT INTO stories (id, epic_id, notion_page_id, title, requirement, state, phase, phase_started_at, created_at, updated_at)
              VALUES ('S-E1ACTION-04', 'EPIC-progress', 'story-page-progress', 'Add activity summary', 'Show activity summary', 'CODE', 'CODE', ?, ?, ?)`, args: [phaseStartedAt, phaseStartedAt, phaseStartedAt] },
      { sql: `INSERT INTO event_log (run_id, seq, card_id, phase, type, ts, data)
              VALUES ('code-run', 0, 'S-E1ACTION-04', 'CODE', 'rpc.tool_call', ?, '{"timestamp":1760000000000}')`, args: [phaseStartedAt] },
    ], "write");

    const source = new LibsqlConsoleDataSource(client, async () => [], () => phaseStartedAt + 125 * 60_000);
    await expect(source.workStatus()).resolves.toMatchObject({
      activeRequirementState: "available",
      activeRequirements: [{
        id: "requirement-progress",
        title: "Show activity summary",
        storyId: "S-E1ACTION-04",
        phase: "CODE",
        workingOn: "Add activity summary",
        activeFor: "2 hours 5 minutes",
        latestProgress: "CODE started",
      }],
    });
    // Raw RPC events and epoch timestamps never reach the summary text.
    const projection = JSON.stringify(await source.workStatus());
    for (const excluded of ["rpc.tool_call", "1760000000000"]) {
      expect(projection).not.toContain(excluded);
    }

    const ui = await readFile("console-ui/src/App.vue", "utf8");
    for (const label of ["Working on", "Active for", "Latest progress", "View details"]) expect(ui).toContain(label);
    for (const excluded of ["Last updated:", "rpc.tool_call", "updated_at"]) expect(ui).not.toContain(excluded);
  });

  // @scenario S-E1ACTION-04-progress
  it("S-E1ACTION-04-progress skips an active requirement whose only Story has no phase start", async () => {
    await client.batch([
      { sql: `INSERT INTO requirements (id, notion_page_id, title, state, original_request, created_at, updated_at)
              VALUES ('requirement-no-start', 'requirement-page-no-start', 'Unowned summary', 'EXECUTING', 'Unowned summary', ?, ?)`, args: [1, 1] },
      { sql: `INSERT INTO epics (id, notion_page_id, title, state, requirement_id, created_at, updated_at)
              VALUES ('EPIC-no-start', 'epic-page-no-start', 'Activity', 'EXECUTING', 'requirement-no-start', ?, ?)`, args: [1, 1] },
      { sql: `INSERT INTO stories (id, epic_id, notion_page_id, title, requirement, state, phase, phase_started_at, created_at, updated_at)
              VALUES ('S-NOSTART-01', 'EPIC-no-start', 'story-page-no-start', 'Legacy activity card', 'Unowned summary', 'CODE', 'CODE', NULL, ?, ?)`, args: [1, 1] },
    ], "write");

    const source = new LibsqlConsoleDataSource(client, async () => [], () => 1_700_000_000_000);
    await expect(source.workStatus()).resolves.toMatchObject({
      activeRequirementState: "no_active_requirements",
      activeRequirements: [],
    });
  });

  // @scenario S-E1ACTION-04-selection
  it("S-E1ACTION-04-selection summarizes a requirement by its most recently started active Story", async () => {
    const older = 1_700_000_000_000;
    const latest = 1_700_000_600_000;
    await client.batch([
      { sql: `INSERT INTO requirements (id, notion_page_id, title, state, original_request, created_at, updated_at)
              VALUES ('requirement-selection', 'requirement-page-selection', 'Summarize current activity', 'EXECUTING', 'Summarize current activity', ?, ?)`, args: [older, older] },
      { sql: `INSERT INTO epics (id, notion_page_id, title, state, requirement_id, created_at, updated_at)
              VALUES ('EPIC-selection', 'epic-page-selection', 'Activity', 'EXECUTING', 'requirement-selection', ?, ?)`, args: [older, older] },
      { sql: `INSERT INTO stories (id, epic_id, notion_page_id, title, requirement, state, phase, phase_started_at, created_at, updated_at)
              VALUES ('S-OLDER-01', 'EPIC-selection', 'story-page-older', 'Verify activity card', 'Summarize current activity', 'VERIFY', 'VERIFY', ?, ?, ?)`, args: [older, older, older] },
      { sql: `INSERT INTO stories (id, epic_id, notion_page_id, title, requirement, state, phase, phase_started_at, created_at, updated_at)
              VALUES ('S-E1ACTION-04', 'EPIC-selection', 'story-page-code', 'Implement activity card', 'Summarize current activity', 'CODE', 'CODE', ?, ?, ?)`, args: [latest, latest, latest] },
      { sql: `INSERT INTO stories (id, epic_id, notion_page_id, title, requirement, state, phase, phase_started_at, created_at, updated_at)
              VALUES ('S-WAIT-01', 'EPIC-selection', 'story-page-wait', 'Waiting for human answer', 'Summarize current activity', 'NEEDS_INPUT', NULL, ?, ?, ?)`, args: [latest + 3000, latest + 3000, latest + 3000] },
      { sql: `INSERT INTO stories (id, epic_id, notion_page_id, title, requirement, state, phase, phase_started_at, created_at, updated_at)
              VALUES ('S-FAIL-01', 'EPIC-selection', 'story-page-fail', 'Failed export', 'Summarize current activity', 'FAILED', NULL, ?, ?, ?)`, args: [latest + 2000, latest + 2000, latest + 2000] },
      { sql: `INSERT INTO stories (id, epic_id, notion_page_id, title, requirement, state, phase, phase_started_at, created_at, updated_at)
              VALUES ('S-DONE-01', 'EPIC-selection', 'story-page-done', 'Delivered export', 'Summarize current activity', 'DELIVERED', NULL, ?, ?, ?)`, args: [latest + 1000, latest + 1000, latest + 1000] },
    ], "write");

    const source = new LibsqlConsoleDataSource(client, async () => [], () => latest);
    const { activeRequirementState, activeRequirements } = await source.workStatus() as {
      activeRequirementState: string;
      activeRequirements: Array<Record<string, unknown>>;
    };
    expect(activeRequirementState).toBe("available");
    expect(activeRequirements).toHaveLength(1);
    expect(activeRequirements[0]).toMatchObject({
      id: "requirement-selection",
      title: "Summarize current activity",
      storyId: "S-E1ACTION-04",
      phase: "CODE",
      workingOn: "Implement activity card",
      latestProgress: "CODE started",
    });
    const projected = JSON.stringify(activeRequirements);
    for (const excluded of ["Waiting for human answer", "Failed export", "Delivered export", "Verify activity card", "S-WAIT-01", "S-FAIL-01", "S-DONE-01", "S-OLDER-01"]) {
      expect(projected).not.toContain(excluded);
    }
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
