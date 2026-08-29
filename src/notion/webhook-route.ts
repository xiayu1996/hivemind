import type { FastifyInstance } from "fastify";
import fastifyRawBody from "fastify-raw-body";
import {
  handleNotionWebhookRequest,
  type NotionSyncCoordinator,
} from "./sync.js";

export interface NotionWebhookRouteOptions {
  secret: string;
  coordinator: Pick<NotionSyncCoordinator, "handleWebhook">;
  path?: string;
}

/** Registers the only route that retains an exact request-body copy for HMAC verification. */
export async function registerNotionWebhookRoute(
  app: FastifyInstance,
  options: NotionWebhookRouteOptions,
): Promise<void> {
  if (options.secret.length === 0) throw new Error("Notion webhook secret must not be empty");

  await app.register(fastifyRawBody, {
    global: false,
    encoding: false,
    runFirst: true,
  });

  app.post(options.path ?? "/webhooks/notion", {
    config: { rawBody: true },
    handler: async (request, reply) => {
      const signature = request.headers["x-notion-signature"];
      const rawBody = request.rawBody;
      if (typeof signature !== "string" || !Buffer.isBuffer(rawBody)) {
        return reply.code(400).send({ accepted: false, reason: "invalid_request" });
      }

      const result = await handleNotionWebhookRequest(
        rawBody,
        signature,
        options.secret,
        options.coordinator,
      );
      return reply.code(result.status).send(result);
    },
  });
}
