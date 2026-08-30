import { createClient } from "@libsql/client";
import { describe, expect, it, vi } from "vitest";
import { migrate } from "../persistence/migrate.js";
import { EpicBranchFreshness } from "./epic-branch-refresh.js";

describe("@scenario S-M2-06-freshconflict", () => {
  it("records a wrong integration worktree as failed without merging and aborts a conflicted merge back to clean", async () => {
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    await client.execute("INSERT INTO epics (id, notion_page_id, title, state, integration_branch, created_at, updated_at) VALUES ('M2', 'page', 'Fresh', 'EXECUTING', 'epic/M2', 1, 1)");
    const calls: string[][] = [];
    const git = { run: vi.fn(async (_cwd: string, args: string[]) => {
      calls.push(args);
      if (args.join(" ") === "rev-parse origin/main") return "main-revision\n";
      if (args.join(" ") === "branch --show-current") return "main\n";
      return "";
    }) };
    const refresh = new EpicBranchFreshness(client, { worktreePath: "integration", git, now: () => 100_000_000 });

    await expect(refresh.tick()).resolves.toEqual([{ epicId: "M2", outcome: "failed", reason: "integration worktree branch mismatch: expected epic/M2, got main" }]);
    expect(calls.some((args) => args[0] === "merge")).toBe(false);
    expect((await client.execute("SELECT outcome, source_revision, failure_reason FROM epic_branch_refresh_events ORDER BY id")).rows).toEqual([
      { outcome: "attempted", source_revision: "main-revision", failure_reason: null },
      { outcome: "failed", source_revision: "main-revision", failure_reason: "integration worktree branch mismatch: expected epic/M2, got main" },
    ]);
    client.close();
  });

  it("aborts a conflicted merge and records a failed durable outcome", async () => {
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    await client.execute("INSERT INTO epics (id, notion_page_id, title, state, integration_branch, created_at, updated_at) VALUES ('M2', 'page', 'Fresh', 'EXECUTING', 'epic/M2', 1, 1)");
    const calls: string[][] = [];
    const git = { run: vi.fn(async (_cwd: string, args: string[]) => {
      calls.push(args);
      if (args.join(" ") === "rev-parse origin/main") return "main-revision\n";
      if (args.join(" ") === "branch --show-current") return "epic/M2\n";
      if (args.join(" ") === "merge --no-ff origin/main") throw new Error("CONFLICT");
      return "";
    }) };
    const refresh = new EpicBranchFreshness(client, { worktreePath: "integration", git, now: () => 100_000_000 });

    await expect(refresh.tick()).resolves.toEqual([{ epicId: "M2", outcome: "failed", reason: "CONFLICT" }]);
    expect(calls).toContainEqual(["merge", "--abort"]);
    expect((await client.execute("SELECT outcome, failure_reason FROM epic_branch_refresh_events ORDER BY id DESC LIMIT 2")).rows).toEqual([
      { outcome: "failed", failure_reason: "CONFLICT" },
      { outcome: "attempted", failure_reason: null },
    ]);
    client.close();
  });
});
