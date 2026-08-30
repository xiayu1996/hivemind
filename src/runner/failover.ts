import type { ConfigStore } from "../config/store.js";
import { usableProviders, type BreakerPolicy, type ProviderHealth } from "./circuit-breaker.js";
import type { ResolvedModel } from "./model-resolver.js";
import type { ModelPurpose } from "./model-policy.js";
import { parseUsageLimit, usageLimitAction } from "./usage-limit.js";

export interface ProviderHealthPort {
  snapshot(): Promise<ReadonlyMap<string, ProviderHealth>>;
  recordFailure(provider: string, errorMessage: string, policy: BreakerPolicy): Promise<ProviderHealth>;
  recordSuccess(provider: string): Promise<ProviderHealth>;
}

export interface FailoverDeps {
  /** The failover chain narrowed to providers that serve the purpose's tier. */
  providers: (purpose: ModelPurpose) => Promise<string[]>;
  modelFor: (provider: string, purpose: ModelPurpose) => Promise<ResolvedModel>;
  health: ProviderHealthPort;
  policy: BreakerPolicy;
  now: () => number;
}

/** The window is short enough to wait out; the card should be re-dispatched
 * after `resumeAt` rather than re-run on another provider. */
export class ProviderDeferredError extends Error {
  constructor(readonly provider: string, readonly resumeAt: number, message: string) {
    super(message);
    this.name = "ProviderDeferredError";
  }
}

/** Nothing in the chain can serve this purpose right now. The caller stops
 * taking work; it must never fall back to retrying blindly. */
export class AllProvidersUnavailableError extends Error {
  constructor(readonly purpose: ModelPurpose, readonly attempted: readonly string[]) {
    super(attempted.length === 0
      ? `no provider in the failover chain serves ${purpose}`
      : `every provider failed for ${purpose}: ${attempted.join(", ")}`);
    this.name = "AllProvidersUnavailableError";
  }
}

/**
 * Runs one whole unit of work on one provider, and on failure re-runs the whole
 * unit on the next provider in the chain. The unit is the caller's phase, so
 * there is no way to swap models inside one: a lateral move always restarts it.
 */
export async function runWithFailover<T>(
  purpose: ModelPurpose,
  attempt: (model: ResolvedModel) => Promise<T>,
  deps: FailoverDeps,
): Promise<T> {
  const chain = await deps.providers(purpose);
  const candidates = usableProviders(chain, await deps.health.snapshot(), deps.now());
  const attempted: string[] = [];

  for (const provider of candidates) {
    const model = await deps.modelFor(provider, purpose);
    attempted.push(provider);
    try {
      const result = await attempt(model);
      await deps.health.recordSuccess(provider);
      return result;
    } catch (cause) {
      const errorMessage = cause instanceof Error ? cause.message : String(cause);
      const health = await deps.health.recordFailure(provider, errorMessage, deps.policy);
      // The window belongs to the event, so it is read from the message at the
      // moment the failure happened, never from the clock at the moment we
      // decide what to do about it.
      const limit = parseUsageLimit(errorMessage, health.updatedAt);
      if (limit && usageLimitAction(limit, deps.policy.deferWithinMinutes) === "defer" && limit.resetAt !== null) {
        throw new ProviderDeferredError(provider, limit.resetAt, errorMessage);
      }
    }
  }
  throw new AllProvidersUnavailableError(purpose, attempted);
}

/**
 * Startup gate. pi retrying a provider on its own would re-run part of a phase
 * on a model this layer did not choose, which is exactly the mid-phase model
 * mixing the pipeline forbids, and it would do so without a trace here.
 */
export async function assertProviderRetriesDisabled(config: ConfigStore): Promise<void> {
  await config.reload();
  const retries = config.get("retry.providerAutoRetries");
  if (retries !== 0) {
    throw new Error(`retry.providerAutoRetries must be 0 so failover stays with the orchestrator, got ${retries}`);
  }
}
