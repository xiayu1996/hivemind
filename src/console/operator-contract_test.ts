import { describe, expect, it } from "vitest";
import * as operatorContract from "./operator-contract.js";
import type {
  ConsoleLoadState,
  ConsoleRoleConfigurationPort,
  CostLineItem,
  CostQuery,
  CostSnapshot,
  IsoInstant,
  RoleConfiguration,
  RoleConfigurationVersion,
  WorkRecordDetail,
  WorkRecordEntry,
  WorkRecordQuery,
  WorkRecordSearchPage,
} from "./operator-contract.js";

type CostLedgerEntry = Omit<CostLineItem, "localDate" | "includedInTotal">;
type LoadTransition<Query, Value> =
  | { status: "loading"; query: Query }
  | { status: "empty"; query: Query }
  | { status: "ready"; query: Query; value: Value }
  | { status: "unavailable"; query: Query; failure: { code: "unavailable"; detail: string; retryable: boolean } }
  | { status: "waiting"; query: Query; refreshAfter: IsoInstant };
type RolePortSeed = {
  versions: readonly RoleConfigurationVersion[];
  availableProviders: ReadonlyArray<{ provider: string; modelIds: readonly string[] }>;
  now: () => IsoInstant;
};
type SearchRecords = (entries: readonly WorkRecordEntry[], query: WorkRecordQuery) => WorkRecordSearchPage;
type ReadRecord = (
  entries: readonly WorkRecordEntry[],
  recordId: string,
  options: { revision: string; workStillRunning: boolean; refreshAfter?: IsoInstant },
) => WorkRecordDetail | null;

type RuntimeContract = {
  buildCostSnapshot: (entries: readonly CostLedgerEntry[], query: CostQuery, generatedAt: IsoInstant) => CostSnapshot;
  transitionConsoleLoadState: <Query, Value>(
    previous: ConsoleLoadState<Query, Value> | undefined,
    transition: LoadTransition<Query, Value>,
  ) => ConsoleLoadState<Query, Value>;
  searchWorkRecords: SearchRecords;
  readWorkRecord: ReadRecord;
  createRoleConfigurationPort: (seed: RolePortSeed) => ConsoleRoleConfigurationPort;
};

function runtimeFunction<Name extends keyof RuntimeContract>(name: Name): RuntimeContract[Name] {
  expect(operatorContract).toHaveProperty(name);
  return (operatorContract as unknown as RuntimeContract)[name];
}

const costQuery: CostQuery = {
  timeZone: "Asia/Shanghai",
  startDateInclusive: "2026-09-01",
  endDateInclusive: "2026-09-07",
};

function costEntry(
  id: string,
  occurredAt: IsoInstant,
  costUsd: string,
  overrides: Partial<CostLedgerEntry> = {},
): CostLedgerEntry {
  return {
    id,
    occurredAt,
    requirementId: "R-1",
    requirementTitle: "Investigate delivery",
    provider: "deepseek",
    modelId: "deepseek-chat",
    billing: "metered",
    costUsd,
    ...overrides,
  };
}

const costEntries: CostLedgerEntry[] = [
  costEntry("start", "2026-08-31T16:00:00.000Z", "7.00"),
  costEntry("end", "2026-09-07T15:59:59.999Z", "5.40", {
    requirementId: "R-2",
    requirementTitle: "Verify release",
    provider: "openai-codex",
    modelId: "gpt-5.6-sol",
  }),
  costEntry("subscription", "2026-09-03T04:00:00.000Z", "9.99", {
    billing: "subscription",
    provider: "openai-codex",
    modelId: "gpt-5.6-sol",
  }),
  costEntry("before", "2026-08-31T15:59:59.999Z", "20.00"),
  costEntry("after", "2026-09-07T16:00:00.000Z", "30.00"),
];

