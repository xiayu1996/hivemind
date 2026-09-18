/**
 * Representative data for the mobile console screens.
 *
 * It exists so a running console can be looked at without a populated central
 * store: a demo, a smoke run, or a verification round that needs the screens
 * with the sample data the definition of done names. The numbers are the ones
 * the frozen contract test uses, so what a reader sees here is what the
 * contract proves.
 */
import {
  buildCostSnapshot,
  createRoleConfigurationPort,
  decideConsoleAccess,
  readWorkRecord,
  searchWorkRecords,
  type ConsoleAccessPolicy,
  type ConsoleNetworkRange,
  type CostLedgerEntry,
  type WorkRecordEntry,
} from "./operator-contract.js";
import type { MobileConsoleDependencies } from "./operator-screens.js";

const SAMPLE_NOW = "2026-09-07T16:01:00.000Z";

/** Home, office and (for a machine looking at itself) loopback. */
export const SAMPLE_NETWORKS: readonly ConsoleNetworkRange[] = [
  { id: "home", label: "家庭网络", cidrs: ["192.168.1.0/24"] },
  { id: "office", label: "办公室网络", cidrs: ["10.0.0.0/8"] },
  { id: "loopback", label: "本机", cidrs: ["127.0.0.0/8"] },
];

export function sampleCostLedger(): readonly CostLedgerEntry[] {
  return [
    {
      id: "start",
      occurredAt: "2026-08-31T16:00:00.000Z",
      requirementId: "R-1",
      requirementTitle: "Investigate delivery",
      provider: "deepseek",
      modelId: "deepseek-chat",
      billing: "metered",
      costUsd: "7.00",
    },
    {
      id: "end",
      occurredAt: "2026-09-07T15:59:59.999Z",
      requirementId: "R-2",
      requirementTitle: "Verify release",
      provider: "openai-codex",
      modelId: "gpt-5.6-sol",
      billing: "metered",
      costUsd: "5.40",
    },
    {
      id: "subscription",
      occurredAt: "2026-09-03T04:00:00.000Z",
      requirementId: "R-2",
      requirementTitle: "Verify release",
      provider: "openai-codex",
      modelId: "gpt-5.6-sol",
      billing: "subscription",
      costUsd: "9.99",
    },
  ];
}

export function sampleWorkRecords(): readonly WorkRecordEntry[] {
  return [
    { recordId: "previous", workId: "work-1", sequence: 1, occurredAt: "2026-09-05T06:19:00.000Z", role: "coder", content: "Earlier context." },
    { recordId: "current", workId: "work-1", sequence: 2, occurredAt: "2026-09-05T06:20:00.000Z", role: "verifier", content: "配额不足，无法继续。" },
    { recordId: "next", workId: "work-1", sequence: 3, occurredAt: "2026-09-05T06:21:00.000Z", role: "coder", content: "Later context." },
  ];
}

export function sampleRoleVersions() {
  return {
    versions: [
      {
        version: 10,
        configuration: { role: "verifier", prompt: "Review work.", provider: "openai-codex", modelId: "gpt-5.6-sol" },
        createdAt: "2026-09-01T00:00:00.000Z",
        createdBy: "owner",
      },
      {
        version: 11,
        configuration: { role: "verifier", prompt: "Check evidence.", provider: "deepseek", modelId: "deepseek-chat" },
        createdAt: "2026-09-02T00:00:00.000Z",
        createdBy: "owner",
      },
    ],
    availableProviders: [
      { provider: "deepseek", modelIds: ["deepseek-chat"] },
      { provider: "openai-codex", modelIds: ["gpt-5.6-sol"] },
    ],
    now: () => SAMPLE_NOW,
  };
}

export interface MobileConsoleSampleOptions {
  /** Instant the sample reads are attributed to; fixed so a run is reproducible. */
  generatedAt?: string;
  /** Allowed networks; defaults to home, office and loopback. */
  networks?: readonly ConsoleNetworkRange[];
}

/** Ports over the sample data, ready to hand to {@link registerMobileConsoleRoutes}. */
export function createMobileConsoleSample(
  options: MobileConsoleSampleOptions = {},
): MobileConsoleDependencies {
  const generatedAt = options.generatedAt ?? SAMPLE_NOW;
  const networks = options.networks ?? SAMPLE_NETWORKS;
  const ledger = sampleCostLedger();
  const records = sampleWorkRecords();
  const access: ConsoleAccessPolicy = {
    decide: (input) => decideConsoleAccess({ remoteAddress: input.remoteAddress, ranges: networks, recheckPath: "/access" }),
  };
  return {
    access,
    costs: { queryCosts: async (query) => buildCostSnapshot(ledger, query, generatedAt) },
    records: {
      searchRecords: async (query) => searchWorkRecords(records, query),
      readRecord: async (recordId) => readWorkRecord(records, recordId, {
        revision: "sample",
        workStillRunning: true,
        refreshAfter: generatedAt,
      }),
    },
    roles: createRoleConfigurationPort(sampleRoleVersions()),
    now: () => new Date(`${generatedAt.slice(0, 19)}.000Z`),
  };
}
