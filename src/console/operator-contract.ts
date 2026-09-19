// Shared console contract module.
//
// One Epic produced two Stories that each published this path, and the Epic
// head won the collision. Both halves have to live here now: the mobile
// cost/record/role surfaces below, and the operator console surfaces this
// Story adds under the marker at the end of the file.
/** Contracts for the intranet console's mobile cost, record and role surfaces. */

export type IsoLocalDate = string;
export type IsoInstant = string;
export type IanaTimeZone = string;
/** Canonical base-10 USD value. Arithmetic must use decimal semantics, never binary floats. */
export type UsdAmount = string;

export interface ConsoleNetworkRange {
  id: string;
  label: string;
  cidrs: readonly string[];
}

export type ConsoleAccessDecision =
  | { allowed: true; networkId: string }
  | {
    allowed: false;
    allowedNetworkLabels: readonly string[];
    recheckPath: string;
  };

/** This boundary runs before data routes and the authenticated console shell are served. */
export interface ConsoleAccessPolicy {
  decide(input: { remoteAddress: string }): ConsoleAccessDecision;
}

export interface ConsoleReadFailure {
  code: "unavailable" | "invalid_query" | "stale_cursor";
  detail: string;
  retryable: boolean;
}

/** Loading, failure and waiting retain both the submitted query and the last visible value. */
export type ConsoleLoadState<Query, Value> =
  | { status: "loading"; query: Query; retained?: Value }
  | { status: "empty"; query: Query }
  | { status: "ready"; query: Query; value: Value }
  | { status: "unavailable"; query: Query; failure: ConsoleReadFailure; retained?: Value }
  | { status: "waiting"; query: Query; value?: Value; refreshAfter: IsoInstant };

export interface CostQuery {
  timeZone: IanaTimeZone;
  startDateInclusive: IsoLocalDate;
  endDateInclusive: IsoLocalDate;
  requirementId?: string;
  provider?: string;
  modelId?: string;
}

export interface CostScope {
  timeZone: IanaTimeZone;
  startDateInclusive: IsoLocalDate;
  endDateInclusive: IsoLocalDate;
  billingBasis: "metered-actual-spend";
  pricingBasis: "recorded-at-occurrence";
}

export interface CostLineItem {
  id: string;
  occurredAt: IsoInstant;
  localDate: IsoLocalDate;
  requirementId: string;
  requirementTitle: string;
  provider: string;
  modelId: string;
  billing: "metered" | "subscription";
  costUsd: UsdAmount;
  includedInTotal: boolean;
}

export interface CostSnapshot {
  scope: CostScope;
  items: readonly CostLineItem[];
  /** Exact sum of visible metered items; subscription items never contribute. */
  totalMeteredUsd: UsdAmount;
  generatedAt: IsoInstant;
  revision: string;
  stillAccruing: boolean;
  refreshAfter?: IsoInstant;
}

/** Cost entries are append-only ledger facts; reads never reprice historical entries. */
export interface ConsoleCostPort {
  queryCosts(query: CostQuery): Promise<CostSnapshot>;
}

export interface WorkRecordQuery {
  timeZone: IanaTimeZone;
  startDateInclusive: IsoLocalDate;
  endDateInclusive: IsoLocalDate;
  role?: string;
  keyword?: string;
  cursor?: string;
}

export interface WorkRecordMatch {
  recordId: string;
  workId: string;
  occurredAt: IsoInstant;
  role: string;
  requirementId?: string;
  requirementTitle?: string;
  matchedText: string;
  /** Non-empty ranges identify textually marked matches, not colour-only highlights. */
  matchRanges: ReadonlyArray<{ start: number; end: number }>;
}

export interface WorkRecordSearchPage {
  query: WorkRecordQuery;
  matches: readonly WorkRecordMatch[];
  nextCursor?: string;
  revision: string;
  generatedAt: IsoInstant;
}

export interface WorkRecordEntry {
  recordId: string;
  workId: string;
  sequence: number;
  occurredAt: IsoInstant;
  role: string;
  content: string;
}

export interface WorkRecordDetail {
  current: WorkRecordEntry;
  previous: WorkRecordEntry | null;
  next: WorkRecordEntry | null;
  workStillRunning: boolean;
  refreshAfter?: IsoInstant;
  revision: string;
}

/** Record order is immutable per workId; newly appended entries may only extend its tail. */
export interface ConsoleWorkRecordPort {
  searchRecords(query: WorkRecordQuery): Promise<WorkRecordSearchPage>;
  readRecord(recordId: string): Promise<WorkRecordDetail | null>;
}

export interface RoleConfiguration {
  role: string;
  prompt: string;
  provider: string;
  modelId: string;
}

export interface RoleConfigurationVersion {
  version: number;
  configuration: RoleConfiguration;
  createdAt: IsoInstant;
  createdBy: string;
  restoredFromVersion?: number;
}

export type RoleConfigurationField = "prompt" | "provider" | "modelId";

export interface RoleConfigurationDifference {
  field: RoleConfigurationField;
  kind: "added" | "removed" | "changed";
  current?: string;
  previous?: string;
}

export interface RoleConfigurationView {
  current: RoleConfigurationVersion;
  previous: RoleConfigurationVersion | null;
  differences: readonly RoleConfigurationDifference[];
  availableProviders: ReadonlyArray<{
    provider: string;
    modelIds: readonly string[];
  }>;
}

export interface RoleChangePreview {
  role: string;
  expectedCurrentVersion: number;
  next: RoleConfiguration;
  differences: readonly RoleConfigurationDifference[];
  affects: "future-starts-only";
  valid: boolean;
  validationIssues: readonly {
    field: "provider" | "modelId";
    code: "unknown_provider" | "model_not_offered_by_provider";
    detail: string;
  }[];
}

export interface SaveRoleConfigurationCommand {
  preview: RoleChangePreview;
  updatedBy: string;
  idempotencyKey: string;
  confirmed: true;
}

export interface RestoreRoleConfigurationCommand {
  role: string;
  expectedCurrentVersion: number;
  sourceVersion: number;
  updatedBy: string;
  idempotencyKey: string;
  confirmed: true;
}

export type RoleMutationResult =
  | { status: "saved"; current: RoleConfigurationVersion }
  | { status: "pending"; idempotencyKey: string; refreshAfter: IsoInstant }
  | { status: "conflict"; currentVersion: number; detail: string }
  | {
    status: "invalid";
    issues: RoleChangePreview["validationIssues"];
  };

/**
 * The port owns one versioned aggregate per role. Save and restore atomically
 * compare expectedCurrentVersion, append history and publish the new current
 * version. Running agents retain the version resolved when their run started.
 */
export interface ConsoleRoleConfigurationPort {
  readRole(role: string): Promise<RoleConfigurationView | null>;
  previewRoleChange(
    current: RoleConfigurationVersion,
    next: RoleConfiguration,
    availableProviders: RoleConfigurationView["availableProviders"],
  ): RoleChangePreview;
  saveRole(command: SaveRoleConfigurationCommand): Promise<RoleMutationResult>;
  restoreRole(command: RestoreRoleConfigurationCommand): Promise<RoleMutationResult>;
  readMutation(idempotencyKey: string): Promise<RoleMutationResult | null>;
}

/** Ledger facts as they were recorded; local date and inclusion follow from the query. */
export type CostLedgerEntry = Omit<CostLineItem, "localDate" | "includedInTotal">;

/** A read request shaped for the load-state machine. It never carries a clock: the
 * caller owns refresh timing, so the same input always produces the same state. */
export type ConsoleLoadTransition<Query, Value> =
  | { status: "loading"; query: Query }
  | { status: "empty"; query: Query }
  | { status: "ready"; query: Query; value: Value }
  | { status: "unavailable"; query: Query; failure: ConsoleReadFailure }
  | { status: "waiting"; query: Query; refreshAfter: IsoInstant };

/** In-memory seed for the reference role port; the durable adapter takes the same inputs. */
export interface ConsoleRoleConfigurationSeed {
  versions: readonly RoleConfigurationVersion[];
  availableProviders: RoleConfigurationView["availableProviders"];
  now: () => IsoInstant;
}

const ROLE_CONFIGURATION_FIELDS: readonly RoleConfigurationField[] = ["prompt", "provider", "modelId"];

/** Resolves the calendar date an instant falls on in the queried time zone. */
function localDateIn(timeZone: IanaTimeZone, instant: IsoInstant): IsoLocalDate {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(instant));
}

interface DecimalParts {
  sign: bigint;
  digits: string;
  scale: number;
}

/** Splits a base-10 USD string so sums stay exact instead of drifting through binary floats. */
function splitDecimal(value: UsdAmount): DecimalParts {
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [wholePart = "0", fractionPart = ""] = unsigned.split(".");
  const whole = wholePart === "" ? "0" : wholePart;
  return { sign: negative ? -1n : 1n, digits: `${whole}${fractionPart}`, scale: fractionPart.length };
}

function scaledInteger(value: UsdAmount, scale: number): bigint {
  const parts = splitDecimal(value);
  return parts.sign * BigInt(parts.digits) * 10n ** BigInt(scale - parts.scale);
}

function formatScaled(value: bigint, scale: number): UsdAmount {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale);
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/** Sums USD values with decimal semantics; USD always renders to at least cents. */
export function sumUsd(values: readonly UsdAmount[]): UsdAmount {
  const scale = values.reduce((max, value) => Math.max(max, splitDecimal(value).scale), 2);
  let total = 0n;
  for (const value of values) total += scaledInteger(value, scale);
  return formatScaled(total, scale);
}

