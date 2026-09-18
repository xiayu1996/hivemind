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
