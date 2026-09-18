import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  DailyCostReadResult,
  DailyCostSelection,
  DailyCostTimeZoneOption,
} from "./daily-costs.js";

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
  app.get("/api/nodes", async () => data.nodes());
  app.get("/api/tasks", async () => data.tasks());
  app.get("/api/costs", async () => data.costs());
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

  if (options.serveUi !== false) {
    const uiRoot = resolve(options.uiRoot ?? "console-ui/dist");
    await app.register(fastifyStatic, {
      root: join(uiRoot, "assets"),
      prefix: "/assets/",
    });
    const index = await readFile(join(uiRoot, "index.html"), "utf8");
    app.get("/", async (_request, reply) => reply.type("text/html").send(index));
    for (const route of ["/nodes", "/tasks", "/costs", "/config", "/stats", "/providers", "/queue"]) {
      app.get(route, async (_request, reply) => reply.type("text/html").send(index));
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
