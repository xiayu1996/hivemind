import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ConsoleAgentRulesService, SaveAgentRulesRequest } from "./agent-rules.js";
import { createDefaultAgentRulesService } from "./agent-rules-source.js";

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
  /** The complete-rule surface. Without it the console still hosts the page
   * over the code defaults, because that is the policy the pipeline runs on
   * until somebody saves a different one. */
  agentRules?: ConsoleAgentRulesService;
}

/** Builds the read-only intranet console. */
export async function createConsoleServer(
  data: ConsoleDataSource,
  options: ConsoleServerOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const writable = new Set<string>(options.configWriter
    ? ["POST /api/config/value", "POST /api/config/rollback"]
    : []);
  // The complete rule is saved as one aggregate, so it is not one of the
  // generic per-key config routes and does not need a configWriter.
  for (const method of ["PUT", "POST"]) writable.add(`${method} /api/agent-rules`);
  app.addHook("onRequest", async (request, reply) => {
    if (request.method === "GET" || request.method === "HEAD") return;
    // Config is the only thing an operator may change from here, and only
    // through the routes that validate it.
    if (writable.has(`${request.method} ${request.url.split("?")[0] ?? ""}`)) return;
    await reply.code(405).send({ error: "console is read-only" });
  });

  app.get("/health", async () => ({ status: "ok" }));
  app.get("/api/nodes", async () => data.nodes());
  app.get("/api/tasks", async () => data.tasks());
  app.get("/api/costs", async () => data.costs());
  app.get("/api/config", async () => data.config());
  app.get("/api/stats", async () => data.stats());
  app.get("/api/providers", async () => data.providers());
  app.get("/api/queue", async () => data.queue());

  const agentRules = options.agentRules ?? createDefaultAgentRulesService();
  app.get("/api/agent-rules", async () => agentRules.view());
  const saveAgentRules = async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as Partial<SaveAgentRulesRequest> | undefined;
    if (!body || typeof body.revision !== "number" || typeof body.updatedBy !== "string") {
      return reply.code(400).send({ error: "revision and updatedBy are required" });
    }
    const result = await agentRules.save({
      revision: body.revision,
      defaultProvider: body.defaultProvider ?? "",
      defaultModel: body.defaultModel ?? "",
      providerStates: body.providerStates ?? {},
      failoverOrder: body.failoverOrder ?? [],
      updatedBy: body.updatedBy,
    });
    // A rejected rule is a 422 and a stale one a 409, but both carry the
    // effective rule so the page can redraw what is actually in force.
    if (result.status === "saved") return result;
    return reply.code(result.status === "rejected" ? 422 : 409).send(result);
  };
  app.put("/api/agent-rules", saveAgentRules);
  app.post("/api/agent-rules", saveAgentRules);

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
    for (const route of ["/nodes", "/tasks", "/costs", "/config", "/stats", "/providers", "/queue", "/agent-rules"]) {
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
