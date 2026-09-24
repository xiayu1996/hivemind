import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { planSchema } from "../domain/plan.ts";
import { openDatabase, type OpenedDatabase } from "./db.ts";
import { Store, type NewRequirement } from "./store.ts";

const requirement: NewRequirement = {
  id: "R1",
  boardRef: "board-1",
  repo: "todo-app",
  title: "待办清单",
  body: "做一个待办清单",
  recipe: "greenfield",
  budgetUsd: 20,
  branch: "hivemind/R1",
};

const plan = planSchema.parse({
  items: [
    { id: "scaffold", kind: "enabling", title: "搭地基", goal: "g" },
    { id: "list", kind: "feature", title: "列表", goal: "g", covers: ["A1"], dependsOn: ["scaffold"] },
  ],
});

let opened: OpenedDatabase;
let store: Store;
let clock = 0;

beforeEach(async () => {
  opened = await openDatabase(":memory:");
  clock = Date.parse("2026-09-24T00:00:00Z");
  store = new Store(opened.db, () => new Date((clock += 1000)));
});

afterEach(() => opened.close());

describe("requirements", () => {
  it("records every transition together with its event", async () => {
    await store.createRequirement(requirement);
    await store.setWaiting("R1", { kind: "approval", gate: "product", revision: "abc", onApproval: "next_step" });
    expect((await store.requirement("R1"))?.status).toBe("waiting");
    await store.resume("R1", "approved");
    await store.stop("R1", "no_progress", "item list failed three times");
    const row = await store.requirement("R1");
    expect(row?.status).toBe("stopped");
    expect(row?.stopReason).toBe("no_progress");
    const types = (await store.eventsOf("R1")).map((event) => event.type);
    expect(types).toEqual(["requirement.accepted", "requirement.waiting", "requirement.resumed", "requirement.stopped"]);
    expect(await store.openRequirements()).toHaveLength(0);
  });

  it("refuses a state the design forbids", async () => {
    await store.createRequirement(requirement);
    await expect(opened.client.execute("UPDATE requirements SET status = 'stopped' WHERE id = 'R1'")).rejects.toThrow(/CHECK/);
    await expect(opened.client.execute("UPDATE requirements SET status = 'waiting' WHERE id = 'R1'")).rejects.toThrow(/CHECK/);
    await expect(store.createRequirement({ ...requirement, id: "R2" })).rejects.toThrow();
  });
});

describe("items", () => {
  beforeEach(async () => {
    await store.createRequirement(requirement);
    await store.syncItems("R1", plan, new Map());
  });

  it("keeps passed items across a replan and drops pending ones the plan no longer names", async () => {
    await store.markItemPassed("R1", "scaffold", "sha-1", "digest-scaffold");
    const replanned = planSchema.parse({
      items: [
        { id: "scaffold", kind: "enabling", title: "搭地基（改）", goal: "g" },
        { id: "list-v2", kind: "feature", title: "列表", goal: "g", covers: ["A1"], dependsOn: ["scaffold"] },
      ],
    });
    expect(await store.syncItems("R1", replanned, new Map([["scaffold", "digest-scaffold"]]))).toEqual([]);
    const rows = await store.items("R1");
    expect(rows.map((row) => [row.id, row.status, row.title])).toEqual([
      ["scaffold", "passed", "搭地基（改）"],
      ["list-v2", "pending", "列表"],
    ]);
  });

  it("reopens a passed item whose part of the contract changed", async () => {
    await store.markItemPassed("R1", "list", "sha-2", "digest-before");
    expect(await store.syncItems("R1", plan, new Map([["list", "digest-after"]]))).toEqual(["list"]);
    const row = await store.item("R1", "list");
    expect([row?.status, row?.passedSha, row?.contractDigest, row?.attempts]).toEqual(["pending", null, null, 0]);
  });

  it("counts failures, and a replan gives the attempts back", async () => {
    await store.recordItemFailure("R1", "list", ["A1.1 failed"]);
    const second = await store.recordItemFailure("R1", "list", ["A1.1 failed again"]);
    expect(second.attempts).toBe(2);
    expect(JSON.parse(second.feedback ?? "[]")).toEqual(["A1.1 failed again"]);
    await store.markItemReplanned("R1", "list");
    const row = await store.item("R1", "list");
    expect(row?.attempts).toBe(0);
    expect(row?.replans).toBe(1);
  });

  it("refuses a passed item without the commit that passed", async () => {
    await expect(opened.client.execute("UPDATE items SET status = 'passed' WHERE id = 'list'")).rejects.toThrow(/CHECK/);
  });
});

