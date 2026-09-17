import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getTaskExecutionDetail,
  taskExecutionDetailRoute,
  type TaskExecutionDetailDataSource,
} from "./task-execution-detail.js";

export interface ConsoleDataSource extends TaskExecutionDetailDataSource {
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
}

const requireFromConsole = createRequire(import.meta.url);

/**
 * Where the browser interface is served from.
 *
 * A built bundle wins when one exists, but the pages are plain ES modules and
 * are served from the worktree when it does not: the console is mounted by
 * whatever process holds the central store, and a page that only exists after
 * somebody ran a build is a page that is missing on the machine that needs it.
 */
export function resolveConsoleUiRoot(requested: string): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [...new Set([
    resolve(requested),
    resolve("console-ui/dist"),
    resolve("console-ui"),
    resolve(join(moduleDir, "..", "..", "console-ui")),
  ])];
  const found = candidates.find((candidate) => existsSync(join(candidate, "index.html")));
  if (found === undefined) {
    throw new Error(`console UI entry missing: no index.html under ${candidates.join(", ")}`);
  }
  return found;
}

/**
 * Vue's browser build, read from this installation's own dependencies. The
 * console is an intranet page that has to render on a host with no route out,
 * so nothing it needs may come from a CDN.
 */
function vueBrowserBundlePath(): string {
  return requireFromConsole.resolve("vue/dist/vue.esm-browser.prod.js");
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
  app.get("/api/config", async () => data.config());
  app.get("/api/stats", async () => data.stats());
  app.get("/api/providers", async () => data.providers());
  app.get("/api/queue", async () => data.queue());
  app.get(taskExecutionDetailRoute, async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const result = await getTaskExecutionDetail(data, { taskId });
    if (result.status === 404) return reply.code(404).send(result.body);
    return result.body;
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
    const uiRoot = resolveConsoleUiRoot(options.uiRoot ?? "console-ui/dist");
    await app.register(fastifyStatic, {
      root: uiRoot,
      prefix: "/ui/",
    });
    const vueBundle = await readFile(vueBrowserBundlePath(), "utf8");
    app.get("/vendor/vue.js", async (_request, reply) => reply.type("text/javascript").send(vueBundle));
    // Every page is the same shell: the browser routes from the path it was
    // opened with, so a deep link and a click land on the same view.
    const index = await readFile(join(uiRoot, "index.html"), "utf8");
    app.get("/", async (_request, reply) => reply.type("text/html").send(index));
    for (const route of ["/nodes", "/tasks", "/tasks/:taskId", "/costs", "/config", "/stats", "/providers", "/queue"]) {
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
