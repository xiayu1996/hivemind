import type {
  RestorePreviousRoleConfigurationCommand,
  RoleConfigurationMutationPort,
  RoleConfigurationMutationResult,
  SaveRoleConfigurationCommand,
} from "../config/role-configuration-version.js";

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

/**
 * Sentence boundaries, terminator included. Diffing whole sentences rather than
 * characters keeps a rewritten sentence readable as one added and one removed
 * line instead of a cloud of fragments, and joining the segments back always
 * reproduces the prompt byte-for-byte.
 */
const PROMPT_SENTENCE = /[^。！？!?\n]*[。！？!?\n]|[^。！？!?\n]+$/g;

function splitPromptIntoSentences(prompt: string): string[] {
  return prompt.match(PROMPT_SENTENCE) ?? [];
}

function compareReferences(
  current: RoleModelReference,
  previous: RoleModelReference,
): RoleFieldDifference<RoleModelReference> {
  return {
    current,
    previous,
    changed: current.id !== previous.id || current.label !== previous.label,
  };
}

interface PromptSegments {
  current: CurrentPromptDifferenceSegment[];
  previous: PreviousPromptDifferenceSegment[];
}

/**
 * Ordered diff of the two prompts' sentences. Reads order from the longest
 * common subsequence, so a sentence only present in the current prompt is
 * `added`, one only in the previous prompt is `removed`, and shared sentences
 * stay `unchanged` on both sides.
 */
function diffPromptSentences(current: readonly string[], previous: readonly string[]): PromptSegments {
  const rows = current.length;
  const columns = previous.length;
  const lengths: number[][] = Array.from({ length: rows + 1 }, () => Array.from({ length: columns + 1 }, () => 0));
  for (let row = rows - 1; row >= 0; row -= 1) {
    for (let column = columns - 1; column >= 0; column -= 1) {
      lengths[row]![column] = current[row] === previous[column]
        ? lengths[row + 1]![column + 1]! + 1
        : Math.max(lengths[row + 1]![column]!, lengths[row]![column + 1]!);
    }
  }

  const segments: PromptSegments = { current: [], previous: [] };
  let row = 0;
  let column = 0;
  while (row < rows && column < columns) {
    if (current[row] === previous[column]) {
      segments.current.push({ kind: "unchanged", text: current[row]! });
      segments.previous.push({ kind: "unchanged", text: previous[column]! });
      row += 1;
      column += 1;
      continue;
    }
    // Equal-length options leave the extra current sentence as added, which is
    // the side a person reads first and the only one the change belongs to.
    if (lengths[row + 1]![column]! >= lengths[row]![column + 1]!) {
      segments.current.push({ kind: "added", text: current[row]! });
      row += 1;
    } else {
      segments.previous.push({ kind: "removed", text: previous[column]! });
      column += 1;
    }
  }
  while (row < rows) {
    segments.current.push({ kind: "added", text: current[row]! });
    row += 1;
  }
  while (column < columns) {
    segments.previous.push({ kind: "removed", text: previous[column]! });
    column += 1;
  }
  return segments;
}

export function compareRoleConfigurationVersions(
  current: RoleConfigurationVersion,
  previous: RoleConfigurationVersion,
): RoleConfigurationDifference {
  const segments = diffPromptSentences(
    splitPromptIntoSentences(current.prompt),
    splitPromptIntoSentences(previous.prompt),
  );
  return {
    currentPrompt: segments.current,
    previousPrompt: segments.previous,
    provider: compareReferences(current.provider, previous.provider),
    model: compareReferences(current.model, previous.model),
  };
}

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

export interface RoleConfigurationProviderChoice extends RoleModelReference {
  models: readonly RoleModelReference[];
}

export type RoleConfigurationChoiceReadResult =
  | { status: "ready"; providers: readonly RoleConfigurationProviderChoice[] }
  | { status: "unavailable"; retryable: true; detail?: string };

/** Reads only choices valid for a new version of the selected role. */
export interface RoleConfigurationChoiceReadPort {
  readChoices(roleId: RoleId): Promise<RoleConfigurationChoiceReadResult>;
}

export interface RoleConfigurationDraft {
  roleId: RoleId;
  roleLabel: string;
  baseVersion: number;
  prompt: string;
  provider: RoleModelReference;
  model: RoleModelReference;
  futureAgentsOnlyConfirmed: boolean;
}

export interface RoleConfigurationRestorePreparation {
  status: "confirmation-required";
  roleLabel: string;
  current: RoleConfigurationVersion;
  source: RoleConfigurationVersion;
}

export type RoleConfigurationSavePreparation =
  | { status: "scope-required"; draft: RoleConfigurationDraft }
  | {
    status: "confirmation-required";
    draft: RoleConfigurationDraft;
    current: RoleConfigurationVersion;
  };

/**
 * Purely prepares the confirmation dialog. It performs no write, and the page
 * remains the owner of the draft until a final mutation result is accepted. An
 * unconfirmed effect scope comes back as a reason to keep the draft on screen,
 * never as an opened dialog: a person who has not said the change is only for
 * later agents must not be walked past the one thing the dialog exists to say.
 */
export function prepareRoleConfigurationSave(
  draft: RoleConfigurationDraft,
  current: RoleConfigurationVersion,
): RoleConfigurationSavePreparation {
  if (draft.futureAgentsOnlyConfirmed !== true) return { status: "scope-required", draft };
  return { status: "confirmation-required", draft, current };
}

/**
 * Prepares an exact-copy restore confirmation without changing either version.
 * The source is the adjacent previous version, so the dialog can name what will
 * be copied and state that the version the person is looking at stays current
 * until they confirm.
 */
