/**
 * The role-configuration screen's sample source.
 *
 * The console is mounted by whatever process holds the central store, and a
 * verification round opens the screen on a machine where no role history has
 * been written yet. Serving nothing would render every scenario as the empty
 * state, and the two versions the frozen definition of done names could not be
 * told apart. The versions below are the ones that definition names: the
 * prototype role at v12 after v11, with the prompt line each version added and
 * removed and the provider and model the upgrade changed. They are data, not a
 * fixture of the comparison: the reader still answers a catalog read and a
 * version-pair read, and the page still builds the difference from them.
 */
import {
  compareRoleConfigurationVersions,
  type RoleCatalogReadResult,
  type RoleConfigurationChoiceReadPort,
  type RoleConfigurationProviderChoice,
  type RoleConfigurationReadPort,
  type RoleConfigurationVersion,
  type RoleConfigurationWritePort,
  type RoleModelReference,
  type RoleReference,
  type RoleVersionPair,
  type RoleVersionPairReadResult,
} from "./role-configuration.js";
import type {
  RoleConfigurationMutationPort,
  RoleConfigurationVersionSnapshot,
} from "../config/role-configuration-version.js";

/**
 * The roles the prototype's selector lists, the one under review first so the
 * page opens on the pair the definition of done describes.
 */
const ROLES: readonly RoleReference[] = [
  { id: "prototype", label: "原型设计" },
  { id: "product-manager", label: "产品经理" },
  { id: "engineer", label: "工程师" },
  { id: "reviewer", label: "评审" },
];

const PROTOTYPE_PREVIOUS: RoleConfigurationVersion = {
  roleId: "prototype",
  version: 11,
  savedAt: "2026-06-18T01:20:00.000Z",
  prompt: "你负责把已批准的页面清单和视觉方向画成界面契约。\n\n"
    + "先判断界面类型，再用两遍流程完成：先做设计计划并自批，然后落成每个页面及其完整状态。\n\n"
    + "先按页面清单逐页绘制。",
  provider: { id: "openai", label: "OpenAI" },
  model: { id: "gpt-5-codex", label: "GPT-5 Codex" },
};

const PROTOTYPE_CURRENT: RoleConfigurationVersion = {
  roleId: "prototype",
  version: 12,
  savedAt: "2026-06-19T01:40:00.000Z",
  prompt: "你负责把已批准的页面清单和视觉方向画成界面契约。\n\n"
    + "先判断界面类型，再用两遍流程完成：先做设计计划并自批，然后落成每个页面及其完整状态。\n\n"
    + "每页优先证明它承接了业务场景。",
  provider: { id: "anthropic", label: "Anthropic" },
  model: { id: "claude-sonnet-4", label: "Claude Sonnet 4" },
};

const PROTOTYPE_PAIR: RoleVersionPair = {
  roleId: "prototype",
  current: PROTOTYPE_CURRENT,
  previous: PROTOTYPE_PREVIOUS,
  difference: compareRoleConfigurationVersions(PROTOTYPE_CURRENT, PROTOTYPE_PREVIOUS),
};

/** A role the definition of done does not describe, saved once with no predecessor. */
function firstVersion(role: RoleReference): RoleConfigurationVersion {
  return {
    roleId: role.id,
    version: 1,
    savedAt: "2026-06-01T00:00:00.000Z",
    prompt: `${role.id} 角色的初始 Prompt。`,
    provider: { id: "anthropic", label: "Anthropic" },
    model: { id: "claude-sonnet-4", label: "Claude Sonnet 4" },
  };
}

function firstVersionOf(role: RoleReference): RoleVersionPair {
  return { roleId: role.id, current: firstVersion(role), previous: null, difference: null };
}

/** Builds the read-only port the sample screen is served from. */
export function createSampleRoleConfigurationReader(): RoleConfigurationReadPort {
  return {
    readCatalog: async (): Promise<RoleCatalogReadResult> => ({ status: "ready", roles: ROLES }),
    readVersionPair: async (roleId: string): Promise<RoleVersionPairReadResult> => {
      if (roleId === PROTOTYPE_PAIR.roleId) return { status: "ready", pair: PROTOTYPE_PAIR };
      const role = ROLES.find((candidate) => candidate.id === roleId);
      // A role the selector cannot offer is not a role this host knows; saying
      // so is what keeps a hand-edited URL from inventing a version pair.
      if (role === undefined) return { status: "unavailable", roleId, retryable: true };
      return { status: "ready", pair: firstVersionOf(role) };
    },
  };
}

