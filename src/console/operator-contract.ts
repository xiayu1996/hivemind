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
