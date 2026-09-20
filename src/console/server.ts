import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { costsPageZones, renderCostsRoute } from "./costs-page.js";
import { toOverviewCostAlertsView } from "./overview-cost-alerts.js";
import { renderOverviewCostAlertPage } from "./overview-cost-alert-page.js";
import { saveRequirementCostLimit } from "./requirement-cost-limit.js";
import {
  renderRequirementDetailPage,
  renderRequirementListPage,
  renderRequirementNotFoundPage,
  type RequirementSummaryRow,
} from "./requirement-detail-page.js";
import type {
  DailyCostReadResult,
  DailyCostSelection,
  DailyCostTimeZoneOption,
} from "./daily-costs.js";
import type { RequirementCostSnapshot } from "../persistence/requirement-cost-ledger.js";
import type {
  OverLimitRequirementSnapshot,
  RequirementCostLimitStore,
  RequirementCostWithLimitSnapshot,
} from "../persistence/requirement-cost-limit.js";
import type {
  RoleConfigurationChoiceReadPort,
  RoleConfigurationChoiceReadResult,
  RoleConfigurationDraft,
  RoleConfigurationEditingViewState,
  RoleConfigurationProviderChoice,
  RoleConfigurationReadPort,
  RoleConfigurationViewState,
  RoleConfigurationWritePort,
  RoleReference,
  RoleVersionPair,
} from "./role-configuration.js";
import type { RoleConfigurationMutationResult } from "../config/role-configuration-version.js";
import {
  FUTURE_AGENT_STARTS_SCOPE,
  draftFromVersion,
  draftFromWriteBody,
  isFutureAgentStartsScope,
  prepareRoleConfigurationSave,
  readRoleConfigurationChoices,
  readRoleConfigurationView,
  readRoleConfigurationWriteDraft,
  renderRoleConfigurationPage,
  resolveRoleConfigurationPageRequest,
  roleConfigurationRestoredMessage,
  roleConfigurationSavedMessage,
  roleDisplayName,
} from "./role-configuration.js";

export interface ConsoleDataSource {
  nodes(): Promise<unknown[]>;
  tasks(): Promise<unknown[]>;
  costs(): Promise<unknown[]>;
  config(): Promise<unknown[]>;
  stats(): Promise<unknown>;
  providers(): Promise<unknown[]>;
  /** What is waiting, what is running and who holds it. Read from the central
   * store: the queue is a set of rows there, and a board over a separate broker
   * would be a second account of the same thing, free to disagree with it. */
  queue(): Promise<unknown>;
  /** The natural-day zones the costs page may offer. Optional so a source that
   * cannot enumerate them offers none rather than a hand-kept list that drifts. */
  dailyCostTimeZones?(): Promise<readonly DailyCostTimeZoneOption[]>;
  /** One snapshot of daily costs for a selection, read from the central ledger. */
  dailyCosts?(selection: DailyCostSelection): Promise<DailyCostReadResult>;
  /** The requirements a person may open, newest first. */
  requirements?(): Promise<readonly RequirementSummaryRow[]>;
  /** One requirement's whole-history cost, or null when the id is unknown. */
  requirementCost?(requirementId: string): Promise<RequirementCostSnapshot | null>;
  /** One requirement's whole-history cost with its configured limit, or null. */
  requirementCostWithLimit?(requirementId: string): Promise<RequirementCostWithLimitSnapshot | null>;
  /** Every requirement that already exceeds its own limit, for the overview. */
  overLimitRequirements?(): Promise<readonly OverLimitRequirementSnapshot[]>;
  /** The write surface for requirement limits. A source holding the central
   * store publishes it here, so the console can offer the one write it owes
   * without every caller having to remember a second port. */
  requirementCostLimitStore?: RequirementCostLimitStore;
}