export function prepareRoleConfigurationRestore(
  roleLabel: string,
  current: RoleConfigurationVersion,
  previous: RoleConfigurationVersion,
): RoleConfigurationRestorePreparation {
  return { status: "confirmation-required", roleLabel, current, source: previous };
}

/**
 * Business names for the roles this console knows. A write carries the label
 * the page already displays; this map is the fallback for a write named by its
 * id alone, so a saved version's message never falls back to an internal
 * identifier a person would not recognise. An id with no entry reads as itself.
 */
const ROLE_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  prototype: "原型设计",
  "product-manager": "产品经理",
  engineer: "工程师",
  reviewer: "评审",
};

export function roleDisplayName(roleId: RoleId): string {
  return ROLE_DISPLAY_NAMES[roleId] ?? roleId;
}

/** What the page says once a save has produced a new current version. */
export function roleConfigurationSavedMessage(roleLabel: string, version: number): string {
  return `已保存为 v${version}。新配置只用于之后新开始的${roleLabel}智能体。`;
}

/** What the page says once a restore has copied the previous version forward. */
export function roleConfigurationRestoredMessage(
  roleLabel: string,
  version: number,
  sourceVersion: number,
): string {
  return `已恢复为 v${version}。内容来自 v${sourceVersion}，只用于之后新开始的${roleLabel}智能体。`;
}

/**
 * The console adapts this port to HTTP. Conflict and rejection results leave
 * the caller-owned draft unchanged; only `saved` replaces the displayed pair.
 */
export interface RoleConfigurationWritePort extends RoleConfigurationMutationPort {
  saveNewVersion(command: SaveRoleConfigurationCommand): Promise<RoleConfigurationMutationResult>;
  restorePrevious(command: RestorePreviousRoleConfigurationCommand): Promise<RoleConfigurationMutationResult>;
}

/**
 * The edit one write carries, as the wire keeps it: the service validates the
 * whole shape here, so a rejected request can come back with every value the
 * person typed instead of a form that lost half of them.
 */
export interface RoleConfigurationWriteDraft {
  roleId: RoleId;
  roleLabel: string;
  expectedCurrentVersion: number;
  prompt: string;
  providerId: string;
  modelId: string;
  futureAgentsOnlyConfirmed: boolean;
}

/**
 * The one effect scope a write may name. It is a value rather than prose the
 * server checks loosely: `current-and-future` used to be an accepted body, and
 * a save that claimed to change running agents was stored as if it did not.
 */
export const FUTURE_AGENT_STARTS_SCOPE = "future-agent-starts";

export function isFutureAgentStartsScope(value: unknown): value is typeof FUTURE_AGENT_STARTS_SCOPE {
  return value === FUTURE_AGENT_STARTS_SCOPE;
}

/** Reads the three role-owned values and the scope out of a submitted body. */
export function readRoleConfigurationWriteDraft(
  roleId: RoleId,
  body: Readonly<Record<string, unknown>>,
): RoleConfigurationWriteDraft {
  const expected = Number(body.expectedCurrentVersion);
  return {
    roleId,
    roleLabel: typeof body.roleLabel === "string" && body.roleLabel !== "" ? body.roleLabel : roleDisplayName(roleId),
    expectedCurrentVersion: Number.isFinite(expected) ? expected : 0,
    prompt: typeof body.prompt === "string" ? body.prompt : "",
    providerId: typeof body.providerId === "string" ? body.providerId : "",
    modelId: typeof body.modelId === "string" ? body.modelId : "",
    futureAgentsOnlyConfirmed: isFutureAgentStartsScope(body.effectScope),
  };
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
  }
  | RoleConfigurationEditingViewState
  | RoleConfigurationRestoreConfirmationViewState
  | RoleConfigurationResultViewState;

/**
 * The page while a draft is being edited. `save-confirmation` and
 * `scope-required` are the two answers the preparation can give; `conflict` is
 * a rejected stale write, and it keeps the same draft on screen because the
 * person's edits are the one thing a conflict must not discard. `save-failed`
 * is a write that could not be attempted at all, which is also no reason to
 * throw the draft away.
 */
export interface RoleConfigurationEditingViewState {
  status: "editing" | "save-confirmation" | "scope-required" | "conflict" | "save-failed";
  roles: readonly RoleReference[];
  selectedRoleId: RoleId;
  current: RoleConfigurationVersion;
  previous: RoleConfigurationVersion | null;
  draft: RoleConfigurationDraft;
  /** The provider/model pairs the selected role may choose from. */
  choices?: readonly RoleConfigurationProviderChoice[];
  /** Why the last confirmed write did not land, when it did not. */
  failure?: string;
}

/** A restore waiting for its final confirmation; nothing is written yet. */
export interface RoleConfigurationRestoreConfirmationViewState {
  status: "restore-confirmation";
  roles: readonly RoleReference[];
  selectedRoleId: RoleId;
  current: RoleConfigurationVersion;
  previous: RoleConfigurationVersion;
}

/** The confirmed outcome: the new current version and what it means. */
export interface RoleConfigurationResultViewState {
  status: "saved" | "restored";
  roles: readonly RoleReference[];
  selectedRoleId: RoleId;
  current: RoleConfigurationVersion;
  previous: RoleConfigurationVersion | null;
  message: string;
}

/** One of the four states the interface contract exposes directly. */
export type RoleConfigurationForcedState = "empty" | "loading" | "error" | "waiting";

