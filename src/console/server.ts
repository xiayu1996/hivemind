import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { FastifyAdapter } from "@bull-board/fastify";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import type { Queue } from "bullmq";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface ConsoleDataSource {
  nodes(): Promise<unknown[]>;
  tasks(): Promise<unknown[]>;
  costs(): Promise<unknown[]>;
  config(): Promise<unknown[]>;
  stats(): Promise<unknown>;
}

export interface ConsoleServerOptions {
  uiRoot?: string;
  serveUi?: boolean;
  queues?: Queue[];
}

/** Builds the read-only intranet console and a read-only Bull Board mount. */
export async function createConsoleServer(
  data: ConsoleDataSource,
  options: ConsoleServerOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook("onRequest", async (request, reply) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      await reply.code(405).send({ error: "console is read-only" });
    }
  });

  app.get("/health", async () => ({ status: "ok" }));
  app.get("/api/nodes", async () => data.nodes());
  app.get("/api/tasks", async () => data.tasks());
  app.get("/api/costs", async () => data.costs());
  app.get("/api/config", async () => data.config());
  app.get("/api/stats", async () => data.stats());

  const board = new FastifyAdapter();
  board.setBasePath("/queues");
  createBullBoard({
    queues: (options.queues ?? []).map((queue) => new BullMQAdapter(queue, {
      readOnlyMode: true,
      allowRetries: false,
    })),
    serverAdapter: board,
  });
  await app.register(board.registerPlugin(), { prefix: "/queues" });

  if (options.serveUi !== false) {
    const uiRoot = resolve(options.uiRoot ?? "console-ui/dist");
    await app.register(fastifyStatic, {
      root: join(uiRoot, "assets"),
      prefix: "/assets/",
    });
    const index = await readFile(join(uiRoot, "index.html"), "utf8");
    app.get("/", async (_request, reply) => reply.type("text/html").send(index));
    for (const route of ["/nodes", "/tasks", "/costs", "/config", "/stats"]) {
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
