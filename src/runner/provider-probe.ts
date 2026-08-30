import { probeDue, type BreakerPolicy } from "./circuit-breaker.js";
import type { ProviderReadiness } from "./auth-probe.js";
import type { LibsqlProviderHealthStore } from "./provider-health-store.js";

export type CredentialProbe = (provider: string) => Promise<ProviderReadiness>;

/**
 * The credential layer of the two-layer probe. A breaker that opened on
 * authentication or a spent balance names no window of its own, so without this
 * it would stay open until someone edited the database by hand: the probe is
 * how the system notices a human fixed the account. It is read-only by
 * contract (`--no-refresh`), so running it on a schedule costs nothing.
 */
export async function probeOpenProviders(
  chain: readonly string[],
  store: LibsqlProviderHealthStore,
  probe: CredentialProbe,
  policy: BreakerPolicy,
  now: () => number = Date.now,
): Promise<void> {
  const snapshot = await store.snapshot();
  for (const provider of chain) {
    const health = snapshot.get(provider);
    if (!health || !probeDue(health, now())) continue;
    try {
      const readiness = await probe(provider);
      await store.recordProbe(provider, readiness.ready, readiness.reason ?? "credentials are not ready", policy);
    } catch (cause) {
      // An unreachable probe says nothing about the provider; the breaker keeps
      // its state and the attempt is still stamped so the operator sees it ran.
      await store.recordProbe(provider, false, (cause as Error).message);
    }
  }
}
