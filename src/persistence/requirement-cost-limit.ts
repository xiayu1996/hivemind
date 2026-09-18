import type { Client, Row } from "@libsql/client";
import type {
  RequirementCostReadPort,
  RequirementCostSnapshot,
  RequirementCostTotal,
} from "./requirement-cost-ledger.js";

/** Exact USD cents. Constructors must reject non-safe or negative integers. */
export type UsdCents = number & { readonly usdCents: unique symbol };

export interface RequirementCostLimitRecord {
  requirementId: string;
  limitUsdCents: UsdCents;
  version: number;
  updatedAtMs: number;
  updatedBy: string;
}

export interface SaveRequirementCostLimitInput {
  requirementId: string;
  limitUsdCents: UsdCents;
  expectedVersion: number | null;
  updatedAtMs: number;
  updatedBy: string;
}

export type SaveRequirementCostLimitResult =
  | { kind: "saved"; record: RequirementCostLimitRecord }
  | { kind: "requirement_not_found" }
  | { kind: "version_conflict"; current: RequirementCostLimitRecord | null };

export interface RequirementCostLimitStore {
  /** Reads null when the requirement exists without a configured limit. */
  readRequirementCostLimit(requirementId: string): Promise<RequirementCostLimitRecord | null>;

  /**
   * Creates or replaces one requirement's limit with optimistic concurrency.
   * A null expected version only matches an absent row. Different requirement
   * ids do not contend; concurrent writes to one id have one winner.
   */
  saveRequirementCostLimit(input: SaveRequirementCostLimitInput): Promise<SaveRequirementCostLimitResult>;
}

export type RequirementCostLimitAssessment =
  | { status: "not_set" }
  | {
    status: "within_limit";
    totalUsdCents: UsdCents;
    limitUsdCents: UsdCents;
  }
  | {
    status: "over_limit";
    totalUsdCents: UsdCents;
    limitUsdCents: UsdCents;
    excessUsdCents: UsdCents;
  }
  | {
    status: "over_limit_at_least";
    knownSubtotalUsdCents: UsdCents;
    limitUsdCents: UsdCents;
    minimumExcessUsdCents: UsdCents;
    missingPriceCount: number;
  }
  | {
    status: "indeterminate";
    knownSubtotalUsdCents: UsdCents;
    limitUsdCents: UsdCents;
    missingPriceCount: number;
  };

export interface RequirementCostWithLimitSnapshot {
  cost: RequirementCostSnapshot;
  limit: RequirementCostLimitRecord | null;
  assessment: RequirementCostLimitAssessment;
}

export interface OverLimitRequirementSnapshot {
  requirementId: string;
  title: string;
  requirementState: string;
  assessment: Extract<
    RequirementCostLimitAssessment,
    { status: "over_limit" | "over_limit_at_least" }
  >;
}

export interface RequirementCostLimitReadPort {
  /** Returns null only when the requirement itself does not exist. */
  readRequirementCostWithLimit(requirementId: string): Promise<RequirementCostWithLimitSnapshot | null>;

  /** Reads every definitely over-limit requirement for the overview projection. */
  listOverLimitRequirements(): Promise<readonly OverLimitRequirementSnapshot[]>;
}

/**
 * Compares the whole-history total, not the metered-only card ceiling amount.
 * Equality is within limit. An incomplete total can only assert over-limit when
 * its known non-negative subtotal already exceeds the configured limit.
 */
export function assessRequirementCostLimit(
  total: RequirementCostTotal,
  limit: RequirementCostLimitRecord | null,
): RequirementCostLimitAssessment {
  if (limit === null) return { status: "not_set" };
  const limitUsdCents = limit.limitUsdCents;
  if (total.completeness === "complete") {
    const totalUsdCents = centsOf(total.totalUsd);
    if (totalUsdCents > limitUsdCents) {
      return {
        status: "over_limit",
        totalUsdCents,
        limitUsdCents,
        excessUsdCents: (totalUsdCents - limitUsdCents) as UsdCents,
      };
    }
    return { status: "within_limit", totalUsdCents, limitUsdCents };
  }
  const knownSubtotalUsdCents = centsOf(total.knownSubtotalUsd);
  if (knownSubtotalUsdCents > limitUsdCents) {
    return {
      status: "over_limit_at_least",
      knownSubtotalUsdCents,
      limitUsdCents,
      minimumExcessUsdCents: (knownSubtotalUsdCents - limitUsdCents) as UsdCents,
      missingPriceCount: total.missingPriceCount,
    };
  }
  return {
    status: "indeterminate",
    knownSubtotalUsdCents,
    limitUsdCents,
    missingPriceCount: total.missingPriceCount,
  };
}

/** The pattern of a decimal USD amount, with at most one decimal point. */
const USD_AMOUNT = /^(\d+)(?:\.(\d+))?$/;

/**
 * A settled USD amount as exact cents. Drafts are stored to the cent already;
 * anything with more decimal places is rounded half up rather than truncated,
 * so a displayed figure never falls below the amount it stands for.
 */
function centsOf(amountUsd: string): UsdCents {
  const match = USD_AMOUNT.exec(amountUsd.trim());
  if (!match) throw new Error(`not a decimal USD amount: ${amountUsd}`);
  const [, whole, fraction = ""] = match;
  if (fraction.length <= 2) {
    return Number(`${whole}${fraction.padEnd(2, "0")}`) as UsdCents;
  }
  const heads = Number(`${whole}${fraction.slice(0, 2)}`);
  const rounded = fraction.charCodeAt(2) - 48 >= 5 ? heads + 1 : heads;
  return rounded as UsdCents;
}