describe("mobile operator console contract", () => {
  it("@scenario S-R237511MB-02-costscope includes both local boundary dates at historical cost", () => {
    const buildCostSnapshot = runtimeFunction("buildCostSnapshot");

    const snapshot = buildCostSnapshot(costEntries, costQuery, "2026-09-07T16:01:00.000Z");

    expect(snapshot).toMatchObject({
      scope: {
        timeZone: "Asia/Shanghai",
        startDateInclusive: "2026-09-01",
        endDateInclusive: "2026-09-07",
        billingBasis: "metered-actual-spend",
        pricingBasis: "recorded-at-occurrence",
      },
      totalMeteredUsd: "12.40",
    });
    expect(snapshot.items.map((item) => [item.id, item.localDate])).toEqual([
      ["start", "2026-09-01"],
      ["subscription", "2026-09-03"],
      ["end", "2026-09-07"],
    ]);
  });

  it("@scenario S-R237511MB-02-costscope excludes outside dates and subscription usage from actual spend", () => {
    const buildCostSnapshot = runtimeFunction("buildCostSnapshot");

    const snapshot = buildCostSnapshot(costEntries, costQuery, "2026-09-07T16:01:00.000Z");

    expect(snapshot.items.map((item) => item.id)).not.toContain("before");
    expect(snapshot.items.map((item) => item.id)).not.toContain("after");
    expect(snapshot.items.find((item) => item.id === "subscription")).toMatchObject({
      billing: "subscription",
      includedInTotal: false,
      costUsd: "9.99",
    });
    expect(snapshot.totalMeteredUsd).toBe("12.40");
  });

  it("@scenario S-R237511MB-02-costbreakdown returns every visible ledger field and its exact sum", () => {
    const buildCostSnapshot = runtimeFunction("buildCostSnapshot");

    const snapshot = buildCostSnapshot(costEntries, { ...costQuery, provider: "deepseek" }, "2026-09-07T16:01:00.000Z");

    expect(snapshot.totalMeteredUsd).toBe("7.00");
    expect(snapshot.items).toEqual([
      expect.objectContaining({
        localDate: "2026-09-01",
        requirementId: "R-1",
        requirementTitle: "Investigate delivery",
        provider: "deepseek",
        modelId: "deepseek-chat",
        costUsd: "7.00",
      }),
    ]);
  });

  it("@scenario S-R237511MB-02-costbreakdown applies requirement provider and model filters without binary rounding", () => {
    const buildCostSnapshot = runtimeFunction("buildCostSnapshot");
    const entries = [
      costEntry("a", "2026-09-01T01:00:00.000Z", "0.10"),
      costEntry("b", "2026-09-01T02:00:00.000Z", "0.20"),
      costEntry("other-model", "2026-09-01T03:00:00.000Z", "8.00", { modelId: "deepseek-reasoner" }),
      costEntry("other-requirement", "2026-09-01T04:00:00.000Z", "9.00", { requirementId: "R-9" }),
    ];

    const snapshot = buildCostSnapshot(entries, {
      ...costQuery,
      requirementId: "R-1",
      provider: "deepseek",
      modelId: "deepseek-chat",
    }, "2026-09-07T16:01:00.000Z");

    expect(snapshot.items.map((item) => item.id)).toEqual(["a", "b"]);
    expect(snapshot.totalMeteredUsd).toBe("0.30");
    expect(snapshot.scope).toMatchObject(costQuery);
  });

  it("@scenario S-R237511MB-02-coststates keeps the selected range and visible costs while loading and retrying", () => {
    const transition = runtimeFunction("transitionConsoleLoadState");
    const visible = { ...buildReadyCostSnapshot(), totalMeteredUsd: "7.00" };
    const ready: ConsoleLoadState<CostQuery, CostSnapshot> = { status: "ready", query: costQuery, value: visible };

    const loading = transition(ready, { status: "loading", query: costQuery });
    const unavailable = transition(loading, {
      status: "unavailable",
      query: costQuery,
      failure: { code: "unavailable", detail: "ledger offline", retryable: true },
    });

    expect(loading).toEqual({ status: "loading", query: costQuery, retained: visible });
    expect(unavailable).toEqual({
      status: "unavailable",
      query: costQuery,
      failure: { code: "unavailable", detail: "ledger offline", retryable: true },
      retained: visible,
    });
  });

  it("@scenario S-R237511MB-02-coststates distinguishes empty and accruing ranges without clearing filters", () => {
    const transition = runtimeFunction("transitionConsoleLoadState");
    const empty = transition<CostQuery, CostSnapshot>(undefined, { status: "empty", query: costQuery });
    const waiting = transition<CostQuery, CostSnapshot>(undefined, {
      status: "waiting",
      query: costQuery,
      refreshAfter: "2026-09-07T16:02:00.000Z",
    });

    expect(empty).toEqual({ status: "empty", query: costQuery });
    expect(waiting).toEqual({
      status: "waiting",
      query: costQuery,
      refreshAfter: "2026-09-07T16:02:00.000Z",
    });
  });

  it("@scenario S-R237511MB-02-recordsearch returns a full matching record and adjacent entries from the same work", () => {
    const searchRecords = runtimeFunction("searchWorkRecords");
    const readRecord = runtimeFunction("readWorkRecord");
    const keyword = "\u914d\u989d";
    const entries = recordEntries(keyword);
    const query: WorkRecordQuery = {
      timeZone: "Asia/Shanghai",
      startDateInclusive: "2026-09-05",
      endDateInclusive: "2026-09-05",
      role: "verifier",
      keyword,
    };

    const page = searchRecords(entries, query);
    const detail = readRecord(entries, page.matches[0]!.recordId, { revision: page.revision, workStillRunning: false });

    expect(page.query).toEqual(query);
    expect(page.matches.map((match) => match.recordId)).toEqual(["current"]);
    expect(page.matches[0]?.matchRanges.map((range) => page.matches[0]!.matchedText.slice(range.start, range.end))).toEqual([keyword]);
    expect(detail).toMatchObject({
      previous: { recordId: "previous", workId: "work-1" },
      current: { recordId: "current", role: "verifier", content: `Full ${keyword} context remains visible.` },
      next: { recordId: "next", workId: "work-1" },
    });
  });

  it("@scenario S-R237511MB-02-recordsearch excludes other roles dates and works and matches Latin without case sensitivity", () => {
    const searchRecords = runtimeFunction("searchWorkRecords");
    const readRecord = runtimeFunction("readWorkRecord");
    const entries = [
      ...recordEntries("quota"),
      recordEntry("wrong-role", "work-2", 1, "2026-09-05T06:20:00.000Z", "coder", "quota"),
      recordEntry("wrong-date", "work-3", 1, "2026-09-06T06:20:00.000Z", "verifier", "quota"),
    ];

    const page = searchRecords(entries, {
      timeZone: "Asia/Shanghai",
      startDateInclusive: "2026-09-05",
      endDateInclusive: "2026-09-05",
      role: "verifier",
      keyword: "QUOTA",
    });
    const detail = readRecord(entries, "current", { revision: page.revision, workStillRunning: false });

    expect(page.matches.map((match) => match.recordId)).toEqual(["current"]);
    expect(detail?.previous?.recordId).toBe("previous");
    expect(detail?.next?.recordId).toBe("next");
    expect([detail?.previous?.workId, detail?.next?.workId]).toEqual(["work-1", "work-1"]);
  });

  it("@scenario S-R237511MB-02-recordstates retains all search conditions and results across a retryable failure", () => {
    const transition = runtimeFunction("transitionConsoleLoadState");
    const query: WorkRecordQuery = {
      timeZone: "Asia/Shanghai",
      startDateInclusive: "2026-09-01",
      endDateInclusive: "2026-09-07",
      role: "verifier",
      keyword: "quota",
    };
    const value: WorkRecordSearchPage = { query, matches: [], revision: "r1", generatedAt: "2026-09-07T16:00:00.000Z" };
    const ready: ConsoleLoadState<WorkRecordQuery, WorkRecordSearchPage> = { status: "ready", query, value };

    const failed = transition(ready, {
      status: "unavailable",
      query,
      failure: { code: "unavailable", detail: "records offline", retryable: true },
    });

    expect(failed).toMatchObject({ status: "unavailable", query, retained: value });
  });

  it("@scenario S-R237511MB-02-recordstates represents no match loading and a missing next record as distinct states", () => {
    const transition = runtimeFunction("transitionConsoleLoadState");
    const readRecord = runtimeFunction("readWorkRecord");
    const query: WorkRecordQuery = {
      timeZone: "Asia/Shanghai",
      startDateInclusive: "2026-09-01",
      endDateInclusive: "2026-09-07",
      role: "verifier",
      keyword: "absent",
    };
    const entries = recordEntries("quota").slice(0, 2);
    const detail = readRecord(entries, "current", {
      revision: "r1",
      workStillRunning: true,
      refreshAfter: "2026-09-07T16:02:00.000Z",
    });

    expect(transition<WorkRecordQuery, WorkRecordSearchPage>(undefined, { status: "empty", query })).toEqual({ status: "empty", query });
    expect(transition<WorkRecordQuery, WorkRecordSearchPage>(undefined, { status: "loading", query })).toEqual({ status: "loading", query });
    expect(detail).toMatchObject({ next: null, workStillRunning: true, refreshAfter: "2026-09-07T16:02:00.000Z" });
  });

  it("@scenario S-R237511MB-02-rolesave previews and confirms a new version without changing a captured running version", async () => {
    const createPort = runtimeFunction("createRoleConfigurationPort");
    const port = createPort(roleSeed());
    const before = await port.readRole("verifier");
    const runningVersion = before!.current;
    const next: RoleConfiguration = {
      role: "verifier",
      prompt: "Verify behavior and evidence.",
      provider: "openai-codex",
      modelId: "gpt-5.6-sol",
    };

    const preview = port.previewRoleChange(before!.current, next, before!.availableProviders);
    const result = await port.saveRole({ preview, updatedBy: "owner", idempotencyKey: "save-12", confirmed: true });

    expect(preview).toMatchObject({
      role: "verifier",
      expectedCurrentVersion: 11,
      affects: "future-starts-only",
      valid: true,
      differences: expect.arrayContaining([
        { field: "prompt", kind: "changed", current: "Verify behavior and evidence.", previous: "Check evidence." },
        { field: "provider", kind: "changed", current: "openai-codex", previous: "deepseek" },
        { field: "modelId", kind: "changed", current: "gpt-5.6-sol", previous: "deepseek-chat" },
      ]),
    });
    expect(result).toMatchObject({ status: "saved", current: { version: 12, configuration: next } });
    expect(runningVersion).toMatchObject({ version: 11, configuration: { provider: "deepseek", modelId: "deepseek-chat" } });
  });

  it("@scenario S-R237511MB-02-rolesave rejects an incompatible model and previewing or cancelling creates no version", async () => {
    const createPort = runtimeFunction("createRoleConfigurationPort");
    const port = createPort(roleSeed());
    const before = await port.readRole("verifier");
    const incompatible: RoleConfiguration = {
      ...before!.current.configuration,
      modelId: "gpt-5.6-sol",
    };

    const preview = port.previewRoleChange(before!.current, incompatible, before!.availableProviders);
    const afterPreview = await port.readRole("verifier");
    const rejected = await port.saveRole({ preview, updatedBy: "owner", idempotencyKey: "invalid", confirmed: true });
    const after = await port.readRole("verifier");

    expect(afterPreview?.current.version).toBe(11);
    expect(preview).toMatchObject({
      valid: false,
      affects: "future-starts-only",
      validationIssues: [{
        field: "modelId",
        code: "model_not_offered_by_provider",
        detail: expect.stringContaining("deepseek"),
      }],
    });
    expect(rejected).toMatchObject({ status: "invalid" });
    expect(after?.current.version).toBe(11);
  });

  it("@scenario S-R237511MB-02-rolerestore compares complete versions and restores by appending another version", async () => {
    const createPort = runtimeFunction("createRoleConfigurationPort");
    const port = createPort(roleSeed());
    const view = await port.readRole("verifier");

    expect(view).toMatchObject({
      current: { version: 11, configuration: { prompt: "Check evidence.", provider: "deepseek", modelId: "deepseek-chat" } },
      previous: { version: 10, configuration: { prompt: "Review work.", provider: "openai-codex", modelId: "gpt-5.6-sol" } },
      differences: expect.arrayContaining([
        expect.objectContaining({ field: "prompt", kind: "changed" }),
        expect.objectContaining({ field: "provider", kind: "changed" }),
        expect.objectContaining({ field: "modelId", kind: "changed" }),
      ]),
    });

    const restored = await port.restoreRole({
      role: "verifier",
      expectedCurrentVersion: 11,
      sourceVersion: 10,
      updatedBy: "owner",
      idempotencyKey: "restore-12",
      confirmed: true,
    });
    expect(restored).toMatchObject({
      status: "saved",
      current: { version: 12, restoredFromVersion: 10, configuration: view!.previous!.configuration },
    });
  });

  it("@scenario S-R237511MB-02-rolerestore preserves history and refuses a stale concurrent restore", async () => {
    const createPort = runtimeFunction("createRoleConfigurationPort");
    const port = createPort(roleSeed());

    await port.restoreRole({
      role: "verifier",
      expectedCurrentVersion: 11,
      sourceVersion: 10,
      updatedBy: "owner",
      idempotencyKey: "restore-12",
      confirmed: true,
    });
    const stale = await port.restoreRole({
      role: "verifier",
      expectedCurrentVersion: 11,
      sourceVersion: 10,
      updatedBy: "owner",
      idempotencyKey: "stale-restore",
      confirmed: true,
    });
    const preserved = await port.restoreRole({
      role: "verifier",
      expectedCurrentVersion: 12,
      sourceVersion: 11,
      updatedBy: "owner",
      idempotencyKey: "restore-13",
      confirmed: true,
    });

    expect(stale).toEqual({ status: "conflict", currentVersion: 12, detail: expect.any(String) });
    expect(preserved).toMatchObject({ status: "saved", current: { version: 13, restoredFromVersion: 11 } });
  });

  it("@scenario S-R237511MB-02-rolestates exposes a missing previous version after the first saved configuration", async () => {
    const createPort = runtimeFunction("createRoleConfigurationPort");
    const seed = roleSeed();
    const port = createPort({ ...seed, versions: [seed.versions[0]!] });

    const view = await port.readRole("verifier");

    expect(view).toMatchObject({ current: { version: 10 } });
    expect(view?.previous).toBeNull();
    expect(view?.differences).toEqual([]);
  });

  it("@scenario S-R237511MB-02-rolestates retains unsaved edits and visible versions while reading fails or save confirmation waits", async () => {
    const createPort = runtimeFunction("createRoleConfigurationPort");
    const transition = runtimeFunction("transitionConsoleLoadState");
    const view = await createPort(roleSeed()).readRole("verifier");
    const query = {
      role: "verifier",
      draft: { ...view!.current.configuration, prompt: "Unsaved draft" },
    };
    const ready = { status: "ready", query, value: view! } as const;

    const failed = transition(ready, {
      status: "unavailable",
      query,
      failure: { code: "unavailable", detail: "roles offline", retryable: true },
    });
    const waiting = transition(ready, {
      status: "waiting",
      query,
      refreshAfter: "2026-09-07T16:02:00.000Z",
    });

    expect(failed).toMatchObject({ status: "unavailable", query, retained: view });
    expect(waiting).toMatchObject({ status: "waiting", query, value: view, refreshAfter: "2026-09-07T16:02:00.000Z" });
  });
});

