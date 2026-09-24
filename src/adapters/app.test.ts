import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunningApp, StartAppInput, StartAppResult } from "../ports.ts";
import { startApp } from "./app.ts";

const node = process.execPath;

/** macOS adds this to every process that loads CoreFoundation, whatever it was handed. */
const PLATFORM_INJECTED = new Set(["__CF_USER_TEXT_ENCODING"]);

/**
 * A product in miniature: listens on the port it is given (argv first, PORT
 * otherwise) after an optional delay, and can start a child of its own the way
 * a dev server starts its workers.
 */
const SERVER = `
const http = require("node:http");
const { spawn } = require("node:child_process");
const port = Number(process.argv[2] ?? process.env.PORT);
console.log("pid " + process.pid);
if (process.env.APP_CHILD === "1") {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  console.log("child " + child.pid);
}
if (process.env.APP_NOISE === "1") console.log("early noise " + "x".repeat(100000));
console.log("listening soon on " + port);
setTimeout(() => {
  http.createServer((request, response) => {
    if (request.url === "/moved") {
      response.writeHead(302, { location: "/login" });
      response.end();
    } else if (request.url === "/missing") {
      response.writeHead(404);
      response.end();
    } else if (request.url === "/env") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(process.env));
    } else {
      response.end("ok");
    }
  }).listen(port, "127.0.0.1");
}, Number(process.env.APP_DELAY_MS ?? 0));
`;

let dir: string;
let server: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "hivemind-app-"));
  server = join(dir, "server.cjs");
  await writeFile(server, SERVER);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // ESRCH: the process is gone, which is what the caller is waiting for.
    return false;
  }
}

async function gone(pid: number, withinMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await sleep(25);
  }
  return !alive(pid);
}

const pidIn = (output: string, label: string): number => Number(new RegExp(`^${label} (\\d+)$`, "m").exec(output)?.[1]);

const start = (overrides: Partial<StartAppInput> = {}): Promise<StartAppResult> => startApp({
  cwd: dir, start: [node, server, "{port}"], readyPath: "/", env: {}, timeoutMs: 10_000, ...overrides,
});

function running(result: StartAppResult): RunningApp {
  if (!result.ok) throw new Error(`the application did not start: ${result.reason}\n${result.output}`);
  return result.app;
}

describe("startApp", () => {
  it("serves on the port it was given and sees only the environment it was handed", async () => {
    process.env.HIVEMIND_TEST_SECRET = "must-not-travel";
    const app = running(await start({ env: { APP_URL: "http://127.0.0.1:{port}/" } }).finally(() => {
      delete process.env.HIVEMIND_TEST_SECRET;
    }));
    try {
      expect(app.origin).toBe(`http://127.0.0.1:${app.port}`);
      expect(await (await fetch(`${app.origin}/`)).text()).toBe("ok");
      const seen = await (await fetch(`${app.origin}/env`)).json() as Record<string, string>;
      expect(Object.keys(seen).filter((name) => !PLATFORM_INJECTED.has(name)).toSorted()).toEqual(["APP_URL", "PORT"]);
      expect(seen).toMatchObject({ PORT: String(app.port), APP_URL: `http://127.0.0.1:${app.port}/` });
      expect(app.output()).toContain(`listening soon on ${app.port}`);
    } finally {
      await app.stop();
    }
  });

  it("waits for a slow start and counts a redirect as ready", async () => {
    const app = running(await start({ start: [node, server], readyPath: "/moved", env: { APP_DELAY_MS: "600" } }));
    try {
      expect(app.output()).toContain(`listening soon on ${app.port}`);
    } finally {
      await app.stop();
    }
  });

  it("stops the whole process group, and stopping twice is harmless", async () => {
    const app = running(await start({ env: { APP_CHILD: "1" } }));
    const leader = pidIn(app.output(), "pid");
    const worker = pidIn(app.output(), "child");
    expect(alive(leader) && alive(worker)).toBe(true);

    await Promise.all([app.stop(), app.stop()]);
    await app.stop();

    expect(await gone(leader)).toBe(true);
    expect(await gone(worker)).toBe(true);
    await expect(fetch(`${app.origin}/`, { signal: AbortSignal.timeout(500) })).rejects.toThrow();
  });

  it("gives two applications started at once a port each", async () => {
    const [first, second] = (await Promise.all([start(), start()])).map(running);
    try {
      expect(first!.port).not.toBe(second!.port);
      expect(await (await fetch(`${first!.origin}/`)).text()).toBe("ok");
      expect(await (await fetch(`${second!.origin}/`)).text()).toBe("ok");
    } finally {
      await Promise.all([first!.stop(), second!.stop()]);
    }
  });

  it("reports an application that never answers, with its output, and leaves nothing running", async () => {
    const result = await start({ env: { APP_DELAY_MS: "60000", APP_CHILD: "1" }, timeoutMs: 1_000 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/did not answer at http:\/\/127\.0\.0\.1:\d+\/ within 1000ms/);
    expect(result.output).toContain("listening soon on");
    expect(await gone(pidIn(result.output, "pid"))).toBe(true);
    expect(await gone(pidIn(result.output, "child"))).toBe(true);
  });

  it("does not count an answer of 404 as ready", async () => {
    const result = await start({ readyPath: "/missing", timeoutMs: 1_000 });
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("did not answer") });
  });

  it("reports the application's own exit and output when it dies before it is ready", async () => {
    const result = await start({ start: [node, "-e", "console.error('port in use'); process.exit(3)"] });
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("exited with code 3 before answering") });
    expect(result.ok ? "" : result.output).toContain("port in use");
  });

  it("reports a command that cannot be started, and a working directory that is gone", async () => {
    const missingBinary = await start({ start: [join(dir, "no-such-app")] });
    expect(missingBinary).toMatchObject({ ok: false, reason: expect.stringContaining("could not start") });

    const missingDirectory = await start({ cwd: join(dir, "deleted-worktree") });
    expect(missingDirectory).toMatchObject({ ok: false, reason: expect.stringContaining("does not exist") });
  });

  it("refuses an empty start command and a ready path that is not a path", async () => {
    expect(await start({ start: [] })).toMatchObject({ ok: false, reason: "no start command was given" });
    expect(await start({ readyPath: "health" })).toMatchObject({ ok: false, reason: expect.stringContaining("must start with") });
  });

  it("keeps only the tail of a noisy application's output", async () => {
    const app = running(await start({ env: { APP_NOISE: "1" } }));
    try {
      expect(app.output().length).toBeLessThanOrEqual(16 * 1024);
      expect(app.output()).toContain(`listening soon on ${app.port}`);
      expect(app.output()).not.toContain("early noise");
    } finally {
      await app.stop();
    }
  });
});