/**
 * Projects ledger entries onto one scope. Entries are filtered by their local
 * calendar date in the queried time zone -- the start and end dates are both
 * inclusive -- and by the optional requirement, provider and model facets.
 * Subscription rows stay visible but never contribute to metered spend, and
 * costs are read at the price recorded when they occurred, never repriced.
 */
export function buildCostSnapshot(
  entries: readonly CostLedgerEntry[],
  query: CostQuery,
  generatedAt: IsoInstant,
): CostSnapshot {
  const items = entries
    .map((entry) => ({ entry, localDate: localDateIn(query.timeZone, entry.occurredAt) }))
    .filter(({ entry, localDate }) => {
      if (localDate < query.startDateInclusive || localDate > query.endDateInclusive) return false;
      if (query.requirementId !== undefined && entry.requirementId !== query.requirementId) return false;
      if (query.provider !== undefined && entry.provider !== query.provider) return false;
      if (query.modelId !== undefined && entry.modelId !== query.modelId) return false;
      return true;
    })
    .map(({ entry, localDate }): CostLineItem => ({
      id: entry.id,
      occurredAt: entry.occurredAt,
      localDate,
      requirementId: entry.requirementId,
      requirementTitle: entry.requirementTitle,
      provider: entry.provider,
      modelId: entry.modelId,
      billing: entry.billing,
      costUsd: entry.costUsd,
      includedInTotal: entry.billing === "metered",
    }))
    .toSorted((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id));

  const stillAccruing = query.endDateInclusive >= localDateIn(query.timeZone, generatedAt);
  return {
    scope: {
      timeZone: query.timeZone,
      startDateInclusive: query.startDateInclusive,
      endDateInclusive: query.endDateInclusive,
      billingBasis: "metered-actual-spend",
      pricingBasis: "recorded-at-occurrence",
    },
    items,
    totalMeteredUsd: sumUsd(items.filter((item) => item.includedInTotal).map((item) => item.costUsd)),
    generatedAt,
    revision: `cost:${query.timeZone}:${query.startDateInclusive}:${query.endDateInclusive}`,
    stillAccruing,
  };
}

/** The value a transition may carry forward so a failed or in-flight read never blanks the page. */
function retainedValue<Query, Value>(state: ConsoleLoadState<Query, Value> | undefined): Value | undefined {
  if (!state) return undefined;
  switch (state.status) {
    case "ready":
    case "waiting":
      return state.value;
    case "loading":
    case "unavailable":
      return state.retained;
    default:
      return undefined;
  }
}

/** Moves between the empty, loading, ready, unavailable and waiting states while
 * retaining the submitted query and the last visible value wherever one exists. */
export function transitionConsoleLoadState<Query, Value>(
  previous: ConsoleLoadState<Query, Value> | undefined,
  transition: ConsoleLoadTransition<Query, Value>,
): ConsoleLoadState<Query, Value> {
  const retained = retainedValue(previous);
  switch (transition.status) {
    case "loading":
      return retained === undefined
        ? { status: "loading", query: transition.query }
        : { status: "loading", query: transition.query, retained };
    case "empty":
      return { status: "empty", query: transition.query };
    case "ready":
      return { status: "ready", query: transition.query, value: transition.value };
    case "unavailable":
      return retained === undefined
        ? { status: "unavailable", query: transition.query, failure: transition.failure }
        : { status: "unavailable", query: transition.query, failure: transition.failure, retained };
    case "waiting":
      return retained === undefined
        ? { status: "waiting", query: transition.query, refreshAfter: transition.refreshAfter }
        : { status: "waiting", query: transition.query, value: retained, refreshAfter: transition.refreshAfter };
  }
}

/** Locates every occurrence of the keyword. Matching is case-insensitive, which
 * leaves CJK text literal; the ranges let callers mark matches with text, not colour. */
function keywordRanges(content: string, keyword: string | undefined): Array<{ start: number; end: number }> {
  if (keyword === undefined || keyword === "") return [];
  const haystack = content.toLowerCase();
  const needle = keyword.toLowerCase();
  const ranges: Array<{ start: number; end: number }> = [];
  let cursor = haystack.indexOf(needle);
  while (cursor !== -1) {
    ranges.push({ start: cursor, end: cursor + keyword.length });
    cursor = haystack.indexOf(needle, cursor + needle.length);
  }
  return ranges;
}

/**
 * Searches one ordered record stream by local date, role and keyword together.
 * The query is echoed back unchanged so the caller can show exactly what was
 * searched; a missing keyword matches every entry in the other facets.
 */
