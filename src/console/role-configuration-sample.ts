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
  type RoleConfigurationReadPort,
  type RoleConfigurationVersion,
  type RoleReference,
  type RoleVersionPair,
  type RoleVersionPairReadResult,
} from "./role-configuration.js";

/**
 * The roles the prototype's selector lists, the one under review first so the
 * page opens on the pair the definition of done describes.
 */
const ROLES: readonly RoleReference[] = [
  { id: "prototype", label: "prototype" },
  { id: "product-manager", label: "product-manager" },
  { id: "engineer", label: "engineer" },
  { id: "reviewer", label: "reviewer" },
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
function firstVersionOf(role: RoleReference): RoleVersionPair {
  return {
    roleId: role.id,
    current: {
      roleId: role.id,
      version: 1,
      savedAt: "2026-06-01T00:00:00.000Z",
      prompt: `${role.id} 角色的初始 Prompt。`,
      provider: { id: "anthropic", label: "Anthropic" },
      model: { id: "claude-sonnet-4", label: "Claude Sonnet 4" },
    },
    previous: null,
    difference: null,
  };
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
