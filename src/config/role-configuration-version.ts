import type { Client, Row } from "@libsql/client";

export type RoleConfigurationId = string;
export type AgentRunId = string;

/** The three role-owned values copied into every immutable version. */
export interface RoleConfigurationContent {
  prompt: string;
  providerId: string;
  modelId: string;
}

export interface RoleConfigurationVersionSnapshot {
  roleId: RoleConfigurationId;
  version: number;
  savedAt: string;
  savedBy: string;
  content: RoleConfigurationContent;
}

/** The literal scope is part of the write contract, not only confirmation copy. */
export interface SaveRoleConfigurationCommand {
  roleId: RoleConfigurationId;
  expectedCurrentVersion: number;
  effectScope: "future-agent-starts";
  content: RoleConfigurationContent;
  requestedBy: string;
}

export interface RestorePreviousRoleConfigurationCommand {
  roleId: RoleConfigurationId;
  expectedCurrentVersion: number;
  sourceVersion: number;
  effectScope: "future-agent-starts";
  requestedBy: string;
}

export type RoleConfigurationMutationResult =
  | {
    status: "saved";
    current: RoleConfigurationVersionSnapshot;
    previousVersion: number;
  }
  | {
    status: "conflict";
    current: RoleConfigurationVersionSnapshot;
  }
  | {
    status: "rejected";
    reason: "unknown-role" | "invalid-provider" | "invalid-model" | "source-is-not-previous";
    detail?: string;
  }
  | { status: "unavailable"; retryable: true; detail?: string };

/**
 * Owns the current-version pointer and immutable role-version history in the
 * central store. A mutation compares `expectedCurrentVersion`, appends the
 * complete snapshot, and advances the pointer in one transaction. A failed
 * comparison appends nothing. The comparison is scoped to one role, so a save
 * cannot serialize against or update another role.
 */
export interface RoleConfigurationMutationPort {
  saveNewVersion(command: SaveRoleConfigurationCommand): Promise<RoleConfigurationMutationResult>;
  restorePrevious(command: RestorePreviousRoleConfigurationCommand): Promise<RoleConfigurationMutationResult>;
}

export interface AgentRoleConfigurationBinding {
  agentRunId: AgentRunId;
  roleId: RoleConfigurationId;
  roleVersion: number;
  boundAt: string;
  content: RoleConfigurationContent;
}

export type AgentRoleConfigurationBindingResult =
  | { status: "bound"; binding: AgentRoleConfigurationBinding; created: boolean }
  | { status: "unknown-role"; roleId: RoleConfigurationId }
  | {
    status: "binding-conflict";
    agentRunId: AgentRunId;
    boundRoleId: RoleConfigurationId;
  }
  | { status: "unavailable"; retryable: true; detail?: string };

/**
 * The orchestrator calls this exactly at an agent-run boundary. Implementations
 * atomically read that role's current version and insert the binding. Repeating
 * the same agentRunId and roleId returns the original binding, including after
 * a role save; reusing an agentRunId for another role is a conflict. A save
 * racing a first bind therefore yields either the complete old version or the
 * complete new version, never mixed fields.
 */
export interface AgentRoleConfigurationBindingPort {
  bindAtAgentStart(
    agentRunId: AgentRunId,
    roleId: RoleConfigurationId,
  ): Promise<AgentRoleConfigurationBindingResult>;
  readBinding(agentRunId: AgentRunId): Promise<AgentRoleConfigurationBinding | null>;
}

function toContent(row: Row): RoleConfigurationContent {
  return {
    prompt: String(row.prompt),
    providerId: String(row.provider_id),
    modelId: String(row.model_id),
  };
}

function toSnapshot(row: Row): RoleConfigurationVersionSnapshot {
  return {
    roleId: String(row.role_id),
    version: Number(row.version),
    savedAt: new Date(Number(row.saved_at)).toISOString(),
    savedBy: String(row.saved_by),
    content: toContent(row),
  };
}

function toBinding(row: Row): AgentRoleConfigurationBinding {
  return {
    agentRunId: String(row.agent_run_id),
    roleId: String(row.role_id),
    roleVersion: Number(row.role_version),
    boundAt: new Date(Number(row.bound_at)).toISOString(),
    content: toContent(row),
  };
}

/**
 * The central store behind both declared ports.
 *
 * A mutation is one conditional batch: the new version inserts only while the
 * head still names the version the caller expected, and the head update is
 * guarded by the same comparison. SQLite serialises the two racing batches, so
 * the loser's first statement inserts nothing and its second updates nothing --
 * no v14, no overwrite, and the winner's complete snapshot stands. Reading the
 * head and the source version happens before the batch, which is what makes
 * restore copy the exact adjacent previous content rather than re-deriving it.
 */