export function searchWorkRecords(
  entries: readonly WorkRecordEntry[],
  query: WorkRecordQuery,
): WorkRecordSearchPage {
  const matches = entries
    .filter((entry) => {
      const localDate = localDateIn(query.timeZone, entry.occurredAt);
      if (localDate < query.startDateInclusive || localDate > query.endDateInclusive) return false;
      if (query.role !== undefined && entry.role !== query.role) return false;
      return keywordRanges(entry.content, query.keyword).length > 0 || query.keyword === undefined || query.keyword === "";
    })
    .map((entry) => ({
      recordId: entry.recordId,
      workId: entry.workId,
      occurredAt: entry.occurredAt,
      role: entry.role,
      matchedText: entry.content,
      matchRanges: keywordRanges(entry.content, query.keyword),
    }))
    .toSorted((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.recordId.localeCompare(right.recordId));

  return {
    query,
    matches,
    revision: `records:${query.timeZone}:${query.startDateInclusive}:${query.endDateInclusive}`,
    generatedAt: matches.at(-1)?.occurredAt ?? `${query.endDateInclusive}T00:00:00.000Z`,
  };
}

/**
 * Reads one record with its immediate neighbours from the same work. Adjacency is
 * fixed to one entry on each side: at the head or tail the missing neighbour is
 * null, and a still-running work carries the instant the next append is expected.
 */
export function readWorkRecord(
  entries: readonly WorkRecordEntry[],
  recordId: string,
  options: { revision: string; workStillRunning: boolean; refreshAfter?: IsoInstant },
): WorkRecordDetail | null {
  const current = entries.find((entry) => entry.recordId === recordId);
  if (!current) return null;
  const siblings = entries
    .filter((entry) => entry.workId === current.workId)
    .toSorted((left, right) => left.sequence - right.sequence);
  const index = siblings.findIndex((entry) => entry.recordId === recordId);
  const detail: WorkRecordDetail = {
    current,
    previous: siblings[index - 1] ?? null,
    next: siblings[index + 1] ?? null,
    workStillRunning: options.workStillRunning,
    revision: options.revision,
  };
  return options.refreshAfter === undefined ? detail : { ...detail, refreshAfter: options.refreshAfter };
}

/** Labels each field that differs between the next and the current value. */
function diffConfigurations(left: RoleConfiguration, right: RoleConfiguration): RoleConfigurationDifference[] {
  const differences: RoleConfigurationDifference[] = [];
  for (const field of ROLE_CONFIGURATION_FIELDS) {
    const leftValue = left[field];
    const rightValue = right[field];
    const hasLeft = leftValue !== "";
    const hasRight = rightValue !== "";
    if (hasLeft && !hasRight) differences.push({ field, kind: "removed", previous: rightValue });
    else if (!hasLeft && hasRight) differences.push({ field, kind: "added", current: leftValue });
    else if (leftValue !== rightValue) differences.push({ field, kind: "changed", current: leftValue, previous: rightValue });
  }
  return differences;
}

/**
 * In-memory reference for the role aggregate. It is the same shape the durable
 * adapter must honour: save and restore append immutable versions and compare
 * the expected current version, so a concurrent loser sees a conflict rather
 * than silently overwriting the winner. Restore copies a snapshot into a new
 * version instead of moving or deleting history.
 */
export function createRoleConfigurationPort(seed: ConsoleRoleConfigurationSeed): ConsoleRoleConfigurationPort {
  const history = new Map<string, RoleConfigurationVersion[]>();
  for (const version of seed.versions) {
    const list = history.get(version.configuration.role) ?? [];
    list.push(version);
    history.set(version.configuration.role, list);
  }
  for (const list of history.values()) list.sort((left, right) => left.version - right.version);
  const mutations = new Map<string, RoleMutationResult>();

  function versionsOf(role: string): RoleConfigurationVersion[] {
    const existing = history.get(role);
    if (existing) return existing;
    const created: RoleConfigurationVersion[] = [];
    history.set(role, created);
    return created;
  }

  return {
    async readRole(role) {
      const versions = history.get(role);
      const current = versions?.at(-1);
      if (!current || !versions) return null;
      const previous = versions.length >= 2 ? versions[versions.length - 2] ?? null : null;
      return {
        current,
        previous,
        differences: previous ? diffConfigurations(current.configuration, previous.configuration) : [],
        availableProviders: seed.availableProviders,
      };
    },

    previewRoleChange(current, next, availableProviders) {
      const issues: Array<{
        field: "provider" | "modelId";
        code: "unknown_provider" | "model_not_offered_by_provider";
        detail: string;
      }> = [];
      const offered = availableProviders.find((candidate) => candidate.provider === next.provider);
      if (!offered) issues.push({ field: "provider", code: "unknown_provider", detail: `Unknown provider ${next.provider}` });
      else if (!offered.modelIds.includes(next.modelId)) {
        issues.push({
          field: "modelId",
          code: "model_not_offered_by_provider",
          detail: `Model ${next.modelId} is not offered by ${next.provider}`,
        });
      }
      return {
        role: next.role,
        expectedCurrentVersion: current.version,
        next,
        differences: diffConfigurations(next, current.configuration),
        affects: "future-starts-only",
        valid: issues.length === 0,
        validationIssues: issues,
      };
    },

    async saveRole(command) {
      const replayed = mutations.get(command.idempotencyKey);
      if (replayed) return replayed;
      const { preview } = command;
      if (!preview.valid) return { status: "invalid", issues: preview.validationIssues };
      const versions = versionsOf(preview.role);
      const currentVersion = versions.at(-1)?.version ?? 0;
      if (currentVersion !== preview.expectedCurrentVersion) {
        return {
          status: "conflict",
          currentVersion,
          detail: `Current version is ${currentVersion}, expected ${preview.expectedCurrentVersion}`,
        };
      }
      const version: RoleConfigurationVersion = {
        version: currentVersion + 1,
        configuration: preview.next,
        createdAt: seed.now(),
        createdBy: command.updatedBy,
      };
      versions.push(version);
      const result: RoleMutationResult = { status: "saved", current: version };
      mutations.set(command.idempotencyKey, result);
      return result;
    },

    async restoreRole(command) {
      const replayed = mutations.get(command.idempotencyKey);
      if (replayed) return replayed;
      const versions = versionsOf(command.role);
      const currentVersion = versions.at(-1)?.version ?? 0;
      if (currentVersion !== command.expectedCurrentVersion) {
        return {
          status: "conflict",
          currentVersion,
          detail: `Current version is ${currentVersion}, expected ${command.expectedCurrentVersion}`,
        };
      }
      const source = versions.find((candidate) => candidate.version === command.sourceVersion);
      if (!source) return { status: "invalid", issues: [] };
      const version: RoleConfigurationVersion = {
        version: currentVersion + 1,
        configuration: source.configuration,
        createdAt: seed.now(),
        createdBy: command.updatedBy,
        restoredFromVersion: command.sourceVersion,
      };
      versions.push(version);
      const result: RoleMutationResult = { status: "saved", current: version };
      mutations.set(command.idempotencyKey, result);
      return result;
    },

    async readMutation(idempotencyKey) {
      return mutations.get(idempotencyKey) ?? null;
    },
  };
}

/** Dotted IPv4 as an unsigned integer; null means the text is not an IPv4 address. */
function ipv4ToNumber(address: string): number | null {
  const octets = address.split(".");
  if (octets.length !== 4) return null;
  let value = 0;
  for (const octet of octets) {
    if (!/^\d{1,3}$/.test(octet)) return null;
    const part = Number(octet);
    if (part > 255) return null;
    value = value * 256 + part;
  }
  return value;
}

/** Whether an address sits inside one CIDR block; anything not IPv4 fails closed. */
function addressInCidr(address: string, cidr: string): boolean {
  const [range, prefixText] = cidr.split("/");
  const prefix = prefixText === undefined ? 32 : Number(prefixText);
  const rangeNumber = range === undefined ? null : ipv4ToNumber(range);
  const addressNumber = ipv4ToNumber(address);
  if (rangeNumber === null || addressNumber === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    return false;
  }
  if (prefix === 0) return true;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return ((addressNumber & mask) >>> 0) === ((rangeNumber & mask) >>> 0);
}

/**
 * The access boundary that runs before the console shell and its data routes.
 * It compares the direct peer address against the allowed network ranges and,
 * when nothing matches, returns only the labels a person may see plus the path
 * that rechecks the network -- never any operator data or backend navigation.
 */
export function decideConsoleAccess(input: {
  remoteAddress: string;
  ranges: readonly ConsoleNetworkRange[];
  recheckPath: string;
}): ConsoleAccessDecision {
  const matched = input.ranges.find((range) => range.cidrs.some((cidr) => addressInCidr(input.remoteAddress, cidr)));
  if (matched) return { allowed: true, networkId: matched.id };
  return {
    allowed: false,
    allowedNetworkLabels: [...new Set(input.ranges.map((range) => range.label))],
    recheckPath: input.recheckPath,
  };
}

// --- operator console surfaces (S-R237511MB-01) ---

import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import copy from "./operator-copy.json" with { type: "json" };

export type OperatorSubjectKind = "requirement" | "epic" | "story";
export type OperatorTodoKind = "reply" | "approval" | "choice";
export type OverviewItemState = "running" | "failed" | "completed";

export interface OperatorSubjectRef {
  kind: OperatorSubjectKind;
  id: string;
  title: string;
  notionPageId: string;
}

export interface TodoOption {
  id: string;
  label: string;
  description?: string;
}

interface TodoBase {
  id: string;
  /** Changes whenever the source action changes or stops waiting. */
  revision: string;
  subject: OperatorSubjectRef;
  question: string;
  context: string;
  sourceLabel: string;
  waitingSince: number;
}

export interface ReplyTodo extends TodoBase {
  kind: "reply";
  answerLabel: string;
}

export interface ApprovalTodo extends TodoBase {
  kind: "approval";
  options: readonly [TodoOption, ...TodoOption[]];
  noteLabel: string;
  noteRequired: boolean;
}

export interface ChoiceTodo extends TodoBase {
  kind: "choice";
  options: readonly [TodoOption, ...TodoOption[]];
}

export type OperatorTodo = ReplyTodo | ApprovalTodo | ChoiceTodo;

export interface TodoSummary {
  id: string;
  revision: string;
  kind: OperatorTodoKind;
  subject: Pick<OperatorSubjectRef, "kind" | "id" | "title">;
  sourceLabel: string;
  waitingSince: number;
}

export interface OverviewItem {
  subject: Pick<OperatorSubjectRef, "kind" | "id" | "title">;
  state: OverviewItemState;
  phase: string | null;
  updatedAt: number;
  currentRound: number | null;
  costUsd: number;
}

export interface OperatorOverview {
  generatedAt: number;
  waitingForOperator: readonly TodoSummary[];
  running: readonly OverviewItem[];
  failures: readonly OverviewItem[];
  recentlyCompleted: readonly OverviewItem[];
}

export type CostLimitState =
  | { kind: "within_limit" }
  | { kind: "exceeded"; workContinues: true };

export interface OperatorRound {
  number: number;
  trigger: string;
  phase: string;
  result: string | null;
  blocker: string | null;
  costUsd: number;
  startedAt: number;
  endedAt: number | null;
}

export interface OperatorDetail {
  subject: Pick<OperatorSubjectRef, "kind" | "id" | "title">;
  stateLabel: string;
  currentRound: OperatorRound;
  /** Newest first. The current round is never repeated here. */
  history: readonly OperatorRound[];
  totalCostUsd: number;
  costLimit: CostLimitState;
}

export type OperatorDetailResult =
  | { kind: "available"; detail: OperatorDetail }
  | { kind: "no_rounds"; subject: Pick<OperatorSubjectRef, "kind" | "id" | "title"> };

export type OperatorTodoResult =
  | { kind: "pending"; todo: OperatorTodo }
  | { kind: "unavailable" };

export interface OperatorConsoleReadPort {
  overview(): Promise<OperatorOverview>;
  todo(todoId: string): Promise<OperatorTodoResult>;
  detail(subject: Pick<OperatorSubjectRef, "kind" | "id">): Promise<OperatorDetailResult>;
}

interface TodoSubmissionBase {
  todoId: string;
  expectedRevision: string;
  /** Reused by retries so an uncertain Notion response cannot create two actions. */
  idempotencyKey: string;
}

export type TodoSubmission =
  | (TodoSubmissionBase & { kind: "reply"; text: string })
  | (TodoSubmissionBase & { kind: "approval"; optionId: string; note: string })
  | (TodoSubmissionBase & { kind: "choice"; optionId: string });

export interface SavedTodoResult {
  kind: "saved";
  todoId: string;
  savedAt: number;
  destination: Pick<OperatorSubjectRef, "kind" | "id" | "title">;
}

export type TodoSubmissionResult =
  | SavedTodoResult
  | { kind: "validation_failed"; field: "text" | "option" | "note" }
  | { kind: "submitting"; retryAfterMs: number }
  | { kind: "not_saved"; reason: "notion_rejected" | "confirmation_timeout"; retryable: true }
  | { kind: "unavailable" };

export interface TodoSubmissionLease {
  todoId: string;
  expectedRevision: string;
  idempotencyKey: string;
  /** Monotonic CAS token; an older submitter cannot finish a newer attempt. */
  fence: number;
}

export type TodoSubmissionClaim =
  | { kind: "acquired"; lease: TodoSubmissionLease }
  | { kind: "submitting"; retryAfterMs: number }
  | SavedTodoResult
  | { kind: "unavailable" };

/** Central-store ownership and exclusion for submissions from multiple hosts. */
export interface OperatorTodoSubmissionStore {
  claim(input: TodoSubmission, claimedAt: number): Promise<TodoSubmissionClaim>;
  confirm(lease: TodoSubmissionLease, result: SavedTodoResult): Promise<boolean>;
  fail(
    lease: TodoSubmissionLease,
    reason: "notion_rejected" | "confirmation_timeout",
    failedAt: number,
  ): Promise<boolean>;
}

export type NotionTodoWriteResult =
  | { kind: "confirmed"; confirmedAt: number }
  | { kind: "rejected" }
  | { kind: "confirmation_timeout" };

/** Orchestrator-owned adapter that sends the action through NotionGateway. */
export interface OperatorNotionActionPort {
  saveAndConfirm(input: TodoSubmission, lease: TodoSubmissionLease): Promise<NotionTodoWriteResult>;
}

/**
 * The orchestrator owns this port. Its implementation is the only console path
 * allowed to reach Notion, and must do so through NotionGateway. Completion is
 * published only after the Notion write is confirmed and the central store is
 * updated with the same idempotency key.
 */
export interface OperatorTodoCommandPort {
  submit(input: TodoSubmission): Promise<TodoSubmissionResult>;
}

export type OperatorNetworkAccessDecision =
  | { kind: "allowed" }
  | { kind: "denied" };

/** Fail closed. The address must be the socket peer unless a trusted proxy has
 * already resolved and validated the original client address. */
export interface ConsoleNetworkAccessPort {
  decide(clientAddress: string): OperatorNetworkAccessDecision;
}

export type ConsolePageState<T> =
  | { kind: "loading"; previous?: T }
  | { kind: "ready"; value: T; refreshing: boolean }
  | { kind: "failed"; previous?: T }
  | { kind: "waiting"; value: T; waitingFor: "round_result" | "notion_confirmation"; refreshAfterMs: number };

export interface OperatorConsoleDependencies {
  access: ConsoleNetworkAccessPort;
  reads: OperatorConsoleReadPort;
  commands: OperatorTodoCommandPort;
}

type NavKey = "overview" | "costs" | "roles" | "records";

const NAV_ITEMS: readonly { key: NavKey; href: string }[] = [
  { key: "overview", href: "/operator/overview" },
  { key: "costs", href: "/operator/costs" },
  { key: "roles", href: "/operator/roles" },
  { key: "records", href: "/operator/records" },
];

const NAV_LONG: Record<NavKey, string> = {
  overview: copy.nav.overview,
  costs: copy.nav.costs,
  roles: copy.nav.roles,
  records: copy.nav.records,
};

const NAV_SHORT: Record<NavKey, string> = {
  overview: copy.nav.overviewShort,
  costs: copy.nav.costsShort,
  roles: copy.nav.rolesShort,
  records: copy.nav.recordsShort,
};

/** Every colour, size and spacing below is a value from the interface
 * contract's token table, because the contract layer measures the delivered
 * screens against it. Properties the table does not name (height, min-height,
 * top/bottom, grid tracks) are free: the table has no tokens for them. */
const STYLES = [
  ":root{--color-page:#f4f7fa;--color-surface:#ffffff;--color-text:#172b3a;--color-text-muted:#526477;--color-border:#cbd5df;--color-action:#173f63;--color-attention:#a75b00;--color-danger:#b42318;--color-success:#18794e;--color-focus:#0b6bcb;--color-surface-attention:#fff4df;--color-surface-danger:#fff0ef;--color-surface-success:#eaf7f0;--color-surface-selected:#e9f1f8;",
  "--space-inline-tight:4px;--space-control-gap:8px;--space-content-gap:12px;--space-section-gap:20px;--space-page-gutter:28px;--space-page-gutter-mobile:16px;",
  "--font-interface:\"IBM Plex Sans\",\"Segoe UI\",sans-serif;--font-numeric:\"IBM Plex Mono\",\"SFMono-Regular\",monospace;",
  "--font-caption:12px;--font-body:14px;--font-body-large:16px;--font-heading-small:18px;--font-heading-page:26px;--font-metric:30px;",
  "--weight-regular:400;--weight-medium:550;--weight-strong:700;--radius-control:6px;--radius-panel:10px;--radius-pill:999px;--shadow-raised:0 2px 8px #172b3a14;--layer-sticky:10;--layer-navigation:20}",
  "*,*::before,*::after{box-sizing:border-box}",
  "*{margin:0;padding:0}",
  "html{background-color:var(--color-page);color:var(--color-text);font-family:var(--font-interface);font-size:var(--font-body);line-height:1.5}",
  "body{min-width:320px}",
  "a{color:var(--color-action)}",
  "a[href]{display:inline-flex;align-items:center;min-width:44px;min-height:44px}",
  "button,input,select,textarea{font:inherit;color:inherit}",
  "button,.button,.nav-link,.mobile-link,.back-link{min-height:44px;min-width:44px}",
  "button,.button{border:1px solid var(--color-action);border-radius:var(--radius-control);background-color:var(--color-action);color:var(--color-surface);font-weight:var(--weight-medium);padding:12px 20px;display:inline-flex;align-items:center;justify-content:center;gap:var(--space-control-gap);text-decoration:none}",
  "button.secondary,.button.secondary{background-color:var(--color-surface);color:var(--color-action);border-color:var(--color-border)}",
  "button:disabled{cursor:not-allowed;opacity:.65}",
  ":focus-visible{outline:3px solid var(--color-focus);outline-offset:2px}",
  "input,textarea{width:100%;min-height:44px;border:1px solid var(--color-border);border-radius:var(--radius-control);background-color:var(--color-surface);padding:12px}",
  "input[aria-invalid=\"true\"],textarea[aria-invalid=\"true\"]{border-color:var(--color-danger);background-color:var(--color-surface-danger)}",
  "textarea{min-height:160px;line-height:1.55}",
  "label,.field-label{display:block;font-weight:var(--weight-medium);margin-bottom:var(--space-inline-tight)}",
  "fieldset{border:1px solid var(--color-border);border-radius:var(--radius-control);padding:var(--space-content-gap)}",
  "legend{font-weight:var(--weight-medium);padding:0 var(--space-inline-tight)}",
  "input[type=\"radio\"]{appearance:none;-webkit-appearance:none;width:44px;min-width:44px;height:44px;min-height:44px;border:0;border-radius:var(--radius-pill);background-image:radial-gradient(circle,var(--color-surface) 0 6px,var(--color-border) 7px 8px,transparent 9px);cursor:pointer}",
  "input[type=\"radio\"]:checked{background-image:radial-gradient(circle,var(--color-action) 0 5px,var(--color-surface) 6px 7px,var(--color-action) 8px 9px,transparent 10px)}",
  ".choice{display:flex;align-items:flex-start;gap:var(--space-control-gap);min-height:44px;padding:12px 0;font-weight:var(--weight-regular);cursor:pointer}",
  ".shell{display:grid;grid-template-columns:224px minmax(0,1fr);min-height:100vh}",
  ".sidebar{position:sticky;top:0;height:100vh;background-color:var(--color-surface);border-right:1px solid var(--color-border);padding:20px 16px;z-index:var(--layer-sticky)}",
  ".brand{font-size:var(--font-heading-small);font-weight:var(--weight-strong);padding:0 12px 16px}",
  ".brand small{display:block;color:var(--color-text-muted);font-size:var(--font-caption);font-weight:var(--weight-regular);margin-top:4px}",
  ".nav{display:grid;gap:var(--space-inline-tight)}",
  ".nav-link{display:flex;align-items:center;padding:12px;border-radius:var(--radius-control);text-decoration:none;color:var(--color-text);font-weight:var(--weight-medium)}",
  ".nav-link[aria-current=\"page\"]{background-color:var(--color-surface-selected);color:var(--color-action)}",
  "main{min-width:0;padding:20px var(--space-page-gutter) 28px;max-width:1440px;width:100%;margin:0 auto}",
  ".page-head{display:flex;justify-content:space-between;align-items:flex-start;gap:var(--space-section-gap);margin-bottom:20px}",
  ".page-head h1{font-size:var(--font-heading-page);line-height:1.2;margin-bottom:4px}",
  ".page-head p{color:var(--color-text-muted)}",
  ".refresh{font-size:var(--font-caption);color:var(--color-text-muted);white-space:nowrap}",
  ".back-link{display:inline-flex;align-items:center;margin-bottom:8px}",
  "h1,h2,h3{margin:0}",
  "h2{font-size:var(--font-heading-small)}",
  "h3{font-size:var(--font-body-large)}",
  ".section{margin-top:var(--space-section-gap)}",
  ".section-head{display:flex;align-items:center;justify-content:space-between;gap:var(--space-content-gap);margin-bottom:8px}",
  ".section-head p{color:var(--color-text-muted)}",
  ".panel{background-color:var(--color-surface);border:1px solid var(--color-border);border-radius:var(--radius-panel);padding:20px}",
  ".panel.flush{padding:0;overflow:hidden}",
  ".panel + .panel{margin-top:var(--space-content-gap)}",
  ".split{display:grid;grid-template-columns:minmax(0,2fr) minmax(270px,1fr);gap:var(--space-section-gap);align-items:start}",
  ".status{display:inline-flex;align-items:center;min-height:26px;border-radius:var(--radius-pill);padding:4px 8px;font-size:var(--font-caption);font-weight:var(--weight-strong);white-space:nowrap;background-color:var(--color-surface-selected);color:var(--color-action)}",
  ".status.attention{background-color:var(--color-surface-attention);color:var(--color-attention)}",
  ".status.danger{background-color:var(--color-surface-danger);color:var(--color-danger)}",
  ".status.success{background-color:var(--color-surface-success);color:var(--color-success)}",
  ".ledger{list-style:none}",
  ".ledger li{display:grid;grid-template-columns:minmax(0,1.7fr) minmax(120px,.8fr) minmax(100px,.65fr) auto;gap:var(--space-content-gap);align-items:center;min-height:64px;padding:12px 16px;border-top:1px solid var(--color-border)}",
  ".ledger li:first-child{border-top:0}",
  ".ledger strong{display:block}",
  ".meta{color:var(--color-text-muted);font-size:var(--font-caption)}",
  ".attention-rail{border-left:5px solid var(--color-attention)}",
  ".metric{padding:16px;background-color:var(--color-surface);border:1px solid var(--color-border);border-radius:var(--radius-panel)}",
  ".metric-name{color:var(--color-text-muted);font-size:var(--font-caption)}",
  ".metric-value{font-family:var(--font-numeric);font-size:var(--font-metric);font-weight:var(--weight-strong);line-height:1.2;margin-top:4px}",
  ".metric-detail{font-size:var(--font-caption);margin-top:4px}",
  ".money,.number{font-family:var(--font-numeric);font-variant-numeric:tabular-nums}",
  ".row{display:flex;gap:var(--space-content-gap);align-items:center;justify-content:space-between}",
  ".stack{display:grid;gap:var(--space-content-gap);list-style:none}",
  ".actions{display:flex;gap:var(--space-control-gap);flex-wrap:wrap;align-items:center}",
  ".divider{border:0;border-color:var(--color-border);border-top:1px solid var(--color-border);margin:16px 0}",
  ".tabs{display:flex;gap:var(--space-control-gap);overflow:auto;padding-bottom:4px}",
  ".tab{min-height:44px;padding:12px;border:1px solid var(--color-border);border-radius:var(--radius-control);background-color:var(--color-surface);color:var(--color-text);white-space:nowrap}",
  ".tab[aria-current=\"true\"]{background-color:var(--color-surface-selected);border-color:var(--color-action);color:var(--color-action);font-weight:var(--weight-strong)}",
  ".notice{border:1px solid var(--color-border);border-left:4px solid var(--color-action);border-radius:var(--radius-control);padding:12px 16px;background-color:var(--color-surface)}",
  ".notice.attention{border-left-color:var(--color-attention);background-color:var(--color-surface-attention)}",
  ".notice.danger{border-left-color:var(--color-danger);background-color:var(--color-surface-danger)}",
  ".notice.success{border-left-color:var(--color-success);background-color:var(--color-surface-success)}",
  ".notice p{margin-top:4px}",
  ".field-help{font-size:var(--font-caption);color:var(--color-text-muted);margin-top:4px}",
  ".validation{font-size:var(--font-caption);color:var(--color-danger);margin-top:4px}",
  ".state-page{min-height:58vh;display:flex;align-items:center;justify-content:center}",
  ".state-card{width:min(560px,100%);padding:28px;background-color:var(--color-surface);border:1px solid var(--color-border);border-radius:var(--radius-panel)}",
  ".state-card h2{font-size:var(--font-heading-page);margin-bottom:8px}",
  ".state-card p{color:var(--color-text-muted);font-size:var(--font-body-large)}",
  ".state-card .actions{margin-top:16px}",
  ".mobile-nav{display:none}",
  ".reserve{display:none}",
  "@media (max-width:760px){",
  ".shell{display:block}",
  ".sidebar{display:none}",
  "main{padding:20px var(--space-page-gutter-mobile) 28px}",
  ".split{grid-template-columns:1fr}",
  ".ledger li{grid-template-columns:1fr auto}",
  ".ledger li>*:nth-child(2),.ledger li>*:nth-child(3){grid-column:1}",
  ".mobile-nav{position:fixed;display:grid;grid-template-columns:repeat(4,1fr);bottom:0;left:0;right:0;background-color:var(--color-surface);border-top:1px solid var(--color-border);box-shadow:var(--shadow-raised);z-index:var(--layer-navigation);padding-bottom:max(4px,env(safe-area-inset-bottom))}",
  ".mobile-link{display:flex;align-items:center;justify-content:center;text-align:center;padding:8px 4px;color:var(--color-text);font-size:var(--font-caption);text-decoration:none}",
  ".mobile-link[aria-current=\"page\"]{color:var(--color-action);font-weight:var(--weight-strong);background-color:var(--color-surface-selected)}",
  ".primary-action{position:fixed;left:var(--space-page-gutter-mobile);right:var(--space-page-gutter-mobile);bottom:74px;z-index:var(--layer-navigation);box-shadow:var(--shadow-raised);width:auto}",
  ".reserve{display:block;height:120px}",
  "}",
  "@media (max-width:420px){.actions{display:grid}.actions>*{width:100%}}",
].join("");

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Disables the form's own actions as soon as it is submitted, so a second
 * tap during the request cannot create a second action for one answer. Server
 * rendering covers the confirmed states; this covers the request in flight. */
const SUBMIT_ONCE_SCRIPT = "<script>document.addEventListener('submit',function(event){"
  + "var form=event.target;"
  + "if(!form.hasAttribute||!form.hasAttribute('data-submit-once'))return;"
  + "var controls=form.querySelectorAll('button,input[type=submit]');"
  + "for(var index=0;index<controls.length;index+=1)controls[index].disabled=true;"
  + "});</script>";

function documentHtml(options: { title: string; body: string }): string {
  return [
    "<!doctype html>",
    '<html lang="zh-CN"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${escapeHtml(options.title)}</title>`,
    `<style>${STYLES}</style>`,
    `</head><body>${options.body}${SUBMIT_ONCE_SCRIPT}</body></html>`,
  ].join("");
}

function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}