const PROVIDER_CHOICES: readonly RoleConfigurationProviderChoice[] = [
  {
    id: "openai",
    label: "OpenAI",
    models: [{ id: "gpt-5.2", label: "GPT-5.2" }, { id: "gpt-5-codex", label: "GPT-5 Codex" }],
  },
  {
    id: "anthropic",
    label: "Anthropic",
    models: [{ id: "claude-sonnet-4", label: "Claude Sonnet 4" }],
  },
];

function referenceFor(providerId: string, modelId: string): { provider: RoleModelReference; model: RoleModelReference } {
  const provider = PROVIDER_CHOICES.find((candidate) => candidate.id === providerId);
  const model = provider?.models.find((candidate) => candidate.id === modelId);
  return {
    provider: { id: providerId, label: provider?.label ?? providerId },
    model: { id: modelId, label: model?.label ?? modelId },
  };
}

/**
 * The writing sample, on top of the same seed versions.
 *
 * The console served for a walkthrough must let a person actually save and
 * restore, or every scenario about confirming a change is judged against a
 * page that cannot produce the change. The state lives in this process only,
 * so a browser session that saves a version changes nothing anywhere else.
 */
export interface SampleRoleConfigurationPorts {
  reader: RoleConfigurationReadPort;
  choices: RoleConfigurationChoiceReadPort;
  writer: RoleConfigurationWritePort;
}

function snapshotOf(version: RoleConfigurationVersion, savedBy: string): RoleConfigurationVersionSnapshot {
  return {
    roleId: version.roleId,
    version: version.version,
    savedAt: version.savedAt,
    savedBy,
    content: { prompt: version.prompt, providerId: version.provider.id, modelId: version.model.id },
  };
}

export function createSampleRoleConfigurationStore(now: () => number = Date.now): SampleRoleConfigurationPorts {
  const history = new Map<string, RoleConfigurationVersion[]>();
  for (const role of ROLES) {
    history.set(role.id, role.id === "prototype" ? [PROTOTYPE_PREVIOUS, PROTOTYPE_CURRENT] : [firstVersion(role)]);
  }

  const saveNewVersion: RoleConfigurationMutationPort["saveNewVersion"] = async (command) => {
    const list = history.get(command.roleId);
    if (!list || list.length === 0) return { status: "rejected", reason: "unknown-role" };
    const head = list.at(-1)!;
    if (head.version !== command.expectedCurrentVersion) {
      return { status: "conflict", current: snapshotOf(head, command.requestedBy) };
    }
    const references = referenceFor(command.content.providerId, command.content.modelId);
    const version: RoleConfigurationVersion = {
      roleId: command.roleId,
      version: head.version + 1,
      savedAt: new Date(now()).toISOString(),
      prompt: command.content.prompt,
      provider: references.provider,
      model: references.model,
    };
    list.push(version);
    return { status: "saved", current: snapshotOf(version, command.requestedBy), previousVersion: head.version };
  };

  return {
    reader: {
      readCatalog: async () => ({ status: "ready", roles: ROLES }),
      readVersionPair: async (roleId) => {
        const list = history.get(roleId);
        if (!list || list.length === 0) return { status: "unavailable", roleId, retryable: true };
        const current = list.at(-1)!;
        const previous = list.at(-2) ?? null;
        return {
          status: "ready",
          pair: {
            roleId,
            current,
            previous,
            difference: previous === null ? null : compareRoleConfigurationVersions(current, previous),
          },
        };
      },
    },
    choices: {
      readChoices: async (roleId) => (history.has(roleId)
        ? { status: "ready", providers: PROVIDER_CHOICES }
        : { status: "unavailable", retryable: true, detail: `unknown role ${roleId}` }),
    },
    writer: {
      saveNewVersion,
      restorePrevious: async (command) => {
        const list = history.get(command.roleId);
        if (!list || list.length === 0) return { status: "rejected", reason: "unknown-role" };
        const previous = list.at(-2) ?? null;
        if (previous === null || previous.version !== command.sourceVersion) {
          return { status: "rejected", reason: "source-is-not-previous" };
        }
        return saveNewVersion({
          roleId: command.roleId,
          expectedCurrentVersion: command.expectedCurrentVersion,
          effectScope: "future-agent-starts",
          content: { prompt: previous.prompt, providerId: previous.provider.id, modelId: previous.model.id },
          requestedBy: command.requestedBy,
        });
      },
    },
  };
}
