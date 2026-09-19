import { AppUnderReview } from "./app-under-review.js";
import type { ConfigKey, ConfigValue } from "../config/registry.js";

/**
 * The application a verification lane opens pages on.
 *
 * Before this, every lane that could drive a browser was told to start a
 * service itself and to pick a port nobody was listening on. How a repository
 * starts is a fact about the repository, not something a session invents: one
 * session served the static prototype and passed a scenario, the next went
 * looking for a dev server that does not exist, found a refused connection and
 * called the same scenario inconclusive. A criterion whose answer depends on
 * what the session guessed never converges, and the Epic behind it never opens
 * its review request.
 *
 * So the box starts the application from the repository's own configuration
 * and hands the lane the URL. When it cannot, the lane is told that in words,
 * which is an answer too -- and the same one every time.
 */
export interface AppLaneConfig {
  /** Where the application starts; the tree under verification. */
  cwd: string;
  /** From verify.appStartCommand; empty means this repository has none. */
  command: readonly string[];
  /** From verify.appReadyUrl. */
  readyUrl: string;
  /** From verify.appReadyTimeoutMs. */
  timeoutMs: number;
  env?: Readonly<Record<string, string | undefined>>;
  log?: (line: string) => void;
}

/** What the lane tells the verifier about the application, and how to stop it. */
export interface AppLane {
  /** Running application, or why no page of it can be opened this round. */
  app: { url: string } | { unavailable: string };
  /** The lane's hosts plus the application's own, so the browser may reach it. */
  allowedHosts: string[];
  stop(): Promise<void>;
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    // Not a URL the browser could open either; the allowlist stays as it was
    // and the ready poll reports the bad URL by name.
    return undefined;
  }
}

const NOT_CONFIGURED =
  "This repository declares no way to start its application (verify.appStartCommand is empty), "
  + "so nothing is running for this round";

/**
 * Starts the application, when the repository says how.
 *
 * Never throws and never leaves a process behind on the failure path: an
 * application that will not come up is the box's problem and is reported as
 * such, not turned into the Story's failure.
 */
export async function startAppLane(
  config: AppLaneConfig | undefined,
  allowedHosts: readonly string[],
): Promise<AppLane> {
  const hosts = [...allowedHosts];
  if (!config || config.command.length === 0) {
    return { app: { unavailable: NOT_CONFIGURED }, allowedHosts: hosts, stop: async () => undefined };
  }
  const application = new AppUnderReview();
  const started = await application.start({
    cwd: config.cwd,
    command: config.command,
    readyUrl: config.readyUrl,
    timeoutMs: config.timeoutMs,
    ...(config.env === undefined ? {} : { env: config.env }),
    ...(config.log === undefined ? {} : { log: config.log }),
  });
  if (!started.started) {
    await application.stop();
    return {
      app: { unavailable: `The application could not be started for this round: ${started.reason}` },
      allowedHosts: hosts,
      stop: async () => undefined,
    };
  }
  // A start command with no ready URL leaves us with a process and no address
  // to hand over. The process is real and has to be stopped, but the verifier
  // is told what it can act on, which is that it has no address.
  if (started.url === "") {
    return {
      app: { unavailable: "The application was started but verify.appReadyUrl is empty, so this round has no address for it" },
      allowedHosts: hosts,
      stop: () => application.stop(),
    };
  }
  const host = hostOf(started.url);
  return {
    app: { url: started.url },
    allowedHosts: host !== undefined && !hosts.includes(host) ? [...hosts, host] : hosts,
    stop: () => application.stop(),
  };
}

/** The three settings the lane reads, so both lanes read the same ones. */
export interface AppLaneSettings {
  get<K extends ConfigKey>(key: K): ConfigValue<K>;
}

/** The lane's configuration for a repository, minus the tree it starts in. */
export function appLaneConfig(settings: AppLaneSettings): Omit<AppLaneConfig, "cwd"> {
  return {
    command: settings.get("verify.appStartCommand"),
    readyUrl: settings.get("verify.appReadyUrl"),
    timeoutMs: settings.get("verify.appReadyTimeoutMs"),
  };
}
