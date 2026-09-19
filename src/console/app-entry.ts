import { hostname } from "node:os";
import type { Client } from "@libsql/client";
import type { FastifyInstance } from "fastify";
import type { NotionOutboxDelivery } from "../notion/outbox.js";
import { pinnedPiVersion } from "../runner/pi-binary.js";
import { LibsqlConsoleDataSource } from "./libsql-data-source.js";
import { createTodoConsoleRuntime } from "./todo-runtime.js";

export interface VerificationConsoleOptions {
  /** The ledger the console reads waiting work from and keeps decisions in. */
  client: Client;
  /** Where an accepted decision is sent so it reaches its Notion entry. */
  delivery: NotionOutboxDelivery;
  /** The built shell, when the worktree has one. */
  uiRoot: string;
  serveUi: boolean;
  now?: () => number;
}

/**
 * The console a running application serves for a verification round.
 *
 * The screens a round opens include the one a person answers a waiting decision
 * on, so the surface behind those screens has to be mounted here and not only
 * in the daemon. An application that serves the page but not its API shows
 * every waiting todo as unreadable -- the page reads, the route is missing --
 * which is what a verification round of the todo screens would otherwise judge.
 * `createTodoConsoleRuntime` is the one assembly of that surface; this routes
 * the application's entry point through it so the two cannot drift.
 */
export async function createVerificationConsole(
  options: VerificationConsoleOptions,
): Promise<FastifyInstance> {
  const data = new LibsqlConsoleDataSource(options.client, async () => [{
    hostId: hostname(),
    status: "healthy",
    node: process.version,
    pi: pinnedPiVersion(),
  }]);
  return createTodoConsoleRuntime(data, {
    client: options.client,
    delivery: options.delivery,
    ...(options.now === undefined ? {} : { now: options.now }),
    server: { uiRoot: options.uiRoot, serveUi: options.serveUi },
  });
}
