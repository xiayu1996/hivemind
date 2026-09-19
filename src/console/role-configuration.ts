export type RoleId = string;

export interface RoleReference {
  id: RoleId;
  label: string;
}

export interface RoleModelReference {
  id: string;
  label: string;
}

/** An immutable, complete snapshot created by one confirmed role-config save. */
export interface RoleConfigurationVersion {
  roleId: RoleId;
  version: number;
  savedAt: string;
  prompt: string;
  provider: RoleModelReference;
  model: RoleModelReference;
}

export interface RoleFieldDifference<T> {
  current: T;
  previous: T;
  changed: boolean;
}

export interface CurrentPromptDifferenceSegment {
  kind: "unchanged" | "added";
  text: string;
}

export interface PreviousPromptDifferenceSegment {
  kind: "unchanged" | "removed";
  text: string;
}

/**
 * Segments preserve source order and content. Joining currentPrompt yields the
 * current prompt; joining previousPrompt yields the previous prompt.
 */
export interface RoleConfigurationDifference {
  currentPrompt: readonly CurrentPromptDifferenceSegment[];
  previousPrompt: readonly PreviousPromptDifferenceSegment[];
  provider: RoleFieldDifference<RoleModelReference>;
  model: RoleFieldDifference<RoleModelReference>;
}

export declare function compareRoleConfigurationVersions(
  current: RoleConfigurationVersion,
  previous: RoleConfigurationVersion,
): RoleConfigurationDifference;

export interface RoleVersionPair {
  roleId: RoleId;
  current: RoleConfigurationVersion;
  previous: RoleConfigurationVersion | null;
  difference: RoleConfigurationDifference | null;
}

export type RoleCatalogReadResult =
  | { status: "ready"; roles: readonly RoleReference[] }
  | { status: "empty" }
  | { status: "unavailable"; retryable: true; detail?: string };

export type RoleVersionPairReadResult =
  | { status: "ready"; pair: RoleVersionPair }
  | {
    status: "waiting";
    roleId: RoleId;
    confirmedPair: RoleVersionPair;
    pendingSaveId: string;
  }
  | { status: "unavailable"; roleId: RoleId; retryable: true; detail?: string };

/**
 * Reads role snapshots from the central configuration history. Implementations
 * must read each pair from one consistent snapshot and return only adjacent
 * versions belonging to the requested role.
 */
export interface RoleConfigurationReadPort {
  readCatalog(): Promise<RoleCatalogReadResult>;
  readVersionPair(roleId: RoleId): Promise<RoleVersionPairReadResult>;
}

/** The page owns selection and rejects responses for a superseded role id. */
export type RoleConfigurationViewState =
  | { status: "loading"; selectedRoleId: RoleId | null }
  | { status: "empty" }
  | {
    status: "ready";
    roles: readonly RoleReference[];
    selectedRoleId: RoleId;
    pair: RoleVersionPair;
  }
  | {
    status: "error";
    roles: readonly RoleReference[];
    selectedRoleId: RoleId | null;
    retryable: true;
  }
  | {
    status: "waiting";
    roles: readonly RoleReference[];
    selectedRoleId: RoleId;
    confirmedPair: RoleVersionPair;
    pendingSaveId: string;
  };