export interface RoleConfigurationPageRequest {
  /** Set when the page is opened with `?state=`, so each state is a URL. */
  forcedState: RoleConfigurationForcedState | null;
  /** The role the person selected, carried in `?role=`. */
  roleId: RoleId | null;
  /** Set when the page is opened with `?edit=1`, which shows the draft form. */
  editing: boolean;
}

/** Turns the query string into the role and state the page should show. */
export function resolveRoleConfigurationPageRequest(
  query: Readonly<Record<string, string | undefined>>,
): RoleConfigurationPageRequest {
  const state = query.state;
  const forcedState = state === "empty" || state === "loading" || state === "error" || state === "waiting"
    ? state
    : null;
  const role = query.role;
  return {
    forcedState,
    roleId: role !== undefined && role !== "" ? role : null,
    editing: query.edit === "1",
  };
}

async function readCatalog(
  reader: RoleConfigurationReadPort,
): Promise<RoleCatalogReadResult> {
  try {
    return await reader.readCatalog();
  } catch {
    // A reader that throws is the same answer as one that reports unavailable:
    // the catalog could not be read, and retrying is the only next step.
    return { status: "unavailable", retryable: true };
  }
}

async function readVersionPair(
  reader: RoleConfigurationReadPort,
  roleId: RoleId,
): Promise<RoleVersionPairReadResult> {
  try {
    return await reader.readVersionPair(roleId);
  } catch {
    return { status: "unavailable", roleId, retryable: true };
  }
}

function confirmedPairOf(read: RoleVersionPairReadResult): RoleVersionPair | null {
  if (read.status === "ready") return read.pair;
  if (read.status === "waiting") return read.confirmedPair;
  return null;
}

/**
 * Reads the state the page renders from the reader and the query. Selection is
 * only ever carried through: an unreadable pair keeps the chosen role on the
 * page, and a pending save can never be shown as the confirmed current version.
 * `?edit=1` turns a readable pair into the draft form, seeded from the current
 * version, so the person starts from what is actually in use.
 */
export async function readRoleConfigurationView(
  request: RoleConfigurationPageRequest,
  reader: RoleConfigurationReadPort | undefined,
  choicesReader?: RoleConfigurationChoiceReadPort,
): Promise<RoleConfigurationViewState> {
  if (request.forcedState === "loading") return { status: "loading", selectedRoleId: request.roleId };
  if (request.forcedState === "empty") return { status: "empty" };
  if (!reader) return { status: "error", roles: [], selectedRoleId: request.roleId, retryable: true };

  const catalog = await readCatalog(reader);
  if (catalog.status === "empty") return { status: "empty" };
  if (catalog.status === "unavailable") {
    return { status: "error", roles: [], selectedRoleId: request.roleId, retryable: true };
  }

  const selectedRoleId = request.roleId ?? catalog.roles.at(0)?.id ?? null;
  if (selectedRoleId === null) return { status: "empty" };

  const read = await readVersionPair(reader, selectedRoleId);
  if (request.forcedState === "error") {
    return { status: "error", roles: catalog.roles, selectedRoleId, retryable: true };
  }
  if (request.forcedState === "waiting") {
    const confirmedPair = confirmedPairOf(read);
    // A pending save shown without a confirmed pair would be a version nobody
    // confirmed; the natural read result is the honest answer instead.
    if (confirmedPair !== null) {
      return {
        status: "waiting",
        roles: catalog.roles,
        selectedRoleId,
        confirmedPair,
        pendingSaveId: read.status === "waiting" ? read.pendingSaveId : "preview",
      };
    }
  }

  if (request.editing && read.status === "ready") {
    const roleLabel = catalog.roles.find((role) => role.id === selectedRoleId)?.label ?? roleDisplayName(selectedRoleId);
    const choices = await readChoicesFor(choicesReader, selectedRoleId);
    return {
      status: "editing",
      roles: catalog.roles,
      selectedRoleId,
      current: read.pair.current,
      previous: read.pair.previous,
      draft: draftFromVersion(read.pair.current, roleLabel),
      ...(choices === null ? {} : { choices }),
    };
  }

  switch (read.status) {
    case "ready": return { status: "ready", roles: catalog.roles, selectedRoleId, pair: read.pair };
    case "waiting":
      return {
        status: "waiting",
        roles: catalog.roles,
        selectedRoleId,
        confirmedPair: read.confirmedPair,
        pendingSaveId: read.pendingSaveId,
      };
    case "unavailable":
      return { status: "error", roles: catalog.roles, selectedRoleId, retryable: true };
  }
}

/**
 * The choices for one role, or null when they cannot be read. A failed read
 * produces a form that offers only what the current version already uses, so
 * the person can still save the other fields rather than facing a dead page.
 */
export async function readRoleConfigurationChoices(
  choicesReader: RoleConfigurationChoiceReadPort | undefined,
  roleId: RoleId,
): Promise<readonly RoleConfigurationProviderChoice[] | null> {
  if (!choicesReader) return null;
  try {
    const result = await choicesReader.readChoices(roleId);
    return result.status === "ready" ? result.providers : null;
  } catch {
    return null;
  }
}

/** Seeds the draft form from the version that is in use, before any edit. */
export function draftFromVersion(
  version: RoleConfigurationVersion,
  roleLabel: string,
): RoleConfigurationDraft {
  return {
    roleId: version.roleId,
    roleLabel,
    baseVersion: version.version,
    prompt: version.prompt,
    provider: version.provider,
    model: version.model,
    futureAgentsOnlyConfirmed: false,
  };
}

