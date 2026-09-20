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
    const state = await readRoleConfigurationView(resolveRoleConfigurationPageRequest(query), roleReader);
    return reply.type("text/html").send(renderRoleConfigurationPage(state));
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