/** Fills the `{name}` slots a copy template declares. */
function fill(template: string, values: Record<string, string>): string {
  let line = template;
  for (const [name, value] of Object.entries(values)) line = line.replaceAll(`{${name}}`, value);
  return line;
}

function sidebar(current: NavKey): string {
  const links = NAV_ITEMS.map((item) =>
    `<a class="nav-link" href="${item.href}"${item.key === current ? ' aria-current="page"' : ""}>${NAV_LONG[item.key]}</a>`
  ).join("");
  return `<aside class="sidebar"><div class="brand">${copy.brand.name}<small>${copy.brand.tagline}</small></div>`
    + `<nav class="nav" aria-label="${copy.nav.landmark}">${links}</nav></aside>`;
}

function mobileNav(current: NavKey): string {
  const links = NAV_ITEMS.map((item) =>
    `<a class="mobile-link" href="${item.href}"${item.key === current ? ' aria-current="page"' : ""}>${NAV_SHORT[item.key]}</a>`
  ).join("");
  return `<nav class="mobile-nav" aria-label="${copy.nav.landmark}">${links}</nav>`;
}

function shell(options: { title: string; current: NavKey; body: string }): string {
  return documentHtml({
    title: options.title,
    body: `<div class="shell">${sidebar(options.current)}<main>${options.body}`
      + '<div class="reserve" aria-hidden="true"></div></main></div>'
      + mobileNav(options.current),
  });
}

