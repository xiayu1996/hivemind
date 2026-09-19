import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { OVERVIEW_ENDPOINT, type OverviewReadPort } from "./overview-contract.js";
import type { ConsoleOverviewPage, OverviewPageState } from "./overview-page.js";

/** The console's own time zone when the reader's browser sends none. */
const DEFAULT_TIME_ZONE = "Asia/Shanghai";
const FORCED_PAGE_STATES = new Set<OverviewPageState>(["loading", "empty", "error", "waiting"]);

function forcedPageState(value: string | undefined): OverviewPageState | null {
  return value !== undefined && FORCED_PAGE_STATES.has(value as OverviewPageState)
    ? (value as OverviewPageState)
    : null;
}

function isTimeZone(value: string): boolean {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", { timeZone: value });
    return formatter.resolvedOptions().timeZone.length > 0;
  } catch {
    // Intl throws a RangeError for a name it does not know; that throw is the
    // rejection, and no other failure can reach here.
    return false;
  }
}

export interface ConsoleDataSource extends OverviewReadPort {
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
  /** The one write surface. Without it the console stays entirely read-only. */
  configWriter?: ConsoleConfigWritePort;
  /** The overview is the console's first screen. When present, `/` and
   * `/overview` render it from the central store and `/overview/sections`
   * returns the block the open page refreshes; without it the console falls
   * back to serving a static bundle from `uiRoot`. */
  overviewPage?: ConsoleOverviewPage;
}

/** Builds the read-only intranet console. */
export async function createConsoleServer(
  data: ConsoleDataSource,
  options: ConsoleServerOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const writable = new Set(options.configWriter
    ? ["/api/config/value", "/api/config/rollback"]
    : []);
  app.addHook("onRequest", async (request, reply) => {
    if (request.method === "GET" || request.method === "HEAD") return;
    // Config is the only thing an operator may change from here, and only
    // through the two routes the registry validates.
    if (request.method === "POST" && writable.has(request.url.split("?")[0] ?? "")) return;
    await reply.code(405).send({ error: "console is read-only" });
  });

  app.get("/health", async () => ({ status: "ok" }));
  app.get(OVERVIEW_ENDPOINT, async (request, reply) => {
    const timeZone = (request.query as { timeZone?: string }).timeZone;
    if (typeof timeZone !== "string" || !isTimeZone(timeZone)) {
      return reply.code(400).send({ error: "timeZone must be a valid IANA name" });
    }
    return data.readOverview({ nowMs: Date.now(), timeZone });
  });
  app.get("/api/nodes", async () => data.nodes());
  app.get("/api/tasks", async () => data.tasks());
  app.get("/api/costs", async () => data.costs());
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

  if (options.serveUi !== false) {
    const uiRoot = resolve(options.uiRoot ?? "console-ui/dist");
    const overviewPage = options.overviewPage;
    if (overviewPage) {
      const timeZoneOf = (request: { query: unknown }): string => {
        const value = (request.query as { timeZone?: string }).timeZone;
        return typeof value === "string" && isTimeZone(value) ? value : DEFAULT_TIME_ZONE;
      };
      const renderPage = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
        const timeZone = timeZoneOf(request);
        const forced = forcedPageState((request.query as { state?: string }).state);
        const nowMs = Date.now();
        let snapshot = null;
        let state: OverviewPageState = forced ?? "ready";
        if (forced === null) {
          try {
            snapshot = await data.readOverview({ nowMs, timeZone });
            state = snapshot.contentState.kind === "empty" ? "empty" : "ready";
          } catch {
            // A read the console could not make is the page's own error state:
            // the reader gets a page that says so instead of a blank 500.
            state = "error";
            snapshot = null;
          }
        }
        await reply.type("text/html; charset=utf-8").send(
          overviewPage.renderDocument({ state, snapshot, timeZone, nowMs }),
        );
      };
      app.get("/", renderPage);
      app.get("/overview", renderPage);
      app.get("/overview/sections", async (request, reply) => {
        const timeZone = timeZoneOf(request);
        const nowMs = Date.now();
        try {
          const snapshot = await data.readOverview({ nowMs, timeZone });
          const state: OverviewPageState = snapshot.contentState.kind === "empty" ? "empty" : "ready";
          return {
            body: overviewPage.renderBody({ state, snapshot, timeZone, nowMs }),
            refreshed: overviewPage.renderRefreshedAt(nowMs, timeZone),
            revision: snapshot.revision,
          };
        } catch {
          return reply.code(503).send({ error: "overview unavailable" });
        }
      });
    }
    const assets = join(uiRoot, "assets");
    if (existsSync(assets)) {
      await app.register(fastifyStatic, { root: assets, prefix: "/assets/" });
    }
    if (!overviewPage) {
      const index = await readFile(join(uiRoot, "index.html"), "utf8");
      app.get("/", async (_request, reply) => reply.type("text/html").send(index));
      for (const route of ["/overview", "/nodes", "/tasks", "/costs", "/config", "/stats", "/providers", "/queue"]) {
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
