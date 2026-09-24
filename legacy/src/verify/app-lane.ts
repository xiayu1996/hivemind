import { createServer } from "node:net";
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

/**
 * The port a round's application listens on, when the repository asks for one.
 *
 * A repository that names a fixed port has every lane on this host starting its
 * application there, and only the first one gets it. The rest poll the ready
 * URL, are answered by somebody else's application, and judge that: a Story's
 * round verified the console of a different Epic's worktree, called its own
 * screens unconfirmable and spent its budget down to `retry_limit_exceeded`.
 *
 * So `{port}` in the start command or the ready URL is replaced by a port this
 * host has just confirmed free. The socket is closed before the application is
 * started, which is a window somebody else could still take -- the poll below
 * is not proof of ownership either, so the reason a lane may not be answered by
 * its own application is narrowed here rather than eliminated.
 */
const PORT_PLACEHOLDER = "{port}";

async function reservePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => (port === 0 ? reject(new Error("the host gave no port")) : resolve(port)));
    });
  });
}

/**
 * The substitution for one round's `{port}` placeholders, or null when nothing
 * in `texts` asks for a port.
 *
 * Every lane that starts an application goes through this. The UI review lane
 * started its own copy straight from the repository's configuration for a
 * while, so it launched the console with the literal `{port}`, the process
 * exited before answering, and the round judged screens of an application that
 * never came up -- the failure this placeholder exists to prevent, arriving
 * through the one lane that did not use it.
 */
export async function reserveAppPort(
  texts: readonly (string | undefined)[],
): Promise<((text: string) => string) | null> {
  if (!texts.some((text) => text?.includes(PORT_PLACEHOLDER))) return null;
  const port = await reservePort();
  return (text: string) => text.replaceAll(PORT_PLACEHOLDER, String(port));
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
  const declared = Object.entries(config.env ?? {});
  let command = config.command;
  let readyUrl = config.readyUrl;
  let env = config.env;
  let substitute: ((text: string) => string) | null;
  try {
    substitute = await reserveAppPort([...config.command, config.readyUrl, ...declared.map(([, value]) => value)]);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return {
      app: { unavailable: `No port could be reserved for the application this round: ${reason}` },
      allowedHosts: hosts,
      stop: async () => undefined,
    };
  }
  if (substitute !== null) {
    const replace = substitute;
    command = config.command.map(replace);
    readyUrl = replace(config.readyUrl);
    env = Object.fromEntries(declared.map(([name, value]) => [name, value === undefined ? value : replace(value)]));
  }
  const application = new AppUnderReview();
  const started = await application.start({
    cwd: config.cwd,
    command,
    readyUrl,
    timeoutMs: config.timeoutMs,
    ...(env === undefined ? {} : { env }),
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
  /** Which repository these settings are for; null when they are for none. */
  readonly repository: string | null;
}

/**
 * The lane's configuration for a repository, minus the tree it starts in.
 *
 * All three keys are per-repo, and a store with no repository answers them
 * with a value nobody configured rather than with the repository's: the rows
 * that would have overridden them are never even selected. Refusing here is
 * what keeps the two verification lanes agreeing about whether an application
 * is running -- a regression sweep read these unscoped and judged screens with
 * no application while the Story's own round had been handed one.
 */
export function appLaneConfig(settings: AppLaneSettings): Omit<AppLaneConfig, "cwd"> {
  if (settings.repository === null) {
    throw new Error("the application lane needs settings scoped to a repository");
  }
  return {
    command: settings.get("verify.appStartCommand"),
    readyUrl: settings.get("verify.appReadyUrl"),
    timeoutMs: settings.get("verify.appReadyTimeoutMs"),
  };
}
