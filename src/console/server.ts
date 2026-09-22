import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { registerMobileConsoleRoutes, renderOperatorAccessPage, type MobileConsoleDependencies } from "./operator-screens.js";
import { createMobileConsoleSample } from "./operator-sample.js";
import type { ConsoleAccessPolicy } from "./operator-contract.js";
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
  /**
   * The console's network boundary. The gate runs as the first hook before
   * every route -- the read APIs, the static shell and the mobile screens -- so
   * a peer outside the allowed networks is answered with the access screen and
   * never with a row read from the store. A process that declares no policy
   * still gets the boundary the mobile screens carry; it is never left open.
   */
  access?: ConsoleAccessPolicy;
  /** The one write surface. Without it the console stays entirely read-only. */
  configWriter?: ConsoleConfigWritePort;
  /**
   * The mobile cost, record and role screens and their read ports. The sample
   * screen set is mounted when omitted, so the process that starts the console
   * always owes a person these screens rather than a route lookup; a process
   * holding durable ports replaces it here.
   */
  screens?: MobileConsoleDependencies;
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

/** Builds the read-only intranet console. */
export async function createConsoleServer(
  data: ConsoleDataSource,
  options: ConsoleServerOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  // The access boundary is the outermost layer: the mobile screens carry their
  // own copy for a direct registration, but a server that serves the read APIs
  // and the static shell has to close those too, or the screens are the only
  // thing the network check guarded. `/access` has to answer when denied, and
  // `/health` carries no operator data, so both stay reachable.
  //
  // The boundary is always on. A process that declares its own policy gets it;
  // otherwise the console closes on the same networks the mobile screens are
  // for, so a peer outside them is answered with the access screen rather than
  // a route lookup -- a deployed console that wired no policy answered with a
  // not-found page instead, which says nothing about the network a person has
  // to join.
  // The process that starts the console may not yet hold durable mobile read
  // ports. It must still register a usable screen rather than leaving a phone
  // at a route lookup; callers replace this sample set as soon as they own
  // those ports.
  const screens = options.screens ?? createMobileConsoleSample();
  const access = options.access ?? screens.access;
  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?")[0] ?? "";
    if (path === "/access" || path === "/operator/access" || path === "/health") return;
    const decision = access.decide({ remoteAddress: request.ip });
    if (decision.allowed) return;
    await reply.code(403).type("text/html; charset=utf-8").send(renderOperatorAccessPage(decision));
  });
  const writable = new Set(options.configWriter
    ? ["/api/config/value", "/api/config/rollback"]
    : []);
  // Role changes are the one write the mobile screens own; they go through the
  // role port, which validates and versions the change, so the read-only hook
  // lets those two paths through exactly as it does the config writes. The
  // screens are always mounted, so these are always writable.
  writable.add("/operator/roles");
  writable.add("/roles");
  // Only what the mount point handed over. Falling back to the data source's
  // own store made a write surface appear because a reader happened to also be
  // able to write: scripts/serve-console.ts mounts the live database for a
  // verification round to look at, passes no ports at all, and was serving a
  // form that writes a requirement's cost limit into it.
  const costLimitStore = options.costLimitStore;
  if (costLimitStore) writable.add("/costs/requirement-limit");
  // Screens a caller passed in own the page surface: they serve `/` and
  // `/costs` themselves, and fastify refuses a second handler for a route. The
  // sample fallback is mounted into a console that already answers those with
  // its own costs and overview pages, and it leaves them alone for that
  // reason. The read APIs, the health probe and the config writes are
  // unaffected -- they are the same answers whichever screens are in front of
  // them.
  const screensOwnPages = options.screens !== undefined;
  // The screens register the same parser for their own forms, and fastify
  // refuses a second one for a content type. It is the same parser either way.
  if (!screensOwnPages) {
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
  }
  app.addHook("onRequest", async (request, reply) => {
    if (request.method === "GET" || request.method === "HEAD") return;
    // Config is the only thing an operator may change from here, and only
    // through the two routes the registry validates.
    if (request.method === "POST" && writable.has(request.url.split("?")[0] ?? "")) return;
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
  if (!screensOwnPages) app.get("/costs", renderCosts);

  // The overview is the first screen: what needs a person, what is running, and
  // which requirements are over their own limit. The alert is stated in words
  // and never translated into a paused state.
  if (!screensOwnPages) {
    app.get("/", async (_request, reply) => {
      const snapshots = data.overLimitRequirements ? await data.overLimitRequirements() : [];
      return reply.type("text/html").send(renderOverviewCostAlertPage({ alert: toOverviewCostAlertsView(snapshots) }));
    });
  }

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

  // Registered before the built shell claims its routes: the screens this
  // process renders are the ones somebody is judged on, and a shell that
  // happens to be built must not answer in their place. The sample set is the
  // fallback for a process that holds the store but not yet the mobile ports,
  // and it leaves `/` and `/costs` to the routes above when they were built.
  await registerMobileConsoleRoutes(app, screens);
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
