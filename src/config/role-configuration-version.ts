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
