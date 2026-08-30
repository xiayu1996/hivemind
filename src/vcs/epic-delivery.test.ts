import { createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate } from "../persistence/migrate.js";
import { EpicMrDelivery } from "./epic-delivery.js";

const commits = [
  "test(S-M2-06-alpha): red",
  "feat(S-M2-06-alpha): green",
  "test(S-M2-06-beta): red",
  "feat(S-M2-06-beta): green",
];

describe("@scenario S-M2-06-epicmr", () => {
  let client: ReturnType<typeof createClient>;

  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    await migrate(client);
    await client.batch([
      { sql: "INSERT INTO epics (id, notion_page_id, title, state, repo, integration_branch, created_at, updated_at) VALUES ('M2', 'epic-page', 'Delivery', 'EXECUTING', 'owner/repo', 'epic/M2', 1, 1)" },
      { sql: "INSERT INTO stories (id, epic_id, notion_page_id, title, requirement, state, created_at, updated_at) VALUES ('S-M2-06-alpha', 'M2', 'story-alpha', 'Alpha', 'First outcome', 'DELIVERED', 1, 1)" },
      { sql: "INSERT INTO stories (id, epic_id, notion_page_id, title, requirement, state, created_at, updated_at) VALUES ('S-M2-06-beta', 'M2', 'story-beta', 'Beta', 'Second outcome', 'DELIVERED', 2, 2)" },
      { sql: "INSERT INTO phase_runs (run_id, card_id, phase, round, prompt_sha256, status, started_at, ended_at) VALUES ('merge-alpha', 'S-M2-06-alpha', 'MERGE', 1, '0000000000000000000000000000000000000000000000000000000000000000', 'completed', 1, 1)" },
      { sql: "INSERT INTO phase_runs (run_id, card_id, phase, round, prompt_sha256, status, started_at, ended_at) VALUES ('merge-beta', 'S-M2-06-beta', 'MERGE', 1, '0000000000000000000000000000000000000000000000000000000000000000', 'completed', 2, 2)" },
      { sql: "INSERT INTO phase_artifacts (run_id, card_id, phase, round, kind, body, created_at) VALUES ('merge-alpha', 'S-M2-06-alpha', 'MERGE', 1, 'delivery-report', 'Alpha verification passed.', 1)" },
      { sql: "INSERT INTO phase_artifacts (run_id, card_id, phase, round, kind, body, created_at) VALUES ('merge-beta', 'S-M2-06-beta', 'MERGE', 1, 'delivery-report', 'Beta verification passed.', 2)" },
    ], "write");
  });
  afterEach(() => client.close());

  it("creates one stable Epic MR with ordered Story chapters and red-to-green evidence", async () => {
    const git = { run: vi.fn(async (_cwd: string, args: string[]) => args[0] === "log" ? `${commits.join("\n")}\n` : "") };
    const create = vi.fn(async () => ({ url: "https://github.com/owner/repo/pull/42", provider: "github" as const }));
    const delivery = new EpicMrDelivery(client, { create }, { worktreePath: "integration", git, now: () => 3 });

    await expect(delivery.deliver("M2")).resolves.toEqual({ mrUrl: "https://github.com/owner/repo/pull/42" });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      repository: "owner/repo", sourceBranch: "epic/M2", targetBranch: "main",
      body: "# Epic M2: Delivery\n\n## S-M2-06-alpha: Alpha\n\nOutcome: First outcome\n\nVerification: Alpha verification passed.\n\nEvidence: `test(S-M2-06-alpha): red` -> `feat(S-M2-06-alpha): green`\n\n## S-M2-06-beta: Beta\n\nOutcome: Second outcome\n\nVerification: Beta verification passed.\n\nEvidence: `test(S-M2-06-beta): red` -> `feat(S-M2-06-beta): green`\n",
    }));
    await expect(delivery.deliver("M2")).resolves.toEqual({ mrUrl: "https://github.com/owner/repo/pull/42" });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("refuses a missing or out-of-order red-to-green pair instead of representing the Story as delivered", async () => {
    const git = { run: vi.fn(async () => "feat(S-M2-06-alpha): green\ntest(S-M2-06-alpha): red\n") };
    const create = vi.fn();
    const delivery = new EpicMrDelivery(client, { create }, { worktreePath: "integration", git });

    await expect(delivery.deliver("M2")).rejects.toThrow("invalid red-to-green evidence for Story S-M2-06-alpha");
    expect(create).not.toHaveBeenCalled();
  });
});