export class LibsqlRoleConfigurationStore
  implements RoleConfigurationMutationPort, AgentRoleConfigurationBindingPort
{
  private readonly now: () => number;

  constructor(private readonly client: Client, now: () => number = Date.now) {
    this.now = now;
  }

  async saveNewVersion(command: SaveRoleConfigurationCommand): Promise<RoleConfigurationMutationResult> {
    return this.appendVersion(
      command.roleId,
      command.expectedCurrentVersion,
      command.content,
      command.requestedBy,
    );
  }

  async restorePrevious(command: RestorePreviousRoleConfigurationCommand): Promise<RoleConfigurationMutationResult> {
    const head = await this.readHead(command.roleId);
    if (head === null) return { status: "rejected", reason: "unknown-role" };
    const previous = await this.readPreviousVersion(command.roleId, head);
    // Copying a version that is not the one shown beside the current one would
    // make the destination of a restore ambiguous; the caller names the source
    // and this store only accepts the adjacent previous version.
    if (previous === null || previous.version !== command.sourceVersion) {
      return { status: "rejected", reason: "source-is-not-previous" };
    }
    return this.appendVersion(command.roleId, command.expectedCurrentVersion, previous.content, command.requestedBy);
  }

  private async appendVersion(
    roleId: RoleConfigurationId,
    expectedCurrentVersion: number,
    content: RoleConfigurationContent,
    requestedBy: string,
  ): Promise<RoleConfigurationMutationResult> {
    const head = await this.readHead(roleId);
    if (head === null) return { status: "rejected", reason: "unknown-role" };

    const newVersion = expectedCurrentVersion + 1;
    const results = await this.client.batch([
      {
        sql: `INSERT INTO role_configuration_versions
                (role_id, version, prompt, provider_id, model_id, saved_at, saved_by)
              SELECT ?, ?, ?, ?, ?, ?, ?
               WHERE (SELECT current_version FROM role_configuration_heads WHERE role_id = ?) = ?`,
        args: [
          roleId,
          newVersion,
          content.prompt,
          content.providerId,
          content.modelId,
          this.now(),
          requestedBy,
          roleId,
          expectedCurrentVersion,
        ],
      },
      {
        sql: `UPDATE role_configuration_heads SET current_version = ?
               WHERE role_id = ? AND current_version = ?`,
        args: [newVersion, roleId, expectedCurrentVersion],
      },
    ], "write");

    if ((results[0]?.rowsAffected ?? 0) === 1 && (results[1]?.rowsAffected ?? 0) === 1) {
      const current = await this.readVersion(roleId, newVersion);
      if (current === null) return { status: "unavailable", retryable: true, detail: "saved version is not readable" };
      return { status: "saved", current, previousVersion: expectedCurrentVersion };
    }

    const currentHead = await this.readHead(roleId);
    if (currentHead === null) return { status: "rejected", reason: "unknown-role" };
    const current = await this.readVersion(roleId, currentHead);
    if (current === null) return { status: "unavailable", retryable: true, detail: "current version is not readable" };
    return { status: "conflict", current };
  }

  async bindAtAgentStart(
    agentRunId: AgentRunId,
    roleId: RoleConfigurationId,
  ): Promise<AgentRoleConfigurationBindingResult> {
    const existing = await this.readBinding(agentRunId);
    if (existing !== null) {
      if (existing.roleId !== roleId) {
        return { status: "binding-conflict", agentRunId, boundRoleId: existing.roleId };
      }
      return { status: "bound", binding: existing, created: false };
    }

    const head = await this.readHead(roleId);
    if (head === null) return { status: "unknown-role", roleId };
    const version = await this.readVersion(roleId, head);
    if (version === null) {
      return { status: "unavailable", retryable: true, detail: `role ${roleId} points at a missing version ${head}` };
    }

    const inserted = await this.client.execute({
      sql: `INSERT INTO role_agent_bindings
              (agent_run_id, role_id, role_version, prompt, provider_id, model_id, bound_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(agent_run_id) DO NOTHING`,
      args: [
        agentRunId,
        roleId,
        version.version,
        version.content.prompt,
        version.content.providerId,
        version.content.modelId,
        this.now(),
      ],
    });
    const binding = await this.readBinding(agentRunId);
    if (binding === null) return { status: "unavailable", retryable: true, detail: "binding is not readable after insert" };
    if (binding.roleId !== roleId) {
      return { status: "binding-conflict", agentRunId, boundRoleId: binding.roleId };
    }
    return { status: "bound", binding, created: inserted.rowsAffected === 1 };
  }

  async readBinding(agentRunId: AgentRunId): Promise<AgentRoleConfigurationBinding | null> {
    const row = (await this.client.execute({
      sql: "SELECT * FROM role_agent_bindings WHERE agent_run_id = ?",
      args: [agentRunId],
    })).rows[0];
    return row ? toBinding(row) : null;
  }

  private async readHead(roleId: RoleConfigurationId): Promise<number | null> {
    const row = (await this.client.execute({
      sql: "SELECT current_version FROM role_configuration_heads WHERE role_id = ?",
      args: [roleId],
    })).rows[0];
    return row ? Number(row.current_version) : null;
  }

  private async readVersion(
    roleId: RoleConfigurationId,
    version: number,
  ): Promise<RoleConfigurationVersionSnapshot | null> {
    const row = (await this.client.execute({
      sql: "SELECT * FROM role_configuration_versions WHERE role_id = ? AND version = ?",
      args: [roleId, version],
    })).rows[0];
    return row ? toSnapshot(row) : null;
  }

  private async readPreviousVersion(
    roleId: RoleConfigurationId,
    currentVersion: number,
  ): Promise<RoleConfigurationVersionSnapshot | null> {
    const row = (await this.client.execute({
      sql: `SELECT * FROM role_configuration_versions
             WHERE role_id = ? AND version < ?
             ORDER BY version DESC LIMIT 1`,
      args: [roleId, currentVersion],
    })).rows[0];
    return row ? toSnapshot(row) : null;
  }
}