/**
 * The draft the page submits, with labels recovered from the choices so the
 * confirmation dialog shows the same names the person selected. A value the
 * choice source does not list keeps its own id as its label rather than
 * disappearing, because a save of the other two fields must stay possible.
 */
export function draftFromWriteBody(
  seed: RoleConfigurationDraft,
  body: Readonly<Record<string, unknown>>,
  choices: readonly RoleConfigurationProviderChoice[] | undefined,
): RoleConfigurationDraft {
  const providerId = typeof body.providerId === "string" && body.providerId !== "" ? body.providerId : seed.provider.id;
  const provider = choices?.find((candidate) => candidate.id === providerId);
  const modelId = typeof body.modelId === "string" && body.modelId !== "" ? body.modelId : seed.model.id;
  const model = provider?.models.find((candidate) => candidate.id === modelId)
    ?? (modelId === seed.model.id ? seed.model : undefined);
  return {
    roleId: seed.roleId,
    roleLabel: typeof body.roleLabel === "string" && body.roleLabel !== "" ? body.roleLabel : seed.roleLabel,
    baseVersion: seed.baseVersion,
    prompt: typeof body.prompt === "string" ? body.prompt : seed.prompt,
    provider: { id: providerId, label: provider?.label ?? (providerId === seed.provider.id ? seed.provider.label : providerId) },
    model: { id: modelId, label: model?.label ?? modelId },
    futureAgentsOnlyConfirmed: isFutureAgentStartsScope(body.effectScope),
  };
}

/**
 * The choices for one role, or null when they cannot be read. A failed read
 * produces a form that offers only what the current version already uses, so
 * the person can still save the other fields rather than facing a dead page.
 */
