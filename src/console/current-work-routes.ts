import type { FastifyInstance } from "fastify";
import type { CurrentWorkReadPort } from "./current-work-contracts.js";

/** SPECIFY scaffold. CODE registers the three read-only current-work routes. */
export function registerCurrentWorkRoutes(
  _app: FastifyInstance,
  _port: CurrentWorkReadPort,
): void {}
