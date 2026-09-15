import type { Client, InStatement } from "@libsql/client";
import { z } from "zod";
import {
  validateAgentRules,
  type AgentRules,
  type AgentRulesRepository,
  type ReplaceAgentRulesInput,
  type ReplaceAgentRulesResult,
  type VersionedAgentRules,
} from "./agent-rules.js";
import type { ModelTier } from "../pipeline/phase.js";

/**
 * The aggregate lives in one `config_entries` row rather than four, because a
 * complete rule is the unit an operator edits and a partial write would leave
 * the console showing a rule the pipeline never had. One row also makes the
 * revision a plain column: the CAS below is a single statement rather than a
 * lock across four keys.
 *
 * The key is deliberately not in CONFIG_KEYS. The generic write surface
 * validates one key at a time and cannot express "the default model must belong
 * to the default provider", so letting it reach this value would be a second,
 * weaker validator for the same data.
 */
export const AGENT_RULES_KEY = "model.agentRules";
const AGENT_RULES_SCOPE = "global";

const storedAgentRules = z.object({
  defaultProvider: z.string(),
  defaultModel: z.string(),
  providerStates: z.record(z.string(), z.enum(["enabled", "disabled"])),
  failoverOrder: z.array(z.string()),
}).strict();

/** The provider record the default rule is derived from. Only the tier map is
 * read: credentials, billing and auth never enter the rule. */
export interface ProviderTierMap {
  tiers: Partial<Record<ModelTier, string>>;
}

/**
 * The rule a fresh installation runs on, derived from the declared provider
 * universe. Providers missing from the failover chain are appended rather than
 * dropped, because the rule validator refuses a proposal that does not name
 * every configured provider exactly once and a default that cannot be saved is
 * not a default.
 */
export function initialAgentRules(
  providers: Readonly<Record<string, ProviderTierMap>>,
  failoverChain: readonly string[],
): AgentRules {
  const configured = Object.keys(providers).toSorted();
  const order = [
    ...failoverChain.filter((provider) => provider in providers),
    ...configured.filter((provider) => !failoverChain.includes(provider)),
  ];
  const defaultProvider = order[0] ?? "";
  const tiers = providers[defaultProvider]?.tiers ?? {};
  return {
    defaultProvider,
    defaultModel: tiers.brain ?? tiers.standard ?? tiers.cheap ?? "",
    providerStates: Object.fromEntries(order.map((provider) => [provider, "enabled"])),
    failoverOrder: order,
  };
}

/**
 * The global rule in central libsql.
 *
 * `replace` validates first and commits the whole rule only if the stored
 * revision still equals the one the operator edited: a rejected or stale
 * proposal writes nothing, so readers observe either the previous complete rule
 * or the new complete rule. History and the audit event are guarded by the same
 * committed revision, so a losing race leaves no trace of a rule that never
 * existed.
 */
export class LibsqlAgentRulesRepository implements AgentRulesRepository {
  constructor(
    private readonly client: Client,
    private readonly fallback: AgentRules,
    private readonly now: () => number = Date.now,
  ) {}

  async read(): Promise<VersionedAgentRules> {
    const row = (await this.client.execute({
      sql: "SELECT value_json, version FROM config_entries WHERE scope_id = ? AND key = ?",
      args: [AGENT_RULES_SCOPE, AGENT_RULES_KEY],
    })).rows[0];
    if (!row) return { revision: 0, rules: this.fallback };
    const parsed = storedAgentRules.safeParse(JSON.parse(String(row.value_json)));
    if (!parsed.success) {
      // A rule that no longer parses must not be silently replaced by the code
      // defaults: the console would then show a policy the pipeline has never
      // run, and the stored one would be lost on the next save.
      throw new Error(`stored agent rules are unreadable: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
    }
    return { revision: Number(row.version), rules: parsed.data };
  }

  async replace(input: ReplaceAgentRulesInput): Promise<ReplaceAgentRulesResult> {
    const current = await this.read();
    const validation = validateAgentRules(input.proposal, input.validation);
    if (!validation.accepted) {
      return { saved: false, reason: "validation", current, rejection: validation.rejection };
    }
    if (current.revision !== input.expectedRevision) {
      return { saved: false, reason: "revision_conflict", current };
    }

    const rules = validation.rules;
    const revision = input.expectedRevision + 1;
    const valueJson = JSON.stringify(rules);
    const updatedAt = this.now();
    const runId = `config:${AGENT_RULES_KEY}`;
    const commitGuard = "SELECT version FROM config_entries WHERE scope_id = ? AND key = ?";
    const statements: InStatement[] = [
      {
        // The version guard makes this a compare-and-swap even when two writers
        // read the same revision: the loser's update matches no row and writes
        // nothing, and its history and event rows see the old version below.
        sql: `INSERT INTO config_entries (scope_id, key, value_json, version, updated_by, updated_at)
              VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(scope_id, key) DO UPDATE SET
                value_json = excluded.value_json,
                version    = excluded.version,
                updated_by = excluded.updated_by,
                updated_at = excluded.updated_at
              WHERE config_entries.version = ?`,
        args: [AGENT_RULES_SCOPE, AGENT_RULES_KEY, valueJson, revision, input.updatedBy, updatedAt, input.expectedRevision],
      },
      {
        sql: `INSERT INTO config_history (scope_id, key, version, value_json, updated_by, ts)
              SELECT ?, ?, ?, ?, ?, ?
               WHERE (${commitGuard}) = ?`,
        args: [AGENT_RULES_SCOPE, AGENT_RULES_KEY, revision, valueJson, input.updatedBy, updatedAt, AGENT_RULES_SCOPE, AGENT_RULES_KEY, revision],
      },
      {
        sql: `INSERT INTO event_log (run_id, seq, card_id, phase, type, ts, data)
              SELECT ?, (SELECT COALESCE(MAX(seq), -1) + 1 FROM event_log WHERE run_id = ?),
                     NULL, NULL, 'config.changed', ?, ?
               WHERE (${commitGuard}) = ?`,
        args: [runId, runId, updatedAt, JSON.stringify({ key: AGENT_RULES_KEY, updatedBy: input.updatedBy, previous: current.rules, next: rules }),
               AGENT_RULES_SCOPE, AGENT_RULES_KEY, revision],
      },
    ];
    const [upsert] = await this.client.batch(statements, "write");
    if (upsert?.rowsAffected !== 1) {
      return { saved: false, reason: "revision_conflict", current: await this.read() };
    }
    return { saved: true, current: { revision, rules } };
  }
}

/**
 * A process-local rule store. It exists so a console started without a central
 * database is still a working console -- the code defaults are the fallback
 * truth, and a page that cannot show them would be hiding the policy the
 * pipeline runs on. A production console injects the libsql repository above.
 */
export class InMemoryAgentRulesRepository implements AgentRulesRepository {
  private current: VersionedAgentRules;

  constructor(initial: AgentRules) {
    this.current = { revision: 0, rules: initial };
  }

  async read(): Promise<VersionedAgentRules> {
    return this.current;
  }

  async replace(input: ReplaceAgentRulesInput): Promise<ReplaceAgentRulesResult> {
    const current = this.current;
    const validation = validateAgentRules(input.proposal, input.validation);
    if (!validation.accepted) {
      return { saved: false, reason: "validation", current, rejection: validation.rejection };
    }
    if (current.revision !== input.expectedRevision) {
      return { saved: false, reason: "revision_conflict", current };
    }
    this.current = { revision: current.revision + 1, rules: validation.rules };
    return { saved: true, current: this.current };
  }
}
