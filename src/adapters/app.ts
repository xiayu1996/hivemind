import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import type { StartApp, StartAppResult } from "../ports.ts";
import { describeSpawnError, signalGroup, STOP_GRACE_MS } from "./process.ts";

/** Enough of the application's own output to say why it would not come up. */
const OUTPUT_LIMIT = 16 * 1024;
const POLL_INTERVAL_MS = 200;
const PROBE_TIMEOUT_MS = 2_000;
const PORT_PLACEHOLDER = "{port}";

/**
 * A port this host has just confirmed free, for the placeholder and PORT.
 *
 * An application started on a fixed port gets it only if it is the first one
 * on the host; every later one polls that port, is answered by somebody else's
 * application and is judged on it. That once had a round verifying the screens
 * of a different worktree and spending its budget calling its own screens
 * unconfirmable. The probe socket is closed before the application starts, so
 * another process could still take the port in between, and a poll that is
 * answered is not proof of ownership either: this narrows the failure rather
 * than eliminating it.
 */
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

/** Anything below 400 counts: a redirect to a login page still proves the application is serving. */
async function answers(url: string, timeoutMs: number): Promise<boolean> {
  try {
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    await response.body?.cancel();
    return response.status < 400;
  } catch {
    // Refused, reset or timed out: nothing answers on the port yet. The URL
    // itself is always valid, built from a number and a path starting with "/".
    return false;
  }
}

const failed = (reason: string, output = ""): StartAppResult => ({ ok: false, reason, output });

/** Waits until no process is left in the group, or the time is up. */
async function groupEmptied(pid: number, withinMs: number): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  while (signalGroup(pid, 0)) {
    if (Date.now() >= deadline) return false;
    await sleep(50);
  }
  return true;
}

/**
 * Stops the whole group, not only the process that was started: a start
 * command is usually a shell or a package manager, and the server it runs is
 * that process's child.
 */
async function terminate(child: ChildProcess, exited: Promise<string>): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  signalGroup(pid, "SIGTERM");
  if (!(await groupEmptied(pid, STOP_GRACE_MS))) {
    signalGroup(pid, "SIGKILL");
    await groupEmptied(pid, STOP_GRACE_MS);
  }
  await Promise.race([exited, sleep(STOP_GRACE_MS)]);
}

/**
 * Starts the application under evaluation on a free port and waits until it
 * answers. Never throws and never leaves a process behind on a failure path:
 * an application that will not come up is reported with its own output, for
 * the caller to judge, rather than turned into an exception.
 */
export const startApp: StartApp = async (input) => {
  if (input.start.length === 0 || input.start[0] === "") return failed("no start command was given");
  if (!input.readyPath.startsWith("/")) {
    return failed(`the ready path must start with "/", got ${JSON.stringify(input.readyPath)}`);
  }
  let port: number;
  try {
    port = await reservePort();
  } catch (error) {
    return failed(`no port could be reserved for the application: ${error instanceof Error ? error.message : String(error)}`);
  }
  const substitute = (text: string) => text.replaceAll(PORT_PLACEHOLDER, String(port));
  const [command = "", ...args] = input.start.map(substitute);
  const env = {
    ...Object.fromEntries(Object.entries(input.env).map(([name, value]) => [name, substitute(value)])),
    PORT: String(port),
  };
  const origin = `http://127.0.0.1:${port}`;
  const readyUrl = `${origin}${input.readyPath}`;

  let child: ChildProcess;
  try {
    child = spawn(command, args, { cwd: input.cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    return failed(await describeSpawnError(error, command, input.cwd));
  }
  let output = "";
  const collect = (text: string) => {
    output = (output + text).slice(-OUTPUT_LIMIT);
  };
  for (const stream of [child.stdout, child.stderr]) {
    stream?.setEncoding("utf8");
    stream?.on("data", collect);
    // A read error ends the stream; the exit still reports what happened, and
    // an unhandled error event would take the whole service down.
    stream?.on("error", () => undefined);
  }
  const exited = new Promise<string>((resolve) => {
    child.on("error", (error) => {
      // Only a failed spawn leaves the child without a pid; any other error of
      // a running child is followed by its exit.
      if (child.pid === undefined) void describeSpawnError(error, command, input.cwd).then(resolve);
    });
    child.once("exit", (code, signal) => resolve(`the application exited with ${signal ?? `code ${code}`}`));
  });
  let stopping: Promise<void> | null = null;
  const stop = (): Promise<void> => (stopping ??= terminate(child, exited));

  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() < deadline) {
    if (await answers(readyUrl, Math.max(1, Math.min(PROBE_TIMEOUT_MS, deadline - Date.now())))) {
      return { ok: true, app: { origin, port, output: () => output, stop } };
    }
    const ended = await Promise.race([sleep(POLL_INTERVAL_MS).then(() => null), exited]);
    if (ended !== null) {
      // The process that exited may have left its own children in the group.
      await stop();
      return failed(child.pid === undefined ? ended : `${ended} before answering at ${readyUrl}`, output);
    }
  }
  await stop();
  return failed(
    `the application did not answer at ${readyUrl} within ${input.timeoutMs}ms; `
    + "it is expected to listen on 127.0.0.1 at the port it is given as {port} or PORT",
    output,
  );
};