function buildReadyCostSnapshot(): CostSnapshot {
  return {
    scope: {
      ...costQuery,
      billingBasis: "metered-actual-spend",
      pricingBasis: "recorded-at-occurrence",
    },
    items: [],
    totalMeteredUsd: "0.00",
    generatedAt: "2026-09-07T16:00:00.000Z",
    revision: "r1",
    stillAccruing: false,
  };
}

function recordEntry(
  recordId: string,
  workId: string,
  sequence: number,
  occurredAt: IsoInstant,
  role: string,
  content: string,
): WorkRecordEntry {
  return { recordId, workId, sequence, occurredAt, role, content };
}

function recordEntries(keyword: string): WorkRecordEntry[] {
  return [
    recordEntry("previous", "work-1", 1, "2026-09-05T06:19:00.000Z", "coder", "Earlier context."),
    recordEntry("current", "work-1", 2, "2026-09-05T06:20:00.000Z", "verifier", `Full ${keyword} context remains visible.`),
    recordEntry("next", "work-1", 3, "2026-09-05T06:21:00.000Z", "coder", "Later context."),
    recordEntry("other-work", "work-2", 3, "2026-09-05T06:20:30.000Z", "coder", "Unrelated adjacency."),
  ];
}

function roleSeed(): RolePortSeed {
  return {
    versions: [
      {
        version: 10,
        configuration: {
          role: "verifier",
          prompt: "Review work.",
          provider: "openai-codex",
          modelId: "gpt-5.6-sol",
        },
        createdAt: "2026-09-01T00:00:00.000Z",
        createdBy: "owner",
      },
      {
        version: 11,
        configuration: {
          role: "verifier",
          prompt: "Check evidence.",
          provider: "deepseek",
          modelId: "deepseek-chat",
        },
        createdAt: "2026-09-02T00:00:00.000Z",
        createdBy: "owner",
      },
    ],
    availableProviders: [
      { provider: "deepseek", modelIds: ["deepseek-chat"] },
      { provider: "openai-codex", modelIds: ["gpt-5.6-sol"] },
    ],
    now: () => "2026-09-07T16:00:00.000Z",
  };
}