/** Two-decimal USD text, built from integer cents so it never rounds again. */
export function formatUsdCents(value: UsdCents): string {
  const negative = value < 0;
  const absolute = Math.abs(value);
  const whole = Math.floor(absolute / 100);
  return `${negative ? "-" : ""}$${whole}.${String(absolute % 100).padStart(2, "0")}`;
}

function toLimitRecord(row: Row): RequirementCostLimitRecord {
  return {
    requirementId: String(row.requirement_id),
    limitUsdCents: Number(row.limit_usd_cents) as UsdCents,
    version: Number(row.version),
    updatedAtMs: Number(row.updated_at),
    updatedBy: String(row.updated_by),
  };
}

function requireLimitCents(value: number): UsdCents {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`limitUsdCents must be a non-negative safe integer, got ${value}`);
  }
  return value as UsdCents;
}

/**
 * Per-requirement limits in the central store. A save is one conditional write:
 * a new limit inserts only when no row exists, and a replacement updates only
 * where the version still matches. Two requirements never contend, and two
 * concurrent writes to one requirement produce one winner and one conflict.
 */
export class LibsqlRequirementCostLimitStore implements RequirementCostLimitStore {
  constructor(private readonly client: Client) {}

  async readRequirementCostLimit(requirementId: string): Promise<RequirementCostLimitRecord | null> {
    const row = (await this.client.execute({
      sql: "SELECT * FROM requirement_cost_limits WHERE requirement_id = ?",
      args: [requirementId],
    })).rows[0];
    return row ? toLimitRecord(row) : null;
  }

  async saveRequirementCostLimit(input: SaveRequirementCostLimitInput): Promise<SaveRequirementCostLimitResult> {
    const limitUsdCents = requireLimitCents(input.limitUsdCents);
    const exists = await this.client.execute({
      sql: "SELECT 1 FROM requirements WHERE id = ?",
      args: [input.requirementId],
    });
    if (exists.rows.length === 0) return { kind: "requirement_not_found" };

    if (input.expectedVersion === null) {
      const inserted = await this.client.execute({
        sql: `INSERT INTO requirement_cost_limits
                (requirement_id, limit_usd_cents, version, updated_by, updated_at)
              VALUES (?, ?, 1, ?, ?)
              ON CONFLICT(requirement_id) DO NOTHING`,
        args: [input.requirementId, limitUsdCents, input.updatedBy, input.updatedAtMs],
      });
      if (inserted.rowsAffected === 0) {
        return { kind: "version_conflict", current: await this.readRequirementCostLimit(input.requirementId) };
      }
    } else {
      const updated = await this.client.execute({
        sql: `UPDATE requirement_cost_limits
                 SET limit_usd_cents = ?, version = version + 1, updated_by = ?, updated_at = ?
               WHERE requirement_id = ? AND version = ?`,
        args: [limitUsdCents, input.updatedBy, input.updatedAtMs, input.requirementId, input.expectedVersion],
      });
      if (updated.rowsAffected === 0) {
        return { kind: "version_conflict", current: await this.readRequirementCostLimit(input.requirementId) };
      }
    }
    const record = await this.readRequirementCostLimit(input.requirementId);
    if (record === null) throw new Error(`limit row for ${input.requirementId} vanished after save`);
    return { kind: "saved", record };
  }
}

/**
 * Reads a requirement's whole-history cost together with its configured limit,
 * and lists every requirement that already exceeds its limit. The projection is
 * read-only: nothing here decides whether a Story runs.
 */
export class LibsqlRequirementCostLimitReadPort implements RequirementCostLimitReadPort {
  constructor(
    private readonly client: Client,
    private readonly costPort: RequirementCostReadPort,
    private readonly store: RequirementCostLimitStore = new LibsqlRequirementCostLimitStore(client),
  ) {}

  async readRequirementCostWithLimit(requirementId: string): Promise<RequirementCostWithLimitSnapshot | null> {
    const exists = await this.client.execute({
      sql: "SELECT 1 FROM requirements WHERE id = ?",
      args: [requirementId],
    });
    if (exists.rows.length === 0) return null;
    const cost = await this.costPort.readRequirementCost(requirementId);
    const limit = await this.store.readRequirementCostLimit(requirementId);
    return { cost, limit, assessment: assessRequirementCostLimit(cost.total, limit) };
  }

  async listOverLimitRequirements(): Promise<readonly OverLimitRequirementSnapshot[]> {
    const rows = (await this.client.execute(
      `SELECT r.id, r.title, r.state
         FROM requirements r JOIN requirement_cost_limits l ON l.requirement_id = r.id
        ORDER BY r.updated_at, r.id`,
    )).rows;
    const overLimit: OverLimitRequirementSnapshot[] = [];
    for (const row of rows) {
      const requirementId = String(row.id);
      const cost = await this.costPort.readRequirementCost(requirementId);
      const limit = await this.store.readRequirementCostLimit(requirementId);
      const assessment = assessRequirementCostLimit(cost.total, limit);
      if (assessment.status !== "over_limit" && assessment.status !== "over_limit_at_least") continue;
      overLimit.push({
        requirementId,
        title: String(row.title),
        requirementState: String(row.state),
        assessment,
      });
    }
    return overLimit;
  }
}