export interface ConsoleConfigWritePort {
  describe(): Promise<unknown[]>;
  apply(input: { key: string; value: unknown; updatedBy: string; confirm?: boolean }): Promise<unknown>;
  rollback(input: { key: string; version: number; updatedBy: string; confirm?: boolean }): Promise<unknown>;
  history(key: string): Promise<unknown[]>;
}

export interface ConsoleServerOptions {
  uiRoot?: string;
  serveUi?: boolean;
  /** Reads immutable role-version pairs without owning page selection state. */
  roleConfigurationReader?: RoleConfigurationReadPort;
  /** Lists provider/model pairs that may be selected for the chosen role. */
  roleConfigurationChoiceReader?: RoleConfigurationChoiceReadPort;
  /** Appends role-scoped versions through an optimistic current-version check. */
  roleConfigurationWriter?: RoleConfigurationWritePort;
  /**
   * Runs when the role page is opened, before it reads the versions to show.
   *
   * A host serving a fixed sample uses it to return to the versions its screens
   * are described in, so each scenario that opens the page starts from the
   * state its DoD names rather than from whatever a previous scenario saved. A
   * host holding the real history passes nothing and reads it unchanged; the
   * hook is only ever about the sample, never about hiding a saved version.
   */
  roleConfigurationPageOpened?: () => void | Promise<void>;
  /** The one write surface. Without it the console stays entirely read-only. */
  configWriter?: ConsoleConfigWritePort;
  /** The requirement-limit write surface. Without it the limit form has no
   * destination and the console stays read-only on this too. */
  costLimitStore?: RequirementCostLimitStore;
}

const moduleDir = dirname(fileURLToPath(import.meta.url));

/**
 * Where a built browser bundle is served from, when one exists.
 *
 * A bundle wins, but its absence is not an error: the console is mounted by
 * whatever process holds the central store, and the server-rendered costs page
 * below does not depend on a build. Returning null means the other routes were
 * never built, which is the state this repository is in while its interface is
 * being rebuilt page by page.
 */
export function findConsoleUiRoot(requested: string): string | null {
  const candidates = [...new Set([
    resolve(requested),
    resolve("console-ui/dist"),
    resolve("console-ui"),
    resolve(join(moduleDir, "..", "..", "console-ui")),
  ])];
  return candidates.find((candidate) => existsSync(join(candidate, "index.html"))) ?? null;
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    // Absent or unreadable are the same answer here: there is no built page to
    // serve at this path, and the caller keeps the server-rendered routes.
    return null;
  }
}

/** The HTTP status one mutation outcome is answered with. A rejection that
 * names a missing role or a non-adjacent restore source is a client error the
 * caller can act on, not a transient one to retry. */
function roleMutationStatus(result: RoleConfigurationMutationResult): number {
  switch (result.status) {
    case "saved": return 200;
    case "conflict": return 409;
    case "unavailable": return 503;
    case "rejected":
      if (result.reason === "unknown-role") return 404;
      if (result.reason === "source-is-not-previous") return 409;
      return 400;
  }
}

/** Reads the catalog and one role's pair for a page action, or null when the
 * read fails. The page that follows an action is built from this read. */
async function readRolePagePairFor(
  reader: RoleConfigurationReadPort | undefined,
  roleId: string,
): Promise<{ roles: readonly RoleReference[]; pair: RoleVersionPair } | null> {
  if (!reader || roleId === "") return null;
  try {
    const catalog = await reader.readCatalog();
    const roles = catalog.status === "ready" ? catalog.roles : [];
    const read = await reader.readVersionPair(roleId);
    if (read.status !== "ready") return null;
    return { roles, pair: read.pair };
  } catch {
    return null;
  }
}

