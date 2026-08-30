import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { CANONICAL_CAPTURE_ENV } from "../src/observability/capture-contract.js";

interface ProviderRequestEvent {
  payload: unknown;
}

interface PiExtensionApi {
  on(event: "before_provider_request", handler: (event: ProviderRequestEvent) => void): void;
}

export default function canonicalCapture(pi: PiExtensionApi): void {
  const target = process.env[CANONICAL_CAPTURE_ENV];
  if (!target) throw new Error(`${CANONICAL_CAPTURE_ENV} is not set`);
  mkdirSync(dirname(target), { recursive: true });
  pi.on("before_provider_request", (event) => {
    appendFileSync(target, `${JSON.stringify(event.payload)}\n`, "utf8");
  });
}