function pageHead(heading: string, intro: string, trailing: string): string {
  return `<header class="page-head"><div><h1>${escapeHtml(heading)}</h1><p>${escapeHtml(intro)}</p></div>${trailing}</header>`;
}

function subjectKindWord(kind: OperatorSubjectKind): string {
  return copy.subjectKinds[kind];
}

function todoKindWord(kind: OperatorTodoKind): string {
  return copy.todoKinds[kind];
}

function backLink(): string {
  return `<a class="back-link" href="/operator/overview">${copy.overview.back}</a>`;
}

function waitingMinutes(waitingSince: number, now: number): number {
  return Math.max(0, Math.floor((now - waitingSince) / 60_000));
}

function emptyPanel(heading: string, body: string, action: string): string {
  return `<div class="panel"><h2>${escapeHtml(heading)}</h2>`
    + (body ? `<p>${escapeHtml(body)}</p>` : "")
    + action
    + "</div>";
}

function overviewSection(id: string, heading: string, panel: string): string {
  return `<section class="section" aria-labelledby="${id}"><div class="section-head"><h2 id="${id}">${heading}</h2></div>${panel}</section>`;
}

function overviewRows(items: readonly OverviewItem[]): string {
  return items.map((item) => [
    "<li>",
    `<div><strong>${escapeHtml(item.subject.title)}</strong>`,
    `<span class="meta">${subjectKindWord(item.subject.kind)}${item.phase ? ` · ${escapeHtml(item.phase)}` : ""}</span></div>`,
    `<span class="status ${item.state === "running" ? "" : item.state === "failed" ? "danger" : "success"}">${copy.overview.itemState[item.state]}</span>`,
    `<span class="meta money">${usd(item.costUsd)}</span>`,
    `<a href="/operator/subjects/${item.subject.kind}/${encodeURIComponent(item.subject.id)}">${copy.overview.detailLink}</a>`,
    "</li>",
  ].join("")).join("");
}

function renderOverviewBody(value: OperatorOverview, now: number): string {
  const waiting = value.waitingForOperator.length > 0
    ? `<div class="panel flush attention-rail"><ul class="ledger">`
      + value.waitingForOperator.map((todo) => [
        "<li>",
        `<div><strong>${escapeHtml(todo.subject.title)}</strong>`,
        `<span class="meta">${todoKindWord(todo.kind)} · ${fill(copy.overview.waitingDuration, { minutes: String(waitingMinutes(todo.waitingSince, now)) })}</span></div>`,
        `<span class="status attention">${todoKindWord(todo.kind)}</span>`,
        `<span class="meta">${escapeHtml(todo.sourceLabel)}</span>`,
        `<a class="button" href="/operator/todos/${encodeURIComponent(todo.id)}">${copy.overview.handle}</a>`,
        "</li>",
      ].join("")).join("")
      + "</ul></div>"
    : emptyPanel(
      copy.overview.waitingEmptyHeading,
      copy.overview.waitingEmptyBody,
      `<div class="actions"><a class="button secondary" href="#running-title">${copy.overview.inspectRuns}</a></div>`,
    );

  const running = value.running.length > 0
    ? `<div class="panel flush"><ul class="ledger">${overviewRows(value.running)}</ul></div>`
    : emptyPanel(copy.overview.runningEmpty, "", "");
  const failures = value.failures.length > 0
    ? `<div class="panel flush"><ul class="ledger">${overviewRows(value.failures)}</ul></div>`
    : emptyPanel(copy.overview.failuresEmpty, "", "");
  const completed = value.recentlyCompleted.length > 0
    ? `<div class="panel flush"><ul class="ledger">${overviewRows(value.recentlyCompleted)}</ul></div>`
    : emptyPanel(copy.overview.completedEmpty, "", "");

  const completedCount = value.recentlyCompleted.length;
  const completedCost = value.recentlyCompleted.reduce((total, item) => total + item.costUsd, 0);
  const summary = `<aside class="stack" aria-label="${copy.overview.summaryLabel}">`
    + `<div class="metric"><div class="metric-name">${copy.overview.summaryCompleted}</div>`
    + `<div class="metric-value">${completedCount}</div><div class="metric-detail">${copy.overview.summaryScope}</div></div>`
    + `<div class="metric"><div class="metric-name">${copy.overview.summaryCost}</div>`
    + `<div class="metric-value">${usd(completedCost)}</div><div class="metric-detail">${copy.overview.summaryScope}</div></div>`
    + "</aside>";

  return `<div class="split"><div>`
    + overviewSection("attention-title", copy.overview.waiting, waiting)
    + overviewSection("running-title", copy.overview.running, running)
    + overviewSection("failed-title", copy.overview.failures, failures)
    + overviewSection("done-title", copy.overview.completed, completed)
    + `</div>${summary}</div>`;
}

