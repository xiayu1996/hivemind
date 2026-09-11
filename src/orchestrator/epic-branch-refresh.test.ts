import { createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate } from "../persistence/migrate.js";
import { EpicBranchFreshness } from "./epic-branch-refresh.js";

describe("@scenario S-M2-06-freshness", () => {
  let client: ReturnType<typeof createClient>;
  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    await migrate(client);
    await client.execute("INSERT INTO epics (id, notion_page_id, title, state, integration_branch, created_at, updated_at) VALUES ('M2', 'page', 'Fresh', 'EXECUTING', 'epic/M2', 1, 1)");
  });
  afterEach(() => client.close());

  it("merges current main only into a due clean Epic branch and records attempted and succeeded events", async () => {
    const calls: string[][] = [];
    const git = { run: vi.fn(async (_cwd: string, args: string[]) => {
      calls.push(args);
      if (args.join(" ") === "rev-parse origin/main") return "main-revision\n";
      if (args.join(" ") === "branch --show-current") return "epic/M2\n";
      return "";
    }) };
    const refresh = new EpicBranchFreshness(client, { worktreePath: "integration", git, intervalMs: 86_400_000, now: () => 100_000_000 });

    await expect(refresh.tick()).resolves.toEqual([{ epicId: "M2", outcome: "succeeded" }]);
    expect(calls).toContainEqual(["merge", "--no-ff", "origin/main"]);
    expect(calls.some((args) => args[0] === "switch" || args[0] === "checkout" || args.includes("main") && args[0] === "merge" && args[1] !== "--no-ff")).toBe(false);
    expect((await client.execute("SELECT outcome, epic_id, source_revision, ts, failure_reason FROM epic_branch_refresh_events ORDER BY id")).rows).toEqual([
      { outcome: "attempted", epic_id: "M2", source_revision: "main-revision", ts: 100_000_000, failure_reason: null },
      { outcome: "succeeded", epic_id: "M2", source_revision: "main-revision", ts: 100_000_000, failure_reason: null },
    ]);
  });

  it("keeps refreshing an Epic that is waiting for a person to merge it", async () => {
    // The window the old filter abandoned: E1ACTION sat in review for a day,
    // main took 28 commits, and the review request rotted into a conflict
    // nothing was watching.
    await client.execute("UPDATE epics SET state = 'EPIC_ACCEPT' WHERE id = 'M2'");
    const calls: string[][] = [];
    const git = { run: vi.fn(async (_cwd: string, args: string[]) => {
      calls.push(args);
      if (args.join(" ") === "rev-parse origin/main") return "main-revision\n";
      if (args.join(" ") === "branch --show-current") return "epic/M2\n";
      return "";
    }) };
    const refresh = new EpicBranchFreshness(client, { worktreePath: "integration", git, intervalMs: 86_400_000, now: () => 100_000_000 });

    await expect(refresh.tick()).resolves.toEqual([{ epicId: "M2", outcome: "succeeded" }]);
    expect(calls).toContainEqual(["merge", "--no-ff", "origin/main"]);
  });

  it("leaves a finished Epic alone", async () => {
    await client.execute("UPDATE epics SET state = 'DONE' WHERE id = 'M2'");
    const git = { run: vi.fn(async () => "") };
    const refresh = new EpicBranchFreshness(client, { worktreePath: "integration", git, now: () => 100_000_000 });

    await expect(refresh.tick()).resolves.toEqual([]);
    expect(git.run).not.toHaveBeenCalled();
  });

  it("records skipped before the daily interval elapses from the durable successful event", async () => {
    await client.execute("INSERT INTO epic_branch_refresh_events (epic_id, outcome, source_revision, ts) VALUES ('M2', 'succeeded', 'old-main', 50000000)");
    const git = { run: vi.fn(async (_cwd: string, args: string[]) => args[0] === "branch" ? "epic/M2\n" : "new-main\n") };
    const refresh = new EpicBranchFreshness(client, { worktreePath: "integration", git, intervalMs: 86_400_000, now: () => 100_000_000 });

    await expect(refresh.tick()).resolves.toEqual([{ epicId: "M2", outcome: "skipped" }]);
    expect(git.run).not.toHaveBeenCalledWith("integration", ["merge", "--no-ff", "origin/main"]);
  });
});


describe("@scenario S-M2-06-freshness refreshing from the remote", () => {
  it("fetches before it decides what main is, and merges the remote ref", async () => {
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    await client.execute(
      "INSERT INTO epics (id, notion_page_id, title, state, integration_branch, created_at, updated_at) VALUES ('M2','p','M2','EXECUTING','epic/M2',1,1)",
    );
    const calls: string[][] = [];
    const git = { run: vi.fn(async (_cwd: string, args: string[]) => {
      calls.push(args);
      if (args[0] === "branch") return "epic/M2\n";
      if (args[0] === "rev-parse") return "remote-revision\n";
      return "";
    }) };

    const results = await new EpicBranchFreshness(client, {
      worktreePath: "integration",
      git,
      now: () => 1_000,
    }).tick();

    expect(results).toMatchObject([{ epicId: "M2", outcome: "succeeded" }]);
    const fetchIndex = calls.findIndex((args) => args[0] === "fetch");
    const revParseIndex = calls.findIndex((args) => args[0] === "rev-parse");
    expect(fetchIndex).toBeGreaterThanOrEqual(0);
    expect(fetchIndex).toBeLessThan(revParseIndex);
    expect(calls.find((args) => args[0] === "rev-parse")).toEqual(["rev-parse", "origin/main"]);
    expect(calls.find((args) => args[0] === "merge")).toEqual(["merge", "--no-ff", "origin/main"]);
    client.close();
  });

  it("follows the configured main branch instead of assuming the name", async () => {
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    await client.execute(
      "INSERT INTO epics (id, notion_page_id, title, state, integration_branch, created_at, updated_at) VALUES ('M2','p','M2','EXECUTING','epic/M2',1,1)",
    );
    const calls: string[][] = [];
    const git = { run: vi.fn(async (_cwd: string, args: string[]) => {
      calls.push(args);
      return args[0] === "branch" ? "epic/M2\n" : "";
    }) };

    await new EpicBranchFreshness(client, {
      worktreePath: "integration",
      git,
      mainBranch: "trunk",
      now: () => 1_000,
    }).tick();

    expect(calls.find((args) => args[0] === "merge")).toEqual(["merge", "--no-ff", "origin/trunk"]);
    client.close();
  });

  it("reports a fetch the network refused as this refresh failing, without touching the branch", async () => {
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    await client.execute(
      "INSERT INTO epics (id, notion_page_id, title, state, integration_branch, created_at, updated_at) VALUES ('M2','p','M2','EXECUTING','epic/M2',1,1)",
    );
    const git = { run: vi.fn(async (_cwd: string, args: string[]) => {
      if (args[0] === "fetch") throw new Error("fatal: unable to access github.com: SSL_ERROR_SYSCALL");
      return "";
    }) };
    const refresh = new EpicBranchFreshness(client, { worktreePath: "integration", git, intervalMs: 86_400_000, now: () => 100_000_000 });

    const [result] = await refresh.tick();
    expect(result).toMatchObject({ epicId: "M2", outcome: "failed" });
    expect((result as { reason?: string }).reason).toContain("SSL_ERROR_SYSCALL");
    expect(git.run.mock.calls.some(([, args]) => args[0] === "merge")).toBe(false);
    client.close();
  });
});
