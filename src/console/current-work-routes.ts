import type { FastifyInstance } from "fastify";
import {
  REQUIREMENT_DETAIL_API_PATH,
  RUNNING_OVERVIEW_API_PATH,
  TASK_DETAIL_API_PATH,
  asRequirementDetail,
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

  app.get(REQUIREMENT_DETAIL_API_PATH, async (request, reply) => {
    const requirementId = String(
      (request.params as { requirementId?: string }).requirementId ?? "",
    );
    const result = await port.readRequirementDetail(requirementId);
    switch (result.kind) {
      case "ok": {
        // The requirement screen is handed the requirement's own detail only:
        // a task read answered here is refused rather than rendered under the
        // requirement's title.
        const detail = asRequirementDetail(result.detail);
        if (!detail) return reply.code(502).send({ error: "requirement detail is not a requirement" });
        return reply.code(200).send(detail);
      }
      case "not_found":
        return reply.code(404).send({ error: "requirement not found" });
      case "failed":
        return reply.code(503).send({ error: "requirement detail is unavailable" });
    }
  });

  app.get(TASK_DETAIL_API_PATH, async (request, reply) => {
    const cardId = String((request.params as { cardId?: string }).cardId ?? "");
    const result = await port.readTaskDetail(cardId);
    switch (result.kind) {
      case "ok":
        return reply.code(200).send(result.detail);
      case "not_found":
        return reply.code(404).send({ error: "task not found" });
      case "failed":
        return reply.code(503).send({ error: "task detail is unavailable" });
    }
  });
}