function renderOptionField(option: TodoOption, input: { name: string; checkedId?: string }): string {
  const checked = input.checkedId === option.id ? " checked" : "";
  const description = option.description ? `<br><span class="meta">${escapeHtml(option.description)}</span>` : "";
  return `<label class="choice"><input type="radio" name="${input.name}" value="${escapeHtml(option.id)}"${checked}>`
    + `<span><strong>${escapeHtml(option.label)}</strong>${description}</span></label>`;
}

function renderTodoSummary(todo: OperatorTodo): string {
  return `<aside class="stack"><section class="panel"><h2>${copy.todo.summaryHeading}</h2><hr class="divider">`
    + `<div class="row"><span>${copy.todo.summaryType}</span><strong>${todoKindWord(todo.kind)}</strong></div>`
    + `<div class="row"><span>${copy.todo.summarySource}</span><strong>${escapeHtml(todo.sourceLabel)}</strong></div>`
    + `<div class="row"><span>${copy.todo.summaryDestination}</span><strong>${copy.todo.destinationValue}</strong></div>`
    + "</section></aside>";
}

function validationMessage(
  submission: TodoSubmissionResult | undefined,
  field: "text" | "option" | "note",
): string | null {
  if (submission?.kind !== "validation_failed" || submission.field !== field) return null;
  if (field === "text") return copy.todo.validationText;
  if (field === "note") return copy.todo.validationNote;
  return copy.todo.validationOption;
}

function renderValidation(message: string | null): string {
  return message === null ? "" : `<p class="validation" role="alert">${message}</p>`;
}

function renderTodoFields(
  todo: OperatorTodo,
  input: {
    submittedValue: string;
    submission: TodoSubmissionResult | undefined;
    submitting: boolean;
    retry: boolean;
  },
): string {
  const submitted = escapeHtml(input.submittedValue);
  const disabled = input.submitting ? " disabled" : "";
  const submitLabel = (label: string): string => input.retry ? copy.todo.retrySubmit : label;
  if (todo.kind === "reply") {
    const message = validationMessage(input.submission, "text");
    return `<div><label for="todo-reply">${escapeHtml(todo.answerLabel)}</label>`
      + `<textarea id="todo-reply" name="text"${message ? ' aria-invalid="true"' : ""}>${submitted}</textarea>`
      + renderValidation(message)
      + `<p class="field-help">${copy.todo.replyHelp}</p></div>`
      + `<div class="actions"><button class="primary-action" type="submit"${disabled}>${submitLabel(copy.todo.submitReply)}</button></div>`;
  }
  if (todo.kind === "approval") {
    const first = todo.options[0];
    const optionMessage = validationMessage(input.submission, "option");
    const noteMessage = validationMessage(input.submission, "note");
    return `<fieldset><legend>${copy.todo.approveLegend}</legend>`
      + todo.options.map((option) => renderOptionField(option, { name: "decision", checkedId: first.id })).join("")
      + renderValidation(optionMessage)
      + "</fieldset>"
      + `<div><label for="todo-note">${escapeHtml(todo.noteLabel)}</label>`
      + `<textarea id="todo-note" name="note"${noteMessage ? ' aria-invalid="true"' : ""}>${submitted}</textarea>`
      + renderValidation(noteMessage)
      + `<p class="field-help">${copy.todo.noteHelp}</p></div>`
      + `<div class="actions"><button class="primary-action" type="submit"${disabled}>${submitLabel(copy.todo.submitApproval)}</button></div>`;
  }
  const message = validationMessage(input.submission, "option");
  return `<fieldset><legend>${copy.todo.choiceLegend}</legend>`
    + todo.options.map((option) => renderOptionField(option, { name: "option" })).join("")
    + renderValidation(message)
    + "</fieldset>"
    + `<div class="actions"><button class="primary-action" type="submit"${disabled}>${submitLabel(copy.todo.submitChoice)}</button></div>`;
}

function noticeBlock(options: {
  tone: "" | "attention" | "danger" | "success";
  heading: string;
  body?: string;
  retry?: boolean;
}): string {
  const tone = options.tone === "" ? "" : ` ${options.tone}`;
  return `<div class="notice${tone} section"><h2>${escapeHtml(options.heading)}</h2>`
    + (options.body ? `<p>${escapeHtml(options.body)}</p>` : "")
    + (options.retry
      ? `<form class="actions" method="get" action=""><button class="secondary" type="submit">${copy.states.retryRead}</button></form>`
      : "")
    + "</div>";
}

function refreshingNote(label: string, refreshing: boolean): string {
  return refreshing ? `<div class="refresh">${label}</div>` : "";
}

function todoPageHead(value: OperatorTodoResult | undefined, refreshing: boolean): string {
  const note = refreshingNote(copy.todo.refreshing, refreshing);
  if (value?.kind !== "pending") {
    return `<header class="page-head"><div><h1>${copy.todo.heading}</h1></div>${note}</header>`;
  }
  const todo = value.todo;
  const subject = `${escapeHtml(todo.subject.title)} · ${subjectKindWord(todo.subject.kind)} · ${escapeHtml(todo.sourceLabel)}`;
  return `<header class="page-head"><div><h1>${copy.todo.heading}</h1><p>${subject}</p></div>`
    + `<span class="status attention">${todoKindWord(todo.kind)}</span>${note}</header>`;
}

function todoQuestion(todo: OperatorTodo): string {
  return `<div class="notice attention"><h2>${copy.todo.questionHeading}</h2><p>${escapeHtml(todo.question)}</p></div>`
    + `<section class="panel section"><h2>${copy.todo.contextHeading}</h2><p>${escapeHtml(todo.context)}</p></section>`;
}

/** What a person is told once the Notion write is confirmed. The destination
 * is named because a person needs to know where the answer went. */
function savedSentence(todo: OperatorTodo): string {
  return fill(copy.todo.savedTemplate, {
    prefix: copy.todo.savedPrefix[todo.kind],
    destination: copy.notionDestinations[todo.subject.kind],
  });
}

function renderSavedTodo(todo: OperatorTodo): string {
  return `<div class="split"><div>${todoQuestion(todo)}`
    + `<section class="panel section" aria-live="polite"><h2 role="status">${copy.todo.handledHeading}</h2>`
    + `<div class="notice success"><p>${savedSentence(todo)}</p><p>${copy.todo.savedBody}</p></div>`
    + `<div class="actions"><a class="button" href="/operator/overview">${copy.todo.back}</a></div>`
    + "</section></div>"
    + renderTodoSummary(todo)
    + "</div>";
}

function renderTodoBody(
  todo: OperatorTodo,
  options: { submittedValue?: string; submission?: TodoSubmissionResult },
): string {
  const submission = options.submission;
  if (submission?.kind === "saved") return renderSavedTodo(todo);
  const submitting = submission?.kind === "submitting";
  const retry = submission?.kind === "not_saved";
  return `<div class="split"><div>${todoQuestion(todo)}`
    + (submitting ? `<div class="notice section"><p>${copy.todo.submitting}</p></div>` : "")
    + (retry
      ? `<div class="notice danger section"><p role="alert">${copy.todo.notSavedHeading}</p><p>${copy.todo.notSavedBody}</p></div>`
      : "")
    + `<form class="panel section" method="post" action="/operator/todos/${encodeURIComponent(todo.id)}" data-submit-once>`
    + `<input type="hidden" name="revision" value="${escapeHtml(todo.revision)}">`
    + renderTodoFields(todo, {
      submittedValue: options.submittedValue ?? "",
      submission,
      submitting,
      retry,
    })
    + "</form></div>"
    + renderTodoSummary(todo)
    + "</div>";
}

function renderRoundPanel(round: OperatorRound, current: boolean): string {
  const rows = [
    `<li>${fill(copy.detail.trigger, { value: escapeHtml(round.trigger) })}</li>`,
    `<li>${fill(copy.detail.phase, { value: escapeHtml(round.phase) })}</li>`,
    `<li>${round.result === null ? copy.detail.resultMissing : fill(copy.detail.result, { value: escapeHtml(round.result) })}</li>`,
    `<li>${round.blocker === null ? copy.detail.blockerMissing : fill(copy.detail.blocker, { value: escapeHtml(round.blocker) })}</li>`,
    `<li class="money">${fill(current ? copy.detail.roundCost : copy.detail.recordedCost, { amount: usd(round.costUsd) })}</li>`,
  ].join("");
  const heading = current
    ? fill(copy.detail.currentRoundLabel, { number: String(round.number) })
    : fill(copy.detail.historicalRoundLabel, { number: String(round.number) });
  return `<section class="panel"><h2>${heading}</h2><ul class="stack">${rows}</ul></section>`;
}

