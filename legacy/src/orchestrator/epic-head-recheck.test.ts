import { createClient, type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate } from "../persistence/migrate.js";
import { recheckEpicHeads } from "./epic-head-recheck.js";
import { unrecoveredHeadFailures } from "./epic-head-failure.js";

let client: Client;

async function headFailing(epicId: string, ts: number, headSha = "beef2"): Promise<void> {
  await client.execute({
    sql: `INSERT INTO event_log (run_id, seq, card_id, phase, type, ts, data)
          VALUES (?, (SELECT COALESCE(MAX(seq), -1) + 1 FROM event_log WHERE run_id = ?),
                  NULL, NULL, 'epic.head_failing', ?, ?)`,
    args: [`epic:${epicId}`, `epic:${epicId}`, ts, JSON.stringify({
      storyId: "S-E1-01", headSha, check: "npm test",
      failures: ["src/runner/catalog-snapshot.test.ts > deepseek"],
    })],
  });
}

async function story(lastHumanActionAt: number): Promise<void> {
  await client.execute({
    sql: "INSERT INTO epics (id, notion_page_id, title, state, created_at, updated_at) VALUES ('E1','page-e1','Epic','BLOCKED',1,1)",
    args: [],
  });
  await client.execute({
    sql: `INSERT INTO stories (id, epic_id, notion_page_id, title, requirement, state, last_human_action_at, created_at, updated_at)
          VALUES ('S-E1-01', 'E1', 'page-1', 'Story', 'do the thing', 'MERGE', ?, 1, 1)`,
    args: [lastHumanActionAt],
  });
}

const options = (overrides: Partial<Parameters<typeof recheckEpicHeads>[0]> = {}) => ({
  client,
  checks: { run: vi.fn(async () => ({ passed: true, detail: "" })) },
  worktreePath: (epicId: string) => `/work/epic-${epicId}`,
  headSha: async () => "beef2",
  intervalMs: 3_600_000,
  now: () => 1_000,
  ...overrides,
});

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  await migrate(client);
});

afterEach(() => client.close());

describe("recheckEpicHeads", () => {
  it("does not run the suite again while nothing could have changed", async () => {
    await story(0);
    await headFailing("E1", 900);
    const input = options();

    await expect(recheckEpicHeads(input)).resolves.toEqual([{ epicId: "E1", outcome: "skipped" }]);
    expect(input.checks.run).not.toHaveBeenCalled();
  });

  it("looks again once the Epic head has moved, and clears the block when it passes", async () => {
    await story(0);
    await headFailing("E1", 900);
    const input = options({ headSha: async () => "cafe3" });

    await expect(recheckEpicHeads(input)).resolves.toEqual([{ epicId: "E1", outcome: "recovered" }]);
    expect(input.checks.run).toHaveBeenCalledWith("npm test", "/work/epic-E1");
    await expect(unrecoveredHeadFailures(client)).resolves.toEqual(new Map());
  });

  it("looks again when a person acted on the waiting Story, since a fix on the host moves nothing", async () => {
    await story(950);
    await headFailing("E1", 900);
    const input = options();

    await expect(recheckEpicHeads(input)).resolves.toEqual([{ epicId: "E1", outcome: "recovered" }]);
  });

  it("looks again once the interval has passed", async () => {
    await story(0);
    await headFailing("E1", 900);
    const input = options({ intervalMs: 50 });

    await expect(recheckEpicHeads(input)).resolves.toEqual([{ epicId: "E1", outcome: "recovered" }]);
  });

  it("stays blocked and writes nothing new while the same check fails the same way", async () => {
    await story(0);
    await headFailing("E1", 900);
    const input = options({
      intervalMs: 50,
      checks: { run: vi.fn(async () => ({
        passed: false,
        detail: " FAIL  src/runner/catalog-snapshot.test.ts > deepseek\n",
      })) },
    });

    await expect(recheckEpicHeads(input)).resolves.toEqual([
      { epicId: "E1", outcome: "still_failing", failures: ["src/runner/catalog-snapshot.test.ts > deepseek"] },
    ]);
    const events = (await client.execute("SELECT type FROM event_log WHERE run_id = 'epic:E1'")).rows;
    expect(events).toHaveLength(1);
  });

  it("records the head failure again when a different check result appears", async () => {
    await story(0);
    await headFailing("E1", 900);
    const input = options({
      intervalMs: 50,
      checks: { run: vi.fn(async () => ({ passed: false, detail: " FAIL  src/other.test.ts > something else\n" })) },
    });

    await recheckEpicHeads(input);
    const failure = (await unrecoveredHeadFailures(client)).get("E1");
    expect(failure?.failures).toEqual(["src/other.test.ts > something else"]);
  });
});
