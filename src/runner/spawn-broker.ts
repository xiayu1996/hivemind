import type { Client } from "@libsql/client";
import type { ConfigStore } from "../config/store.js";
import type { ModelPurpose } from "../pipeline/phase.js";
import { ProviderSlotStore, defaultCapacity } from "../queue/provider-slots.js";
import { resolveAgentSpec, type AgentModelPolicy, type ResolvedAgentSpec } from "./agent-spec.js";

/**
 * One spawn's permission to run: what it runs on, and the capacity it holds
 * while it does.
 *
 * The two are handed out together because they have to be taken together. The
 * provider is resolved per phase and can change through failover, so a slot
 * taken once for the whole card would be a slot on the wrong provider for
 * every phase after the first.
 */
export interface AgentSpawnGrant {
  spec: ResolvedAgentSpec;
  /** Gives the provider capacity back. Always called, including on failure. */
  release: () => Promise<void>;
}

export interface SpawnBrokerOptions {
  config: ConfigStore;
  policy: AgentModelPolicy;
  slots: ProviderSlotStore;
  cardId: string;
  /** This execution's identity, so a killed worker's slots are identifiable. */
  holder: string;
  /** Providers to skip, from the circuit breaker. */
  unhealthy?: () => Promise<ReadonlySet<string>>;
  /** Whether this host holds usable credentials for a provider. Asked once per
   * provider per execution: a stored token that no longer refreshes is a reason
   * to fail over, not a reason to fail the card. */
  ready?: (provider: string) => Promise<{ ready: boolean; reason?: string | null }>;
  /** How long to wait between attempts when every bucket is full. */
  waitMs?: number;
  /** Bounded so a misconfiguration cannot hang a card forever. */
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const DEFAULT_WAIT_MS = 5_000;
const DEFAULT_MAX_WAIT_MS = 30 * 60_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

export class NoProviderAvailableError extends Error {
  constructor(purpose: ModelPurpose, detail: string) {
    super(`no provider could be acquired for ${purpose}: ${detail}`);
    this.name = "NoProviderAvailableError";
  }
}

/**
 * Chooses a provider for a purpose and takes its capacity before the spawn.
 *
 * Waiting for capacity is not a failure: it consumes no round, produces no stop
 * point and leaves the card's lease in place. That distinction matters because
 * the alternative -- treating a full bucket as a failed attempt -- would burn a
 * card's retry budget on other cards being busy.
 */
export class SpawnBroker {
  private readonly waitMs: number;
  private readonly maxWaitMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly readinessCache = new Map<string, { ready: boolean; reason?: string | null }>();

  constructor(private readonly options: SpawnBrokerOptions) {
    this.waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
    this.maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    this.sleep = options.sleep ?? delay;
    this.now = options.now ?? Date.now;
  }

  async grant(purpose: ModelPurpose): Promise<AgentSpawnGrant> {
    const { config, policy, slots } = this.options;
    await config.reload();
    const configured = config.get("schedule.maxConcurrentPerProvider") as Record<string, number>;
    const chain = await policy.providersFor(purpose);
    const unhealthy = (await this.options.unhealthy?.()) ?? new Set<string>();
    const healthy = chain.filter((provider) => !unhealthy.has(provider));
    const candidates: string[] = [];
    const refused: string[] = [];
    for (const provider of healthy) {
      const verdict = await this.readiness(provider);
      if (verdict.ready) candidates.push(provider);
      else refused.push(`${provider} (${verdict.reason ?? "unknown reason"})`);
    }
    if (candidates.length === 0) {
      throw new NoProviderAvailableError(purpose, chain.length === 0
        ? "the failover chain serves no provider for this tier"
        : refused.length > 0
          ? `no provider is both healthy and credentialed: ${refused.join("; ")}`
          : "every provider in the chain is circuit-broken");
    }

    const deadline = this.now() + this.maxWaitMs;
    for (;;) {
      for (const provider of candidates) {
        const capacity = configured[provider] ?? defaultCapacity(await this.authTypeOf(provider));
        const slot = await slots.acquire({
          provider,
          cardId: this.options.cardId,
          holder: this.options.holder,
          purpose,
          capacity,
        });
        if (!slot) continue;
        try {
          const spec = await resolveAgentSpec({ config, policy }, purpose, provider);
          return { spec, release: () => slots.release(slot.slotId) };
        } catch (cause) {
          // A provider that cannot resolve must not keep the slot it just took.
          await slots.release(slot.slotId);
          if (provider === candidates.at(-1)) throw cause;
        }
      }
      if (this.now() >= deadline) {
        throw new NoProviderAvailableError(purpose, `every bucket stayed full for ${this.maxWaitMs}ms`);
      }
      await this.sleep(this.waitMs);
    }
  }

  private async readiness(provider: string): Promise<{ ready: boolean; reason?: string | null }> {
    const probe = this.options.ready;
    if (!probe) return { ready: true };
    const cached = this.readinessCache.get(provider);
    if (cached) return cached;
    const verdict = await probe(provider);
    this.readinessCache.set(provider, verdict);
    return verdict;
  }

  private async authTypeOf(provider: string): Promise<"api_key" | "oauth"> {
    const profiles = this.options.config.get("model.providers") as Record<string, { authType: "api_key" | "oauth" }>;
    return profiles[provider]?.authType ?? "oauth";
  }
}

/** Convenience for callers that hold a client rather than a slot store. */
export function providerSlots(client: Client, leaseMs: number): ProviderSlotStore {
  return new ProviderSlotStore(client, { leaseMs });
}