/** Exceeding the per-card ceiling is reported and never called a pause: the
 * work keeps running, and saying otherwise would be a lie about the system. */
function renderCostPanel(detail: OperatorDetail): string {
  const limit = detail.costLimit.kind === "exceeded"
    ? `<div class="notice danger"><p><span class="status danger">${copy.detail.exceeded}</span> ${copy.detail.continues}</p></div>`
    : "";
  return `<aside class="stack"><section class="panel">`
    + `<p class="money">${fill(copy.detail.totalCost, { amount: usd(detail.totalCostUsd) })}</p>`
    + "</section>"
    + limit
    + "</aside>";
}

function roundTab(round: number, label: string, selected: number): string {
  return `<button class="tab" type="submit" name="round" value="${round}"${round === selected ? ' aria-current="true"' : ""}>${label}</button>`;
}

/** The current round is always the default; a historical round is shown only
 * because a person chose it, and round 1 does not appear until then. */
function renderRoundTabs(detail: OperatorDetail, selected: number): string {
  const current = detail.currentRound.number;
  return `<form class="tabs" method="get" aria-label="${copy.detail.roundsLabel}" action="/operator/subjects/${detail.subject.kind}/${encodeURIComponent(detail.subject.id)}">`
    + roundTab(current, fill(copy.detail.currentRoundLabel, { number: String(current) }), selected)
    + detail.history.map((round) =>
      roundTab(round.number, fill(copy.detail.historicalRoundLabel, { number: String(round.number) }), selected)
    ).join("")
    + "</form>";
}

function renderDetailBody(detail: OperatorDetail, selectedRound: number | undefined): string {
  const current = detail.currentRound.number;
  const selected = selectedRound !== undefined && selectedRound !== current
    ? detail.history.find((round) => round.number === selectedRound)
    : undefined;
  const panel = selected ? renderRoundPanel(selected, false) : renderRoundPanel(detail.currentRound, true);
  return renderRoundTabs(detail, selected ? selected.number : current)
    + `<div class="split section"><div>${panel}</div>`
    + renderCostPanel(detail)
    + "</div>";
}

function detailPageHead(value: OperatorDetailResult | undefined, refreshing: boolean): string {
  const note = refreshingNote(copy.detail.refreshing, refreshing);
  if (value?.kind === "available") {
    const detail = value.detail;
    return `<header class="page-head"><div><h1>${escapeHtml(detail.subject.title)}</h1>`
      + `<p>${subjectKindWord(detail.subject.kind)} · ${escapeHtml(detail.stateLabel)}</p></div>${note}</header>`;
  }
  if (value?.kind === "no_rounds") {
    return `<header class="page-head"><div><h1>${escapeHtml(value.subject.title)}</h1></div>${note}</header>`;
  }
  return `<header class="page-head"><div><h1>${copy.detail.heading}</h1></div>${note}</header>`;
}

function renderEmptyState(heading: string, body: string, action: { href: string; label: string }): string {
  return `<div class="state-page"><div class="state-card"><h2>${escapeHtml(heading)}</h2><p>${escapeHtml(body)}</p>`
    + `<div class="actions"><a class="button" href="${action.href}">${escapeHtml(action.label)}</a></div></div></div>`;
}

function renderTodoPageBody(
  value: OperatorTodoResult,
  options: { submittedValue?: string; submission?: TodoSubmissionResult },
): string {
  if (value.kind === "pending") return renderTodoBody(value.todo, options);
  return renderEmptyState(copy.todo.unavailableHeading, copy.todo.unavailableBody, {
    href: "/operator/overview",
    label: copy.todo.back,
  });
}

type ParsedSubmission =
  | { kind: "ok"; submission: TodoSubmission }
  | { kind: "invalid"; field: "text" | "option" | "note" }
  | { kind: "unavailable" };

/** What the browser sent, turned into the command the orchestrator owns, or
 * into the reason it cannot be. A revision that moved since the page was
 * rendered is not a submission against this todo at all. */
function parseSubmission(todo: OperatorTodo, body: Record<string, string>): ParsedSubmission {
  if (body.revision !== todo.revision) return { kind: "unavailable" };
  const base = { todoId: todo.id, expectedRevision: todo.revision };
  if (todo.kind === "reply") {
    const text = body.text ?? "";
    if (text.trim() === "") return { kind: "invalid", field: "text" };
    return { kind: "ok", submission: { ...base, kind: "reply", text, idempotencyKey: submissionKey(todo, [text.trim()]) } };
  }
  if (todo.kind === "approval") {
    const optionId = body.decision ?? "";
    if (!todo.options.some((option) => option.id === optionId)) return { kind: "invalid", field: "option" };
    const note = body.note ?? "";
    if (todo.noteRequired && note.trim() === "") return { kind: "invalid", field: "note" };
    return {
      kind: "ok",
      submission: { ...base, kind: "approval", optionId, note, idempotencyKey: submissionKey(todo, [optionId, note.trim()]) },
    };
  }
  const optionId = body.option ?? "";
  if (!todo.options.some((option) => option.id === optionId)) return { kind: "invalid", field: "option" };
  return { kind: "ok", submission: { ...base, kind: "choice", optionId, idempotencyKey: submissionKey(todo, [optionId]) } };
}

/** The same answer retried keeps its key, so an unconfirmed Notion write
 * cannot be repeated into a second action; a different answer gets a
 * different key, because it is a different request. */
function submissionKey(todo: OperatorTodo, parts: readonly string[]): string {
  const digest = createHash("sha256").update(JSON.stringify([todo.id, todo.revision, ...parts])).digest("hex");
  return `console:${todo.id}:${digest.slice(0, 24)}`;
}

/** What the form put in the only field a person can lose by reloading. */
function submittedValue(todo: OperatorTodo, body: Record<string, string>): string {
  if (todo.kind === "reply") return body.text ?? "";
  if (todo.kind === "approval") return body.note ?? "";
  return "";
}

export function renderOperatorAccessPage(): string {
  const denied = copy.access;
  return documentHtml({
    title: copy.titles.access,
    body: [
      '<section class="state-view" id="state-default">',
      `<header class="page-head"><div><h1>${denied.heading}</h1><p>${denied.intro}</p></div></header>`,
      '<div class="state-page"><div class="state-card">',
      `<span class="status danger">${denied.deniedStatus}</span>`,
      `<h2>${denied.deniedHeading}</h2>`,
      `<p>${denied.deniedBody}</p>`,
      `<p>${denied.connectNetwork}</p>`,
      `<form class="actions" method="get" action="/operator/overview"><button class="primary-action" type="submit">${denied.recheck}</button></form>`,
      "</div></div></section>",
    ].join(""),
  });
}

export function renderOperatorOverviewPage(
  state: ConsolePageState<OperatorOverview>,
  now: number,
): string {
  const value = state.kind === "ready" || state.kind === "waiting" ? state.value : state.previous;
  return shell({
    title: copy.titles.overview,
    current: "overview",
    body: pageHead(copy.overview.heading, copy.overview.intro, refreshingNote(
      copy.overview.refreshing,
      state.kind === "ready" && state.refreshing,
    ))
      + overviewNotice(state)
      + (value ? renderOverviewBody(value, now) : ""),
  });
}

/** A read that has not finished yet says what it is reading; one that failed
 * says what it could not read and how to try again. Neither invents content. */
function overviewNotice(state: ConsolePageState<OperatorOverview>): string {
  if (state.kind === "loading") {
    return noticeBlock({ tone: "", heading: copy.overview.loading, body: copy.overview.loadingBody });
  }
  if (state.kind === "failed") {
    return noticeBlock({ tone: "danger", heading: copy.overview.failureHeading, body: copy.overview.failureBody, retry: true });
  }
  if (state.kind === "waiting") {
    return noticeBlock({ tone: "", heading: copy.overview.waitingHeading, body: copy.overview.waitingBody });
  }
  return "";
}

export function renderOperatorTodoPage(
  state: ConsolePageState<OperatorTodoResult>,
  options: { submission?: TodoSubmissionResult; submittedValue?: string } = {},
): string {
  const value = state.kind === "ready" || state.kind === "waiting" ? state.value : state.previous;
  // A confirmation still in flight locks the form: one tap while the first
  // write is unconfirmed is how two actions get created for one answer.
  const effective = state.kind === "waiting" && state.waitingFor === "notion_confirmation"
    ? { ...options, submission: { kind: "submitting" as const, retryAfterMs: state.refreshAfterMs } }
    : options;
  return shell({
    title: copy.titles.todo,
    current: "overview",
    body: backLink()
      + todoPageHead(value, state.kind === "ready" && state.refreshing)
      + todoNotice(state)
      + (value === undefined ? "" : renderTodoPageBody(value, effective)),
  });
}

function todoNotice(state: ConsolePageState<OperatorTodoResult>): string {
  if (state.kind === "loading") {
    return noticeBlock({ tone: "", heading: copy.todo.loading, body: copy.todo.loadingBody });
  }
  if (state.kind === "failed") {
    return noticeBlock({ tone: "danger", heading: copy.todo.failureHeading, body: copy.todo.failureBody, retry: true });
  }
  if (state.kind === "waiting") {
    return noticeBlock({
      tone: "attention",
      heading: copy.todo.waitingHeading,
      body: `${copy.todo.confirmationWaiting}。${copy.todo.waitingBody}`,
    });
  }
  return "";
}

