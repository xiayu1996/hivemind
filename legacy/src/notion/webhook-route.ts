import type { FastifyInstance } from "fastify";
import fastifyRawBody from "fastify-raw-body";
import { z } from "zod";
import {
  handleNotionWebhookRequest,
  type NotionSyncCoordinator,
} from "./sync.js";

export interface NotionWebhookRouteOptions {
  secret?: string;
  captureVerificationToken?: (token: string) => Promise<void>;
  coordinator: Pick<NotionSyncCoordinator, "handleWebhook">;
  path?: string;
}

/** Registers the only route that retains an exact request-body copy for HMAC verification. */
export async function registerNotionWebhookRoute(
  app: FastifyInstance,
  options: NotionWebhookRouteOptions,
): Promise<void> {
  if (options.secret === "") throw new Error("Notion webhook secret must not be empty");
  if (!options.secret && !options.captureVerificationToken) {
    throw new Error("Notion webhook route requires a secret or verification-token capture");
  }

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
      if (!Buffer.isBuffer(rawBody)) {
        return reply.code(400).send({ accepted: false, reason: "invalid_request" });
      }
      if (typeof signature !== "string") {
        const parsed = z.object({ verification_token: z.string().min(1) }).safeParse(request.body);
        if (!parsed.success || !options.captureVerificationToken) {
          return reply.code(400).send({ accepted: false, reason: "invalid_request" });
        }
        await options.captureVerificationToken(parsed.data.verification_token);
        return reply.code(200).send({ accepted: true, verificationTokenCaptured: true });
      }
      if (!options.secret) {
        return reply.code(503).send({ accepted: false, reason: "verification_restart_required" });
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
