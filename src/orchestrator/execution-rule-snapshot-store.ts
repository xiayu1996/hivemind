import type { Client } from "@libsql/client";
import { z } from "zod";
import { MODEL_TIERS } from "../pipeline/phase.js";
import type {
  ExecutionAgentRuleSnapshot,
  ExecutionAgentRuleSnapshotRepository,
  StartExecutionRuleSnapshotInput,
} from "./agent-rule-snapshot.js";

/**
 * Per-execution snapshots reuse the `config_entries` table under a scope the
 * ConfigStore never reads. That scope is what keeps a snapshot out of the
 * operator's configuration: `read()`/`reload()` only ever look at `global` and
 * a repository slug, so an execution row is invisible to them, and the config
 * write surface cannot reach a key that is not in CONFIG_KEYS.
 */
const SNAPSHOT_KEY = "model.agentRules.snapshot";

export function executionSnapshotScope(executionId: string): string {
  return `execution:${executionId}`;
}

const storedCandidate = z.object({
  provider: z.string().min(1),
  id: z.string().min(1),
  contextWindow: z.number().int().positive().optional(),
  maxOutput: z.number().int().positive().optional(),
  thinking: z.boolean().optional(),
  images: z.boolean().optional(),
  purpose: z.string().min(1),
  tier: z.enum(MODEL_TIERS),
  order: z.number().int().nonnegative(),
});

const storedSnapshot = z.object({
  executionId: z.string().min(1),
  ruleRevision: z.number().int().nonnegative(),
  rules: z.object({
    defaultProvider: z.string(),
    defaultModel: z.string(),
    providerStates: z.record(z.string(), z.enum(["enabled", "disabled"])),
    failoverOrder: z.array(z.string()),
  }).strict(),
  candidatesByAgentType: z.record(z.string(), z.array(storedCandidate)),
});

/**
 * The immutable per-execution rule snapshot in central libsql.
 *
 * `start` is an insert-if-absent statement keyed by the execution's scope: two
 * processes racing to start the same execution, or a process that restarts
 * after a crash, all read back the first committed row. Nothing here updates or
 * deletes a snapshot, so saving a new global rule never re-resolves an
 * execution that already owns one.
 */
export class LibsqlExecutionAgentRuleSnapshotRepository implements ExecutionAgentRuleSnapshotRepository {
  constructor(private readonly client: Client) {}

  async start(input: StartExecutionRuleSnapshotInput): Promise<ExecutionAgentRuleSnapshot> {
    const snapshot: ExecutionAgentRuleSnapshot = {
      executionId: input.executionId,
      ruleRevision: input.rules.revision,
      rules: structuredClone(input.rules.rules),
      candidatesByAgentType: structuredClone(input.candidatesByAgentType),
    };
    const scope = executionSnapshotScope(input.executionId);
    await this.client.execute({
      sql: `INSERT INTO config_entries (scope_id, key, value_json, version, updated_by, updated_at)
            SELECT ?, ?, ?, 1, ?, ?
             WHERE NOT EXISTS (SELECT 1 FROM config_entries WHERE scope_id = ? AND key = ?)`,
      args: [scope, SNAPSHOT_KEY, JSON.stringify(snapshot), "execution", Date.now(), scope, SNAPSHOT_KEY],
    });
    const stored = await this.find(input.executionId);
    if (!stored) throw new Error(`execution ${input.executionId} snapshot was written but cannot be read back`);
    return stored;
  }

  async find(executionId: string): Promise<ExecutionAgentRuleSnapshot | null> {
    const row = (await this.client.execute({
      sql: "SELECT value_json FROM config_entries WHERE scope_id = ? AND key = ?",
      args: [executionSnapshotScope(executionId), SNAPSHOT_KEY],
    })).rows[0];
    if (!row) return null;
    const parsed = storedSnapshot.safeParse(JSON.parse(String(row.value_json)));
    if (!parsed.success) {
      throw new Error(
        `stored Agent rule snapshot for execution ${executionId} is unreadable: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
      );
    }
    return parsed.data as unknown as ExecutionAgentRuleSnapshot;
  }
}