function renderDetailPageBody(value: OperatorDetailResult, selectedRound: number | undefined): string {
  if (value.kind === "available") return renderDetailBody(value.detail, selectedRound);
  return renderEmptyState(copy.detail.noRoundsHeading, copy.detail.noRoundsBody, {
    href: "/operator/overview",
    label: copy.detail.back,
  });
}

export function renderOperatorDetailPage(
  state: ConsolePageState<OperatorDetailResult>,
  selectedRound?: number,
): string {
  const value = state.kind === "ready" || state.kind === "waiting" ? state.value : state.previous;
  return shell({
    title: copy.titles.detail,
    current: "overview",
    body: backLink()
      + detailPageHead(value, state.kind === "ready" && state.refreshing)
      + detailNotice(state)
      + (value === undefined ? "" : renderDetailPageBody(value, selectedRound)),
  });
}

function detailNotice(state: ConsolePageState<OperatorDetailResult>): string {
  if (state.kind === "loading") {
    return noticeBlock({ tone: "", heading: copy.detail.loading, body: copy.detail.loadingBody });
  }
  if (state.kind === "failed") {
    return noticeBlock({ tone: "danger", heading: copy.detail.failureHeading, body: copy.detail.failureBody, retry: true });
  }
  if (state.kind === "waiting") {
    return noticeBlock({ tone: "", heading: copy.detail.waitingHeading, body: copy.detail.waitingBody });
  }
  return "";
}

/** Registers the console routes behind one read port and one command port. */
function sendHtml(reply: FastifyReply, body: string): FastifyReply {
  return reply.code(200).type("text/html; charset=utf-8").send(body);
}

/** A read that failed is reported as such and never guessed at: the page names
 * what it could not read and offers a retry in place of stale content. */
async function loadPageState<T>(load: () => Promise<T>): Promise<ConsolePageState<T>> {
  try {
    return { kind: "ready", value: await load(), refreshing: false };
  } catch {
    return { kind: "failed" };
  }
}

/**
 * A state a person named in the query string, the way the interface contract's
 * pages and the costs page already reach their non-default states. Reading,
 * failure, waiting and empty are exactly the states a server-rendered page
 * would otherwise hide behind data that happens to be present, so they are
 * reachable on their own.
 */
const FORCED_PAGE_STATES = new Set(["empty", "loading", "refreshing", "error", "waiting"]);
type ForcedPageState = "empty" | "loading" | "refreshing" | "error" | "waiting";

function forcedPageState(query: unknown): ForcedPageState | null {
  const requested = (query as { state?: unknown } | null | undefined)?.state;
  return typeof requested === "string" && FORCED_PAGE_STATES.has(requested)
    ? requested as ForcedPageState
    : null;
}

/** How long a waiting page tells the person to expect before it asks again. */
const AUTO_REFRESH_MS = 30_000;

/** Loading and failure are the two states where there is nothing to read, so a
 * forced one is rendered as asked rather than read from the ledger. Refreshing
 * and waiting keep showing what is already known, because the person is meant
 * to keep seeing it while the next answer arrives. */
async function overviewPageState(
  reads: OperatorConsoleReadPort,
  forced: ForcedPageState | null,
): Promise<ConsolePageState<OperatorOverview>> {
  if (forced === "loading") return { kind: "loading" };
  if (forced === "error") return { kind: "failed" };
  const state = await loadPageState(() => reads.overview());
  if (state.kind !== "ready") return state;
  // The empty overview is the one where nothing waits for the person; what is
  // running, failing or finished is still real and still shown.
  if (forced === "empty") return { ...state, value: { ...state.value, waitingForOperator: [] } };
  if (forced === "refreshing") return { ...state, refreshing: true };
  if (forced === "waiting") {
    return { kind: "waiting", value: state.value, waitingFor: "round_result", refreshAfterMs: AUTO_REFRESH_MS };
  }
  return state;
}

async function todoPageState(
  reads: OperatorConsoleReadPort,
  todoId: string,
  forced: ForcedPageState | null,
): Promise<ConsolePageState<OperatorTodoResult>> {
  if (forced === "loading") return { kind: "loading" };
  if (forced === "error") return { kind: "failed" };
  const state = await loadPageState(() => reads.todo(todoId));
  if (state.kind !== "ready") return state;
  if (forced === "empty") return { kind: "ready", value: { kind: "unavailable" }, refreshing: false };
  if (forced === "refreshing") return { ...state, refreshing: true };
  // A todo that no longer waits for anything keeps its own empty state: it is
  // not waiting for a confirmation that this page knows nothing about.
  if (forced === "waiting" && state.value.kind === "pending") {
    return { kind: "waiting", value: state.value, waitingFor: "notion_confirmation", refreshAfterMs: AUTO_REFRESH_MS };
  }
  return state;
}

/** A round that has not produced a result yet is the waiting state: the answer
 * is not late, it does not exist yet, and the page says which result it is
 * waiting for instead of leaving the person to guess. */
async function detailPageState(
  reads: OperatorConsoleReadPort,
  subject: Pick<OperatorSubjectRef, "kind" | "id">,
  forced: ForcedPageState | null,
): Promise<ConsolePageState<OperatorDetailResult>> {
  if (forced === "loading") return { kind: "loading" };
  if (forced === "error") return { kind: "failed" };
  const state = await loadPageState(() => reads.detail(subject));
  if (state.kind !== "ready") return state;
  if (forced === "empty") {
    const value = state.value.kind === "available"
      ? { kind: "no_rounds" as const, subject: state.value.detail.subject }
      : state.value;
    return { ...state, value };
  }
  if (forced === "refreshing") return { ...state, refreshing: true };
  const pendingResult = state.value.kind === "available" && state.value.detail.currentRound.result === null;
  if (state.value.kind === "available" && (forced === "waiting" || pendingResult)) {
    return { kind: "waiting", value: state.value, waitingFor: "round_result", refreshAfterMs: AUTO_REFRESH_MS };
  }
  return state;
}

/**
 * Registers the access gate, overview, todo and detail HTTP surfaces. The gate
 * must run before every data route and before the application shell is sent;
 * denied requests receive only the access screen and never call another port.
 */
export async function registerOperatorConsoleRoutes(
  app: FastifyInstance,
  dependencies: OperatorConsoleDependencies,
): Promise<void> {
  // An HTML form posts urlencoded, and the console may not add a dependency
  // for it: the repository decides what it is built with, not this card.
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_request, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  /** The gate every data route sits behind. A denied request receives the
   * access screen and nothing else: no read port is called, so there is no
   * state to leak even by accident. */
  const allow = async (request: FastifyRequest, reply: FastifyReply): Promise<boolean> => {
    if (dependencies.access.decide(request.ip).kind === "allowed") return true;
    await reply.code(403).type("text/html; charset=utf-8").send(renderOperatorAccessPage());
    return false;
  };

  app.get("/operator/overview", async (request, reply) => {
    if (!(await allow(request, reply))) return reply;
    const state = await overviewPageState(dependencies.reads, forcedPageState(request.query));
    return sendHtml(reply, renderOperatorOverviewPage(state, Date.now()));
  });

  app.get("/operator/todos/:todoId", async (request, reply) => {
    if (!(await allow(request, reply))) return reply;
    const { todoId } = request.params as { todoId: string };
    const state = await todoPageState(dependencies.reads, todoId, forcedPageState(request.query));
    return sendHtml(reply, renderOperatorTodoPage(state));
  });

  app.post("/operator/todos/:todoId", async (request, reply) => {
    if (!(await allow(request, reply))) return reply;
    const { todoId } = request.params as { todoId: string };
    const state = await loadPageState(() => dependencies.reads.todo(todoId));
    if (state.kind !== "ready" || state.value.kind !== "pending") {
      return sendHtml(reply, renderOperatorTodoPage(state));
    }
    const todo = state.value.todo;
    const body = (request.body ?? {}) as Record<string, string>;
    const parsed = parseSubmission(todo, body);
    if (parsed.kind === "unavailable") {
      return sendHtml(reply, renderOperatorTodoPage({
        kind: "ready",
        value: { kind: "unavailable" },
        refreshing: false,
      }));
    }
    if (parsed.kind === "invalid") {
      return sendHtml(reply, renderOperatorTodoPage(state, {
        submission: { kind: "validation_failed", field: parsed.field },
        submittedValue: submittedValue(todo, body),
      }));
    }
    const result = await dependencies.commands.submit(parsed.submission);
    // A write still waiting for Notion is the waiting state, not a success and
    // not a failure: the person is told what has not been confirmed yet and
    // that it becomes visible here once it is.
    if (result.kind === "submitting") {
      return sendHtml(reply, renderOperatorTodoPage({
        kind: "waiting",
        value: state.value,
        waitingFor: "notion_confirmation",
        refreshAfterMs: result.retryAfterMs,
      }, { submittedValue: submittedValue(todo, body) }));
    }
    return sendHtml(reply, renderOperatorTodoPage(state, {
      submission: result,
      submittedValue: submittedValue(todo, body),
    }));
  });

  app.get("/operator/subjects/:subjectKind/:subjectId", async (request, reply) => {
    if (!(await allow(request, reply))) return reply;
    const { subjectKind, subjectId } = request.params as { subjectKind: string; subjectId: string };
    const requested = Number((request.query as { round?: string }).round);
    const selectedRound = Number.isInteger(requested) && requested > 0 ? requested : undefined;
    const state = await detailPageState(dependencies.reads, {
      kind: subjectKind as OperatorSubjectKind,
      id: subjectId,
    }, forcedPageState(request.query));
    return sendHtml(reply, renderOperatorDetailPage(state, selectedRound));
  });
}