/** Builds the read-only intranet console. */
export async function createConsoleServer(
  data: ConsoleDataSource,
  options: ConsoleServerOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  // Only what the mount point handed over. Falling back to the data source's
  // own store made a write surface appear because a reader happened to also be
  // able to write: scripts/serve-console.ts mounts the live database for a
  // verification round to look at, passes no ports at all, and was serving a
  // form that writes a requirement's cost limit into it.
  const costLimitStore = options.costLimitStore;
  const writable = new Set(options.configWriter
    ? ["/api/config/value", "/api/config/rollback"]
    : []);
  if (costLimitStore) writable.add("/costs/requirement-limit");
  // Role writes name the role in the path, so the gate matches the shape of
  // the two routes rather than the two literal urls. The page's own form posts
  // to one more path, which is writable only on the host that holds a writer.
  const roleWriteRoute = /^\/api\/roles\/[^/]+\/(?:versions|restore)$/;
  const roleWriter = options.roleConfigurationWriter;
  if (roleWriter) writable.add("/roles/action");
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_request, body, done) => {
      try {
        done(null, Object.fromEntries(new URLSearchParams(body as string)));
      } catch (cause) {
        done(cause as Error);
      }
    },
  );
  app.addHook("onRequest", async (request, reply) => {
    if (request.method === "GET" || request.method === "HEAD") return;
    const path = request.url.split("?")[0] ?? "";
    // Config is the only thing an operator may change from here, and only
    // through the two routes the registry validates.
    if (request.method === "POST" && writable.has(path)) return;
    if (request.method === "POST" && roleWriter !== undefined && roleWriteRoute.test(path)) return;
    await reply.code(405).send({ error: "console is read-only" });
  });

  app.get("/health", async () => ({ status: "ok" }));
  app.get("/api/nodes", async () => data.nodes());
  app.get("/api/tasks", async () => data.tasks());
  app.get("/api/costs", async () => data.costs());

  // The costs page is a read of the central ledger, so it is served by the
  // process that holds it rather than behind `serveUi`: a host with the store
  // and no bundle still owes a person the screen. A source that cannot read
  // days renders the failure state instead of a 404.
  const renderCosts = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const query = (request.query ?? {}) as Record<string, string | undefined>;
    const zones = await costsPageZones(data);
    const read = (selection: DailyCostSelection): Promise<DailyCostReadResult> =>
      data.dailyCosts
        ? data.dailyCosts(selection)
        : Promise.resolve({ kind: "failed", message: "daily costs are not available" });
    const requirementRead = (requirementId: string): Promise<RequirementCostWithLimitSnapshot | null> =>
      data.requirementCostWithLimit
        ? data.requirementCostWithLimit(requirementId)
        : Promise.resolve(null);
    const html = await renderCostsRoute(query, zones, read, Date.now(), requirementRead);
    return reply.type("text/html").send(html);
  };
  app.get("/costs", renderCosts);

  // The overview is the first screen: what needs a person, what is running, and
  // which requirements are over their own limit. The alert is stated in words
  // and never translated into a paused state.
  app.get("/", async (_request, reply) => {
    const snapshots = data.overLimitRequirements ? await data.overLimitRequirements() : [];
    return reply.type("text/html").send(renderOverviewCostAlertPage({ alert: toOverviewCostAlertsView(snapshots) }));
  });

  // Saving a requirement limit is scoped to the one requirement named in the
  // form. Validation failures and stale forms come back as values, and a stale
  // form is a conflict rather than a silent overwrite.
  app.post("/costs/requirement-limit", async (request, reply) => {
    const store = costLimitStore;
    if (!store) return reply.code(404).send({ error: "requirement cost limits are not writable" });
    const body = (request.body ?? {}) as Record<string, string | undefined>;
    const requirementId = body.requirementId ?? "";
    const rawVersion = body.expectedVersion;
    const expectedVersion = rawVersion === undefined || rawVersion === "" ? null : Number(rawVersion);
    const response = await saveRequirementCostLimit({
      requirementId,
      rawLimitUsd: body.limitUsd ?? "",
      expectedVersion,
      actor: body.actor ?? "operator",
      nowMs: Date.now(),
    }, store);
    const outcome = response.kind === "saved" ? "limitSaved=1" : `limitError=${response.kind}`;
    return reply.redirect(`/costs?requirement=${encodeURIComponent(requirementId)}&${outcome}`, 303);
  });

  // A requirement's cumulative cost is the central ledger's answer, so it is
  // served by the same process that holds the store, whether or not a browser
  // bundle was built. The route is the person-visible half of the ledger read;
  // the JSON API below is for the pages that do not need a document.
  app.get("/requirements", async (request, reply) => {
    const requirements = data.requirements ? await data.requirements() : [];
    return reply.type("text/html").send(renderRequirementListPage(requirements));
  });
  app.get("/requirements/:id", async (request, reply) => {
    const requirementId = (request.params as { id: string }).id;
    if (!data.requirementCost) {
      return reply.code(404).type("text/html").send(renderRequirementNotFoundPage(requirementId));
    }
    const snapshot = await data.requirementCost(requirementId);
    if (snapshot === null) {
      return reply.code(404).type("text/html").send(renderRequirementNotFoundPage(requirementId));
    }
    const title = data.requirements
      ? (await data.requirements()).find((row) => row.id === requirementId)?.title ?? null
      : null;
    return reply.type("text/html").send(renderRequirementDetailPage(
      requirementId,
      title,
      snapshot,
      { locale: "zh-CN", timeZone: "Asia/Shanghai" },
    ));
  });
  app.get("/api/requirements/:id/cost", async (request, reply) => {
    if (!data.requirementCost) return reply.code(404).send({ error: "requirement costs are not available" });
    const requirementId = (request.params as { id: string }).id;
    const snapshot = await data.requirementCost(requirementId);
    if (snapshot === null) return reply.code(404).send({ error: "requirement not found" });
    return snapshot;
  });
  app.get("/api/costs/time-zones", async (_request, reply) => {
    if (!data.dailyCostTimeZones) return reply.code(404).send({ error: "daily cost time zones are not available" });
    return data.dailyCostTimeZones();
  });
  app.get("/api/costs/daily", async (request, reply) => {
    if (!data.dailyCosts) return reply.code(404).send({ error: "daily costs are not available" });
    const query = request.query as { timeZone?: string; startDate?: string; endDate?: string };
    if (!query.timeZone || !query.startDate || !query.endDate) {
      return reply.code(400).send({ error: "timeZone, startDate and endDate are required" });
    }
    const result = await data.dailyCosts({
      timeZone: query.timeZone,
      startDate: query.startDate,
      endDate: query.endDate,
    });
    if (result.kind === "invalid") return reply.code(400).send({ error: result.code, message: result.message });
    if (result.kind === "failed") return reply.code(500).send({ error: result.message });
    return result.snapshot;
  });
  app.get("/api/config", async () => data.config());
  app.get("/api/stats", async () => data.stats());
  app.get("/api/providers", async () => data.providers());
  app.get("/api/queue", async () => data.queue());

  // Role configuration is a read of the central history, so the process that
  // holds it serves both the JSON the screens fetch and the screen itself. An
  // absent reader is an unavailable read, not a 404 that reads like a missing
  // role: the page says what could not be read and keeps the chosen role.
  const roleReader = options.roleConfigurationReader;
  app.get("/api/roles", async (_request, reply) =>
    roleReader ? roleReader.readCatalog() : reply.code(404).send({ error: "role configuration is not available" }));
  app.get("/api/roles/:id/versions", async (request, reply) => {
    if (!roleReader) return reply.code(404).send({ error: "role configuration is not available" });
    const roleId = (request.params as { id: string }).id;
    return roleReader.readVersionPair(roleId);
  });
  app.get("/roles", async (request, reply) => {
    const query = (request.query ?? {}) as Record<string, string | undefined>;
    // Before anything is read: a sample host returns to its seeded versions
    // here, so the page a scenario opens shows the state that scenario names.
    await options.roleConfigurationPageOpened?.();
    const state = await readRoleConfigurationView(
      resolveRoleConfigurationPageRequest(query),
      roleReader,
      options.roleConfigurationChoiceReader,
    );
    return reply.type("text/html").send(renderRoleConfigurationPage(state));
  });

  // The page's own save and restore flow. The JSON routes above serve clients
  // that speak JSON; a browser posts its form here and every answer is the page
  // for the state the action produced. Nothing is written before the
  // confirmation step, and the draft travels in the form rather than on the
  // server, so a window that opened an older version submits what it showed and
  // loses its edits to nobody.
  app.post("/roles/action", async (request, reply) => {
    if (!roleWriter) return reply.code(404).send({ error: "role configuration is not writable" });
    const body = (request.body ?? {}) as Record<string, unknown>;
    const action = typeof body.action === "string" ? body.action : "";
    const roleId = typeof body.roleId === "string" ? body.roleId : "";
    const page = async (state: RoleConfigurationViewState) => reply.type("text/html").send(renderRoleConfigurationPage(state));
    const editing = (
      roles: readonly RoleReference[],
      pair: RoleVersionPair,
      draft: RoleConfigurationDraft,
      choices: readonly RoleConfigurationProviderChoice[] | null,
      status: RoleConfigurationEditingViewState["status"] = "editing",
      failure?: string,
    ): RoleConfigurationEditingViewState => ({
      status,
      roles,
      selectedRoleId: roleId,
      current: pair.current,
      previous: pair.previous,
      draft,
      ...(choices === null ? {} : { choices }),
      ...(failure === undefined ? {} : { failure }),
    });

    const read = await readRolePagePairFor(roleReader, roleId);
    if (read === null) {
      return page({ status: "error", roles: [], selectedRoleId: roleId === "" ? null : roleId, retryable: true });
    }
    const { roles, pair } = read;
    const roleLabel = roles.find((role) => role.id === roleId)?.label ?? roleDisplayName(roleId);
    const choices = await readRoleConfigurationChoices(options.roleConfigurationChoiceReader, roleId);
    const draft = draftFromWriteBody(draftFromVersion(pair.current, roleLabel), body, choices ?? undefined);
    const rawExpected = Number(body.expectedCurrentVersion);
    // The version the window showed, not the one the store holds now: a stale
    // window that sent the newer number would be allowed to overwrite.
    const expectedCurrentVersion = Number.isFinite(rawExpected) ? rawExpected : pair.current.version;
    const requestedBy = typeof body.requestedBy === "string" && body.requestedBy !== "" ? body.requestedBy : "owner";

    if (action === "cancel") return page(editing(roles, pair, draft, choices));
    if (action === "prepare-save") {
      const preparation = prepareRoleConfigurationSave(draft, pair.current);
      if (preparation.status === "scope-required") {
        return page(editing(roles, pair, draft, choices, "scope-required"));
      }
      return page({
        status: "save-confirmation",
        roles,
        selectedRoleId: roleId,
        current: pair.current,
        previous: pair.previous,
        draft,
        ...(choices === null ? {} : { choices }),
      });
    }
    if (action === "prepare-restore") {
      if (pair.previous === null) {
        return page(editing(roles, pair, draft, choices, "save-failed", "这个角色还没有上一版配置，不能恢复。"));
      }
      return page({
        status: "restore-confirmation",
        roles,
        selectedRoleId: roleId,
        current: pair.current,
        previous: pair.previous,
      });
    }
    if (action === "confirm-save" || action === "confirm-restore") {
      const restoring = action === "confirm-restore";
      const sourceVersion = Number(body.sourceVersion);
      const result = restoring
        ? await roleWriter.restorePrevious({
          roleId,
          expectedCurrentVersion,
          sourceVersion: Number.isFinite(sourceVersion) ? sourceVersion : 0,
          effectScope: FUTURE_AGENT_STARTS_SCOPE,
          requestedBy,
        })
        : await roleWriter.saveNewVersion({
          roleId,
          expectedCurrentVersion,
          effectScope: FUTURE_AGENT_STARTS_SCOPE,
          content: { prompt: draft.prompt, providerId: draft.provider.id, modelId: draft.model.id },
          requestedBy,
        });
      // Read back rather than trusting the mutation's own snapshot: the screen a
      // person sees next is the store's account of the result, and the two can
      // only disagree when something else wrote in between.
      const after = await readRolePagePairFor(roleReader, roleId);
      const afterRoles = after?.roles ?? roles;
      if (result.status === "saved" && after !== null) {
        return page({
          status: restoring ? "restored" : "saved",
          roles: afterRoles,
          selectedRoleId: roleId,
          current: after.pair.current,
          previous: after.pair.previous,
          message: restoring
            ? roleConfigurationRestoredMessage(roleLabel, after.pair.current.version, sourceVersion)
            : roleConfigurationSavedMessage(roleLabel, after.pair.current.version),
        });
      }
      if (result.status === "conflict") {
        return page(editing(afterRoles, after?.pair ?? pair, draft, choices, "conflict"));
      }
      return page(editing(
        afterRoles,
        after?.pair ?? pair,
        draft,
        choices,
        "save-failed",
        result.status === "unavailable"
          ? (result.detail ?? "暂时无法保存，请稍后重试。")
          : "这次保存没有被接受，请检查配置后重试。",
      ));
    }
    return page(editing(roles, pair, draft, choices));
  });

  // The choices a role may pick from are read per role, so a model that only
  // exists for another role never appears here. An unreadable catalogue is a
  // retryable answer and never an invented option list.
  app.get("/api/roles/:id/choices", async (request, reply) => {
    const choices = options.roleConfigurationChoiceReader;
    if (!choices) return reply.code(404).send({ error: "role configuration choices are not available" });
    const roleId = (request.params as { id: string }).id;
    let result: RoleConfigurationChoiceReadResult;
    try {
      result = await choices.readChoices(roleId);
    } catch (cause) {
      return reply.code(503).send({ status: "unavailable", retryable: true, detail: (cause as Error).message });
    }
    if (result.status === "unavailable") return reply.code(503).send(result);
    return result;
  });

  // A confirmed save or restore is the only role write here. The scope is
  // checked from the literal value, so a body that does not say the change is
  // only for later agents is refused before anything is appended.
  app.post("/api/roles/:id/versions", async (request, reply) => {
    if (!roleWriter) return reply.code(404).send({ error: "role configuration is not writable" });
    const roleId = (request.params as { id: string }).id;
    const body = (request.body ?? {}) as Record<string, unknown>;
    const draft = readRoleConfigurationWriteDraft(roleId, body);
    if (!isFutureAgentStartsScope(body.effectScope)) {
      return reply.code(400).send({ status: "scope-required", draft });
    }
    const result = await roleWriter.saveNewVersion({
      roleId,
      expectedCurrentVersion: draft.expectedCurrentVersion,
      effectScope: FUTURE_AGENT_STARTS_SCOPE,
      content: { prompt: draft.prompt, providerId: draft.providerId, modelId: draft.modelId },
      requestedBy: typeof body.requestedBy === "string" ? body.requestedBy : "",
    });
    if (result.status === "saved") {
      return reply.code(200).send({
        status: "saved",
        message: roleConfigurationSavedMessage(draft.roleLabel, result.current.version),
        current: result.current,
        previousVersion: result.previousVersion,
      });
    }
    if (result.status === "conflict") {
      return reply.code(409).send({
        status: "conflict",
        message: `当前版已更新为 v${result.current.version}。你的修改尚未保存，请检查后再保存。`,
        draft,
        current: result.current,
      });
    }
    return reply.code(roleMutationStatus(result)).send({ ...result, draft });
  });

  app.post("/api/roles/:id/restore", async (request, reply) => {
    if (!roleWriter) return reply.code(404).send({ error: "role configuration is not writable" });
    const roleId = (request.params as { id: string }).id;
    const body = (request.body ?? {}) as Record<string, unknown>;
    const draft = readRoleConfigurationWriteDraft(roleId, body);
    if (!isFutureAgentStartsScope(body.effectScope)) {
      return reply.code(400).send({ status: "scope-required", draft });
    }
    const sourceVersion = Number(body.sourceVersion);
    const result = await roleWriter.restorePrevious({
      roleId,
      expectedCurrentVersion: draft.expectedCurrentVersion,
      sourceVersion: Number.isFinite(sourceVersion) ? sourceVersion : 0,
      effectScope: FUTURE_AGENT_STARTS_SCOPE,
      requestedBy: typeof body.requestedBy === "string" ? body.requestedBy : "",
    });
    if (result.status === "saved") {
      return reply.code(200).send({
        status: "saved",
        message: roleConfigurationRestoredMessage(roleDisplayName(roleId), result.current.version, sourceVersion),
        current: result.current,
        previousVersion: result.previousVersion,
      });
    }
    if (result.status === "conflict") {
      return reply.code(409).send({
        status: "conflict",
        message: `当前版已更新为 v${result.current.version}。你的修改尚未保存，请检查后再保存。`,
        draft,
        current: result.current,
      });
    }
    return reply.code(roleMutationStatus(result)).send({ ...result, draft });
  });

  const writer = options.configWriter;
  if (writer) {
    app.get("/api/config/schema", async () => writer.describe());
    app.get("/api/config/history", (request, reply) => {
      const key = (request.query as { key?: string }).key;
      if (!key) return reply.code(400).send({ error: "key is required" });
      return writer.history(key);
    });
    app.post("/api/config/value", async (request, reply) => {
      const body = request.body as { key?: string; value?: unknown; updatedBy?: string; confirm?: boolean };
      if (!body?.key || !body.updatedBy) return reply.code(400).send({ error: "key and updatedBy are required" });
      try {
        return await writer.apply({ key: body.key, value: body.value, updatedBy: body.updatedBy, confirm: body.confirm === true });
      } catch (cause) {
        return reply.code(422).send({ error: (cause as Error).message });
      }
    });
    app.post("/api/config/rollback", async (request, reply) => {
      const body = request.body as { key?: string; version?: number; updatedBy?: string; confirm?: boolean };
      if (!body?.key || typeof body.version !== "number" || !body.updatedBy) {
        return reply.code(400).send({ error: "key, version and updatedBy are required" });
      }
      try {
        return await writer.rollback({ key: body.key, version: body.version, updatedBy: body.updatedBy, confirm: body.confirm === true });
      } catch (cause) {
        return reply.code(422).send({ error: (cause as Error).message });
      }
    });
  }

  if (options.serveUi !== false) {
    const uiRoot = findConsoleUiRoot(options.uiRoot ?? "console-ui/dist");
    const index = uiRoot === null ? null : await readOptional(join(uiRoot, "index.html"));
    if (uiRoot !== null && index !== null) {
      const assets = join(uiRoot, "assets");
      if (existsSync(assets)) {
        await app.register(fastifyStatic, { root: assets, prefix: "/assets/" });
      }
      // A built shell owns the remaining pages; `/` and `/costs` stay with the
      // server-rendered costs page, which exists whether or not a build ran.
      for (const route of ["/nodes", "/tasks", "/config", "/stats", "/providers", "/queue"]) {
        app.get(route, async (_request, reply) => reply.type("text/html").send(index));
      }
    }
  }
  return app;
}

/** Refuses public wildcard binds; deployment must opt into a concrete intranet IP. */
export async function listenConsole(
  app: FastifyInstance,
  options: { host?: string; port?: number } = {},
): Promise<string> {
  const host = options.host ?? "127.0.0.1";
  if (host === "0.0.0.0" || host === "::") throw new Error("console cannot bind a public wildcard address");
  return app.listen({ host, port: options.port ?? 3210 });
}
