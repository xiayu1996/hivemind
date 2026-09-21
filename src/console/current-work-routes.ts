import type { FastifyInstance } from "fastify";
import {
  RUNNING_OVERVIEW_API_PATH,
  type CurrentWorkReadPort,
} from "./current-work-contracts.js";

/**
 * The read-only routes a person's overview and detail screens call. Each answer
 * keeps the read's own distinctions: a thing that is not there is a 404 and a
 * store that did not answer is a 503, so a failed read is never shown as a
 * running entry or a zero-valued summary. Nothing here writes.
 */
export function registerCurrentWorkRoutes(
  app: FastifyInstance,
  port: CurrentWorkReadPort,
): void {
  app.get(RUNNING_OVERVIEW_API_PATH, async (_request, reply) => {
    const result = await port.readRunningOverview();
    if (result.kind === "ok") return reply.code(200).send(result.snapshot);
    return reply.code(503).send({ error: "current work is unavailable" });
  });
}