async function readChoicesFor(
  choicesReader: RoleConfigurationChoiceReadPort | undefined,
  roleId: RoleId,
): Promise<readonly RoleConfigurationProviderChoice[] | null> {
  return readRoleConfigurationChoices(choicesReader, roleId);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** A stable, zone-labelled instant so two readers never disagree on the minute. */
export function formatRoleVersionTime(savedAt: string): string {
  const parsed = new Date(savedAt);
  if (Number.isNaN(parsed.getTime())) return savedAt;
  return `${parsed.getUTCFullYear()}-${pad(parsed.getUTCMonth() + 1)}-${pad(parsed.getUTCDate())}`
    + ` ${pad(parsed.getUTCHours())}:${pad(parsed.getUTCMinutes())} UTC`;
}

function renderCurrentPromptNotes(difference: RoleConfigurationDifference | null): string {
  if (difference === null) return "";
  const notes = difference.currentPrompt
    .filter((segment) => segment.kind === "added")
    .map((segment) => `<span class="diff-add">新增：${escapeHtml(segment.text)}</span>`)
    .join("");
  return notes === "" ? "" : `<p class="diff-notes">${notes}</p>`;
}

function renderPreviousPromptNotes(difference: RoleConfigurationDifference | null): string {
  if (difference === null) return "";
  const notes = difference.previousPrompt
    .filter((segment) => segment.kind === "removed")
    .map((segment) => `<span class="diff-remove">删除：${escapeHtml(segment.text)}</span>`)
    .join("");
  return notes === "" ? "" : `<p class="diff-notes">${notes}</p>`;
}

function renderReferenceChange(field: RoleFieldDifference<RoleModelReference>): string {
  if (!field.changed) return "";
  return ` <span class="diff-change">上一版：${escapeHtml(field.previous.label)} 已变更</span>`;
}

function renderCurrentPanel(pair: RoleVersionPair): string {
  const version = pair.current;
  const difference = pair.difference;
  return `<section class="panel" aria-labelledby="current-title"><div class="section-head">`
    + `<div><div class="version-label">当前版 v${version.version}</div><h2 id="current-title">编辑当前配置</h2></div>`
    + `<span class="status running" role="status">使用中</span></div>`
    + `<div class="section"><span class="field-label">版本时间</span>`
    + `<p><time datetime="${escapeHtml(version.savedAt)}">${escapeHtml(formatRoleVersionTime(version.savedAt))}</time></p></div>`
    + `<div class="section"><span class="field-label">模型供应商</span>`
    + `<p>${escapeHtml(version.provider.label)}${difference === null ? "" : renderReferenceChange(difference.provider)}</p></div>`
    + `<div class="section"><span class="field-label">模型</span>`
    + `<p>${escapeHtml(version.model.label)}${difference === null ? "" : renderReferenceChange(difference.model)}</p></div>`
    + `<div class="section"><span class="field-label">角色 Prompt</span>`
    + `<div class="prompt-box">${escapeHtml(version.prompt)}</div>${renderCurrentPromptNotes(difference)}</div>`
    + `</section>`;
}

function renderPreviousPanel(pair: RoleVersionPair): string {
  const version = pair.previous;
  if (version === null) {
    return `<section class="panel" aria-labelledby="previous-title"><div class="section-head">`
      + `<div><h2 id="previous-title">上一版配置</h2></div></div>`
      + `<div class="section"><p>这个角色还没有上一版配置。</p></div></section>`;
  }
  const difference = pair.difference;
  const provider = difference !== null && difference.provider.changed
    ? `<span class="diff-remove">${escapeHtml(version.provider.label)}</span> <span class="diff-change">已变更</span>`
    : escapeHtml(version.provider.label);
  const model = difference !== null && difference.model.changed
    ? `<span class="diff-remove">${escapeHtml(version.model.label)}</span> <span class="diff-change">已变更</span>`
    : escapeHtml(version.model.label);
  return `<section class="panel" aria-labelledby="previous-title"><div class="section-head">`
    + `<div><div class="version-label">上一版 v${version.version}</div><h2 id="previous-title">上一版配置</h2></div></div>`
    + `<div class="section"><span class="field-label">版本时间</span>`
    + `<p><time datetime="${escapeHtml(version.savedAt)}">${escapeHtml(formatRoleVersionTime(version.savedAt))}</time></p></div>`
    + `<div class="section"><span class="field-label">模型供应商</span><p>${provider}</p></div>`
    + `<div class="section"><span class="field-label">模型</span><p>${model}</p></div>`
    + `<div class="section"><span class="field-label">角色 Prompt</span>`
    + `<div class="prompt-box">${escapeHtml(version.prompt)}</div>${renderPreviousPromptNotes(difference)}</div>`
    + `<div class="section"><form method="post" action="/roles/action">`
    + `<input type="hidden" name="action" value="prepare-restore">`
    + `<input type="hidden" name="roleId" value="${escapeHtml(pair.roleId)}">`
    + `<input type="hidden" name="expectedCurrentVersion" value="${pair.current.version}">`
    + `<input type="hidden" name="sourceVersion" value="${version.version}">`
    + `<button type="submit" class="secondary" id="restore-role">恢复上一版</button></form></div>`
    + `</section>`;
}

function renderRoleSelector(
  roles: readonly RoleReference[],
  selectedRoleId: RoleId | null,
): string {
  const options = roles
    .map((role) => `<option value="${escapeHtml(role.id)}"${role.id === selectedRoleId ? " selected" : ""}>${escapeHtml(role.label)}</option>`)
    .join("");
  return `<form class="toolbar" method="get" action="/roles">`
    + `<div><label for="role-select">智能体角色</label>`
    + `<select id="role-select" name="role">${options}</select></div>`
    + `<button type="submit">查看配置</button></form>`;
}

function renderReady(state: Extract<RoleConfigurationViewState, { status: "ready" }>): string {
  return renderRoleSelector(state.roles, state.selectedRoleId)
    + `<div class="role-split" data-layout="split">`
    + renderCurrentPanel(state.pair)
    + renderPreviousPanel(state.pair)
    + `</div>`
    + `<p class="edit-entry"><a class="secondary button-link" href="/roles?role=${encodeURIComponent(state.selectedRoleId)}&edit=1">修改当前配置</a></p>`;
}

/**
 * The provider/model pairs the form may offer, as a map the cascade script
 * repopulates the model select from when the provider changes. All options are
 * still rendered server-side, so the form works with scripting disabled.
 */
function renderModelCascade(providers: readonly RoleConfigurationProviderChoice[]): string {
  if (providers.length === 0) return "";
  const catalog = JSON.stringify(Object.fromEntries(providers.map((provider) => [
    provider.id,
    provider.models.map((model) => ({ id: model.id, label: model.label })),
  ]))).replaceAll("<", "\\u003c");
  return `<script>(function(){var catalog=${catalog};`
    + `var provider=document.getElementById('provider');var model=document.getElementById('model');`
    + `if(!provider||!model)return;provider.addEventListener('change',function(){`
    + `var list=catalog[provider.value]||[];var current=model.value;model.innerHTML='';`
    + `list.forEach(function(entry){var option=document.createElement('option');option.value=entry.id;`
    + `option.textContent=entry.label;if(entry.id===current)option.selected=true;model.appendChild(option);});});})();</script>`;
}

/**
 * The editable form for one draft. The selected provider and model are always
 * offered even when the choice source omitted them, so a save confirmation
 * never shows a select whose current value is not among its options.
 */
function renderDraftForm(state: RoleConfigurationEditingViewState): string {
  const draft = state.draft;
  const listed = state.choices ?? [];
  const providers = listed.some((provider) => provider.id === draft.provider.id)
    ? listed
    : [...listed, { id: draft.provider.id, label: draft.provider.label, models: [draft.model] }];
  const providerOptions = providers
    .map((provider) => `<option value="${escapeHtml(provider.id)}"${provider.id === draft.provider.id ? " selected" : ""}>${escapeHtml(provider.label)}</option>`)
    .join("");
  const models = providers.find((provider) => provider.id === draft.provider.id)?.models ?? [draft.model];
  const modelOptions = (models.some((model) => model.id === draft.model.id) ? models : [...models, draft.model])
    .map((model) => `<option value="${escapeHtml(model.id)}"${model.id === draft.model.id ? " selected" : ""}>${escapeHtml(model.label)}</option>`)
    .join("");
  const roleLabel = escapeHtml(draft.roleLabel);
  return `<form class="panel" id="role-form" method="post" action="/roles/action">`
    + `<input type="hidden" name="action" value="prepare-save">`
    + `<input type="hidden" name="roleId" value="${escapeHtml(draft.roleId)}">`
    + `<div class="section-head"><div><div class="version-label">当前版 v${state.current.version}</div>`
    + `<h2>编辑当前配置</h2></div><span class="status running">使用中</span></div>`
    + `<div class="section"><label for="provider">模型供应商</label>`
    + `<select id="provider" name="providerId">${providerOptions}</select></div>`
    + `<div class="section"><label for="model">模型</label>`
    + `<select id="model" name="modelId">${modelOptions}</select></div>`
    + `<div class="section"><label for="prompt-current">角色 Prompt</label>`
    + `<textarea id="prompt-current" name="prompt">${escapeHtml(draft.prompt)}</textarea></div>`
    + `<label class="choice section"><input id="future-only" type="checkbox" name="effectScope" value="future-agent-starts"${draft.futureAgentsOnlyConfirmed ? " checked" : ""}>`
    + `<span>我确认新配置只用于之后新开始的${roleLabel}智能体，已开始工作的智能体不变。</span></label>`
    + `<input type="hidden" name="expectedCurrentVersion" value="${state.current.version}">`
    + `<input type="hidden" name="roleLabel" value="${roleLabel}">`
    + `<button type="submit">保存为新版本</button>${renderModelCascade(providers)}</form>`;
}

function renderEditing(state: RoleConfigurationEditingViewState): string {
  const notice = state.status === "editing"
    ? ""
    : state.status === "scope-required"
      ? `<p class="validation" role="alert">保存前请确认生效范围，避免误以为正在工作的智能体会切换配置。</p>`
      : state.status === "save-failed"
        ? `<p class="validation" role="alert">${escapeHtml(state.failure ?? "暂时无法保存，请稍后重试。")}</p>`
        : `<p class="validation" role="alert">当前版已更新为 v${state.current.version}。你的修改尚未保存，请检查后再保存。</p>`;
  const pair: RoleVersionPair = {
    roleId: state.selectedRoleId,
    current: state.current,
    previous: state.previous,
    difference: null,
  };
  return renderRoleSelector(state.roles, state.selectedRoleId)
    + notice
    + `<div class="role-split" data-layout="split">`
    + renderDraftForm(state)
    + renderPreviousPanel(pair)
    + `</div>`;
}

/**
 * The hidden fields one dialog submit carries. The draft lives in the form
 * rather than on the server, so a second window that opened the older version
 * submits the version it actually showed.
 */
function dialogDraftFields(
  action: string,
  roleId: RoleId,
  expectedCurrentVersion: number,
  draft: RoleConfigurationDraft,
): string {
  return `<input type="hidden" name="action" value="${escapeHtml(action)}">`
    + `<input type="hidden" name="roleId" value="${escapeHtml(roleId)}">`
    + `<input type="hidden" name="expectedCurrentVersion" value="${expectedCurrentVersion}">`
    + `<input type="hidden" name="roleLabel" value="${escapeHtml(draft.roleLabel)}">`
    + `<input type="hidden" name="prompt" value="${escapeHtml(draft.prompt)}">`
    + `<input type="hidden" name="providerId" value="${escapeHtml(draft.provider.id)}">`
    + `<input type="hidden" name="modelId" value="${escapeHtml(draft.model.id)}">`
    + `<input type="hidden" name="effectScope" value="future-agent-starts">`;
}

/**
 * The dialog restates the role, all three changes and the scope, because that
 * is the one moment before an irreversible new version exists. It offers only
 * the final action and cancel; nothing is written while it is open.
 */
function renderSaveConfirmation(state: RoleConfigurationEditingViewState): string {
  const draft = state.draft;
  const roleLabel = escapeHtml(draft.roleLabel);
  return renderRoleSelector(state.roles, state.selectedRoleId)
    + `<div class="dialog-backdrop"><div class="dialog" role="dialog" aria-modal="true" aria-labelledby="save-dialog-title">`
    + `<h2 id="save-dialog-title">保存${roleLabel}角色的新配置？</h2>`
    + `<div class="section"><span class="field-label">角色</span><p>${roleLabel}</p></div>`
    + `<div class="section"><span class="field-label">角色说明</span><div class="prompt-box">${escapeHtml(draft.prompt)}</div></div>`
    + `<div class="section"><span class="field-label">模型供应商</span><p>${escapeHtml(draft.provider.label)}</p></div>`
    + `<div class="section"><span class="field-label">模型</span><p>${escapeHtml(draft.model.label)}</p></div>`
    + `<div class="notice"><p>只用于之后新开始的${roleLabel}智能体，已开始工作的智能体不变。</p></div>`
    + `<form method="post" action="/roles/action">`
    + dialogDraftFields("confirm-save", state.selectedRoleId, state.current.version, draft)
    + `<input type="hidden" name="previousVersion" value="${state.current.version}">`
    + `<div class="dialog-actions"><button type="submit">保存为新版本</button>`
    + `<button type="submit" name="action" value="cancel" class="secondary">取消</button></div></form></div></div>`;
}

function renderRestoreConfirmation(state: RoleConfigurationRestoreConfirmationViewState): string {
  const roleLabel = state.roles.find((role) => role.id === state.selectedRoleId)?.label ?? state.selectedRoleId;
  return renderRoleSelector(state.roles, state.selectedRoleId)
    + `<div class="dialog-backdrop"><div class="dialog" role="dialog" aria-modal="true" aria-labelledby="restore-dialog-title">`
    + `<h2 id="restore-dialog-title">恢复${escapeHtml(roleLabel)}角色的上一版？</h2>`
    + `<p>将复制 v${state.previous.version} 的完整配置并生成新版本。</p>`
    + `<p>只影响之后新开始的${escapeHtml(roleLabel)}智能体，已经开始工作的智能体不变。</p>`
    + `<form method="post" action="/roles/action">`
    + `<input type="hidden" name="action" value="confirm-restore">`
    + `<input type="hidden" name="roleId" value="${escapeHtml(state.selectedRoleId)}">`
    + `<input type="hidden" name="expectedCurrentVersion" value="${state.current.version}">`
    + `<input type="hidden" name="sourceVersion" value="${state.previous.version}">`
    + `<input type="hidden" name="effectScope" value="future-agent-starts">`
    + `<div class="dialog-actions"><button type="submit">恢复上一版</button>`
    + `<button type="submit" name="action" value="cancel" class="secondary">取消</button></div></form></div></div>`;
}

function renderResult(state: RoleConfigurationResultViewState): string {
  const pair: RoleVersionPair = {
    roleId: state.selectedRoleId,
    current: state.current,
    previous: state.previous,
    difference: state.previous === null ? null : compareRoleConfigurationVersions(state.current, state.previous),
  };
  return renderRoleSelector(state.roles, state.selectedRoleId)
    + `<p class="result-message" role="status">${escapeHtml(state.message)}</p>`
    + `<div class="role-split" data-layout="split">`
    + renderCurrentPanel(pair)
    + renderPreviousPanel(pair)
    + `</div>`;
}

function renderState(state: RoleConfigurationViewState): string {
  switch (state.status) {
    case "ready": return renderReady(state);
    case "save-confirmation": return renderSaveConfirmation(state);
    case "editing":
    case "scope-required":
    case "save-failed":
    case "conflict": return renderEditing(state);
    case "restore-confirmation": return renderRestoreConfirmation(state);
    case "saved":
    case "restored": return renderResult(state);
    case "empty":
      return `<section class="state-page"><div class="state-card">`
        + `<h2>还没有角色配置</h2>`
        + `<p>创建首个角色配置后，可以在这里查看 Prompt、供应商、模型和版本差异。</p>`
        + `<button type="button">创建首个配置</button></div></section>`;
    case "loading":
      return `<section class="state-page" aria-live="polite"><div class="state-card">`
        + `<h2>正在读取角色版本</h2>`
        + `<p>正在加载当前版、上一版及 Prompt 差异，请稍候。</p></div></section>`;
    case "error":
      return renderRoleSelector(state.roles, state.selectedRoleId)
        + `<section class="state-page"><div class="state-card">`
        + `<h2>无法读取角色配置</h2>`
        + `<p>当前版和上一版没有载入。检查内网连接后重新读取；已有配置不会改变。</p>`
        + `<button type="button" class="retry">重新读取</button></div></section>`;
    case "waiting":
      return renderRoleSelector(state.roles, state.selectedRoleId)
        + `<section class="state-page"><div class="state-card">`
        + `<h2>正在等待配置保存</h2>`
        + `<p>新版本尚未确认保存；确认前仍使用原当前版，已经开始工作的智能体不会改变。</p>`
        + `<button type="button" class="retry">检查保存结果</button></div></section>`
        + `<div class="role-split" data-layout="split">`
        + renderCurrentPanel(state.confirmedPair)
        + renderPreviousPanel(state.confirmedPair)
        + `</div>`;
    default: return "";
  }
}

function renderStatusChip(state: RoleConfigurationViewState): string {
  if (state.status === "ready") return `<span class="status running">当前版 v${state.pair.current.version}</span>`;
  if (state.status === "waiting") {
    return `<span class="status running">当前版 v${state.confirmedPair.current.version}</span>`;
  }
  if (state.status === "saved" || state.status === "restored") {
    return `<span class="status success">当前版 v${state.current.version}</span>`;
  }
  if (state.status === "save-confirmation" || state.status === "scope-required" || state.status === "conflict"
    || state.status === "editing" || state.status === "save-failed") {
    return `<span class="status running">当前版 v${state.current.version}</span>`;
  }
  if (state.status === "restore-confirmation") {
    return `<span class="status running">当前版 v${state.current.version}</span>`;
  }
  return "";
}

const ROLE_CONFIGURATION_PAGE_STYLE = [
  ":root{--color-action:#173f63;--color-attention:#a75b00;--color-border:#cbd5df;--color-danger:#b42318;",
  "--color-page:#f4f7fa;--color-surface:#fff;--color-surface-attention:#fff4df;--color-surface-danger:#fff0ef;",
  "--color-success:#18794e;--color-surface-success:#eaf7f0;",
  "--color-surface-selected:#e9f1f8;--color-text:#172b3a;--color-text-muted:#526477;",
  "--font-interface:'IBM Plex Sans','Segoe UI',sans-serif;--font-numeric:'IBM Plex Mono','SFMono-Regular',monospace;",
  "--space-gutter:28px;--space-gap:12px;--radius-panel:10px;--radius-control:6px;--radius-pill:999px;--layer-navigation:20}",
  "*{box-sizing:border-box}body{margin:0;background:var(--color-page);color:var(--color-text);font-family:var(--font-interface);font-size:14px}",
  ".shell{display:grid;grid-template-columns:220px 1fr;min-height:100vh}",
  ".sidebar{background:var(--color-surface);border-right:1px solid var(--color-border);padding:var(--space-gutter)}",
  ".brand{font-weight:700;margin-bottom:20px}.brand small{display:block;color:var(--color-text-muted);font-size:12px;font-weight:400}",
  ".nav{display:flex;flex-direction:column;gap:4px}.nav-link{color:var(--color-text);text-decoration:none;padding:8px 10px;border-radius:var(--radius-control)}.nav-link[aria-current=page]{background:var(--color-surface-selected);color:var(--color-action);font-weight:550}",
  "main{padding:var(--space-gutter)}",
  ".page-head{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:20px}.page-head h1{font-size:26px;margin:0 0 6px}.page-head p{margin:0;color:var(--color-text-muted)}",
  ".toolbar{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end;margin-bottom:20px}.toolbar div{display:flex;flex-direction:column;gap:4px}",
  "label{color:var(--color-text-muted);font-size:12px}select{min-height:44px;min-width:160px;padding:8px 10px;border:1px solid var(--color-border);border-radius:var(--radius-control);background:var(--color-surface);color:var(--color-text)}",
  "button{min-height:44px;min-width:44px;padding:8px 16px;border-radius:var(--radius-control);border:1px solid var(--color-action);background:var(--color-action);color:#fff;font-weight:550}",
  "button.secondary{background:var(--color-surface);color:var(--color-action)}",
  ".button-link{display:inline-block;min-height:44px;line-height:26px;padding:8px 16px;border-radius:var(--radius-control);border:1px solid var(--color-action);background:var(--color-surface);color:var(--color-action);font-weight:550;text-decoration:none}",
  ".edit-entry{margin:16px 0 0}",
  "textarea{width:100%;min-height:120px;padding:8px 10px;border:1px solid var(--color-border);border-radius:var(--radius-control);background:var(--color-surface);color:var(--color-text);font-family:var(--font-interface);font-size:14px}",
  ".choice{display:flex;align-items:center;gap:8px;color:var(--color-text);font-size:14px}",
  ".validation{background:var(--color-surface-attention);color:var(--color-attention);border:1px solid var(--color-border);border-radius:var(--radius-control);padding:10px 12px;margin-bottom:12px}",
  ".notice{background:var(--color-surface-attention);color:var(--color-attention);border-radius:var(--radius-control);padding:10px 12px}.notice p{margin:0}",
  ".result-message{background:var(--color-surface-success);color:var(--color-success);border-radius:var(--radius-control);padding:10px 12px;margin-bottom:12px}",
  ".dialog-backdrop{position:fixed;inset:0;background:#172b3a55;display:flex;align-items:center;justify-content:center;z-index:var(--layer-navigation);padding:16px}",
  ".dialog{background:var(--color-surface);border:1px solid var(--color-border);border-radius:var(--radius-panel);padding:20px;max-width:560px;width:100%;box-shadow:0 2px 8px #172b3a14}",
  ".dialog h2{font-size:18px;margin:0 0 12px}.dialog-actions{display:flex;gap:8px;margin-top:16px}",
  ".status.success{background:var(--color-surface-success);color:var(--color-success)}",
  ".role-split{display:grid;grid-template-columns:1fr 1fr;gap:20px;align-items:stretch}",
  ".panel{background:var(--color-surface);border:1px solid var(--color-border);border-radius:var(--radius-panel);padding:16px}",
  ".section{margin-top:12px}.section-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}.section-head h2{font-size:18px;margin:0}",
  ".field-label,.version-label{color:var(--color-text-muted);font-size:12px}.version-label{font-family:var(--font-numeric)}",
  ".prompt-box{white-space:pre-wrap;background:var(--color-page);border:1px solid var(--color-border);border-radius:var(--radius-control);padding:12px;margin-top:4px}",
  ".diff-notes{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0 0}",
  ".diff-add{background:var(--color-surface-attention);color:var(--color-attention);border-radius:2px;padding:0 2px}",
  ".diff-remove{background:var(--color-surface-danger);color:var(--color-danger);border-radius:2px;padding:0 2px}",
  ".diff-change{color:var(--color-attention)}",
  ".status{display:inline-block;padding:2px 10px;border-radius:var(--radius-pill);font-size:12px}.status.running{background:var(--color-surface-selected);color:var(--color-action)}",
  ".state-page{display:flex;justify-content:center;padding:40px 0}.state-card{background:var(--color-surface);border:1px solid var(--color-border);border-radius:var(--radius-panel);padding:24px;max-width:520px}",
  ".state-card h2{font-size:18px;margin:0 0 8px}.mobile-nav{display:none}",
  "@media (max-width:760px){.shell{grid-template-columns:1fr}.sidebar{display:none}main{padding:16px}.role-split{grid-template-columns:1fr;align-items:start}",
  ".mobile-nav{display:flex;position:sticky;bottom:0;background:var(--color-surface);border-top:1px solid var(--color-border);justify-content:space-around;padding:8px 0}",
  ".mobile-link{padding:8px 12px;text-decoration:none;color:var(--color-text)}.mobile-link[aria-current=page]{color:var(--color-action);font-weight:550}}",
].join("");

/** The complete role-configuration document, one document per reachable state. */
export function renderRoleConfigurationPage(state: RoleConfigurationViewState): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>智能体角色配置｜Hivemind</title><style>${ROLE_CONFIGURATION_PAGE_STYLE}</style></head><body>`
    + `<div class="shell"><aside class="sidebar"><div class="brand">Hivemind<small>内网运行控制台</small></div>`
    + `<nav class="nav" aria-label="主要导航">`
    + `<a class="nav-link" href="/">运行总览</a>`
    + `<a class="nav-link" href="/costs">费用分析</a>`
    + `<a class="nav-link" aria-current="page" href="/roles">角色配置</a>`
    + `<a class="nav-link" href="/records">工作记录</a>`
    + `</nav><div class="network-note">家庭网络 · 已连接</div></aside>`
    + `<main><header class="page-head"><div><h1>智能体角色配置</h1>`
    + `<p>修改只影响之后新开始的智能体；已经开始工作的智能体继续使用原配置。</p></div>`
    + renderStatusChip(state) + `</header>`
    + renderState(state)
    + `</main></div>`
    + `<nav class="mobile-nav" aria-label="手机导航">`
    + `<a class="mobile-link" href="/">总览</a>`
    + `<a class="mobile-link" href="/costs">费用</a>`
    + `<a class="mobile-link" aria-current="page" href="/roles">配置</a>`
    + `<a class="mobile-link" href="/records">记录</a></nav>`
    + `</body></html>`;
}
