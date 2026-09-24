import { tmpdir } from "node:os";
import type { ResolvedModel } from "./model-resolver.js";
import { RpcPiRunner } from "./rpc-runner.js";

export interface RoundTripOptions {
  binary: string;
  provider: string;
  model: ResolvedModel;
  timeoutMs?: number;
  /** The provider's key, for an api_key provider; see `providerKeyEnv`. */
  env?: Record<string, string>;
}

/**
 * Spends one very small turn to prove the credential actually works.
 *
 * `pi auth check` reports `ready` as soon as a key is *present*: an expired,
 * revoked or mistyped key passes it. Without this, a host is admitted to the
 * board and the credential is only discovered dead on the first real card,
 * which by then has already been moved and assigned. The prompt is a few
 * tokens on the cheap tier, so the cost of running it on every preflight is
 * far below the cost of one stalled card.
 */
export async function probeCredentialRoundTrip(options: RoundTripOptions): Promise<void> {
  const runner = new RpcPiRunner({
    binary: options.binary,
    provider: options.provider,
    model: options.model,
    cwd: tmpdir(),
    tools: [],
    ...(options.env ? { env: options.env } : {}),
    contextFiles: "explicit",
    systemPrompt: { mode: "append", text: "Answer with a single word." },
  });
  await runner.start();
  try {
    await runner.setAutoRetry(false);
    const result = await runner.prompt("Reply with the word ready.", options.timeoutMs ?? 60_000);
    if (result.failure) throw new Error(result.failure.errorMessage);
    if (!result.settled) throw new Error("the provider never settled the turn");
  } finally {
    await runner.stop();
  }
}