describe("runs", () => {
  it("sums the API-equivalent cost of every run, subscription included", async () => {
    await store.createRequirement(requirement);
    const base = { requirementId: "R1", itemId: null, step: "plan", role: "planner" as const, provider: "openai-codex", model: "m", effort: "high", promptSha256: "a".repeat(64) };
    await store.startRun({ ...base, id: "run-1", billing: "subscription" });
    await store.startRun({ ...base, id: "run-2", billing: "metered" });
    const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 0, turns: 2, errorClass: null, errorMessage: null };
    await store.finishRun("run-1", { ...usage, outcome: "submitted", costUsd: 1.25 });
    await store.finishRun("run-2", { ...usage, outcome: "error", costUsd: 0.5 });
    expect(await store.spentUsd("R1")).toBeCloseTo(1.75);
    await expect(opened.client.execute("UPDATE runs SET ended_at = NULL WHERE id = 'run-1'")).rejects.toThrow(/CHECK/);
  });
});

describe("human inputs", () => {
  it("stores each input once however often the board returns it", async () => {
    await store.createRequirement(requirement);
    const approval = { kind: "approval" as const, sourceId: "block-1", gate: "product" as const, revision: "abc", author: "ryan", at: "2026-09-24T01:00:00Z" };
    const comment = { kind: "comment" as const, sourceId: "comment-1", body: "改成蓝色", author: "ryan", at: "2026-09-24T02:00:00Z" };
    expect(await store.addInputs("R1", [approval, comment])).toBe(2);
    expect(await store.addInputs("R1", [approval])).toBe(0);
    const pending = await store.unconsumedInputs("R1");
    expect(pending.map((row) => row.sourceId)).toEqual(["block-1", "comment-1"]);
    await store.consumeInputs(["block-1"]);
    expect((await store.unconsumedInputs("R1")).map((row) => row.sourceId)).toEqual(["comment-1"]);
  });

  it("remembers approval decisions per revision", async () => {
    await store.createRequirement(requirement);
    await store.requestApproval("R1", "product", "rev-1");
    await store.requestApproval("R1", "product", "rev-1");
    expect(await store.approvalDecision("R1", "product", "rev-1")).toBeNull();
    await store.decideApproval("R1", "product", "rev-1", "approved");
    expect(await store.approvalDecision("R1", "product", "rev-1")).toBe("approved");
    expect(await store.approvalDecision("R1", "product", "rev-2")).toBeNull();
  });
});

describe("singleton lease", () => {
  it("lets only one holder act, and a holder that lost the lease cannot renew", async () => {
    const first = await store.acquireLease("loop", "host-a", 60_000);
    expect(first).toBe(1);
    expect(await store.acquireLease("loop", "host-b", 60_000)).toBeNull();
    clock += 120_000;
    const taken = await store.acquireLease("loop", "host-b", 60_000);
    expect(taken).toBe(2);
    expect(await store.renewLease("loop", "host-a", 1, 60_000)).toBe(false);
    expect(await store.renewLease("loop", "host-b", 2, 60_000)).toBe(true);
  });
});

describe("database file", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "hivemind-db-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reopens a database it built and refuses one built from a rewritten migration", async () => {
    const path = join(dir, "nested", "hivemind.db");
    const first = await openDatabase(path);
    await new Store(first.db).createRequirement(requirement);
    first.close();
    const again = await openDatabase(path);
    expect((await new Store(again.db).requirement("R1"))?.title).toBe("待办清单");
    await again.client.execute("UPDATE __drizzle_migrations SET hash = 'stale'");
    again.close();
    await expect(openDatabase(path)).rejects.toThrow(/delete the database file/);
  });
});
