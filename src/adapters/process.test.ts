import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { baseEnvironment, runCommand, STOP_GRACE_MS } from "./process.ts";

const node = process.execPath;
const script = (source: string): string[] => [node, "-e", source];

/** macOS adds this to every process that loads CoreFoundation, whatever it was handed. */
const PLATFORM_INJECTED = new Set(["__CF_USER_TEXT_ENCODING"]);

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

/** A grandchild that shares the command's stdout, prints its pid and outlives its parent. */
const LEAVES_A_GRANDCHILD = [
  "const { spawn } = require('node:child_process');",
  "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });",
  "child.unref();",
  "process.stdout.write(String(child.pid) + '\\n');",
].join(" ");

describe("runCommand", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "hivemind-process-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reports the exit code and both streams", async () => {
    const result = await runCommand(
      script("process.stdout.write('out'); process.stderr.write('err'); process.exitCode = 3"),
      { cwd: dir, env: {} },
    );
    expect(result).toMatchObject({ code: 3, signal: null, stdout: "out", stderr: "err", spawnError: null, timedOut: false });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("gives the child exactly the environment it was handed and nothing of its own", async () => {
    process.env.HIVEMIND_TEST_SECRET = "must-not-travel";
    try {
      const result = await runCommand(
        script("process.stdout.write(JSON.stringify(process.env))"),
        { cwd: dir, env: { ONLY_THIS: "yes" } },
      );
      const seen = JSON.parse(result.stdout) as Record<string, string>;
      expect(Object.keys(seen).filter((name) => !PLATFORM_INJECTED.has(name))).toEqual(["ONLY_THIS"]);
      expect(seen.ONLY_THIS).toBe("yes");
    } finally {
      delete process.env.HIVEMIND_TEST_SECRET;
    }
  });

  it("delivers input on stdin", async () => {
    const result = await runCommand(
      script("let text = ''; process.stdin.on('data', (c) => { text += c; }); process.stdin.on('end', () => process.stdout.write(text.toUpperCase()))"),
      { cwd: dir, env: {}, input: "hello" },
    );
    expect(result.stdout).toBe("HELLO");
  });

  it("reports a missing executable as a result instead of throwing", async () => {
    const result = await runCommand(["hivemind-no-such-command"], { cwd: dir, env: { PATH: "/usr/bin:/bin" } });
    expect(result).toMatchObject({ code: null, signal: null, timedOut: false });
    expect(result.spawnError).toContain("hivemind-no-such-command could not start");
    expect(result.spawnError).toContain("ENOENT");
  });

  it("names a working directory that is gone rather than blaming the executable", async () => {
    const missing = join(dir, "deleted-worktree");
    const result = await runCommand([node, "-e", "0"], { cwd: missing, env: {} });
    expect(result.spawnError).toContain(`its working directory ${missing} does not exist`);
  });

  it("reports a file it may not execute as a spawn error", async () => {
    const path = join(dir, "not-executable.sh");
    await writeFile(path, "#!/bin/sh\necho hi\n", { mode: 0o644 });
    const result = await runCommand([path], { cwd: dir, env: {} });
    expect(result.code).toBeNull();
    expect(result.spawnError).toContain("EACCES");
  });

  it("reports an empty command without starting anything", async () => {
    const result = await runCommand([], { cwd: dir, env: {} });
    expect(result.spawnError).toBe("no command was given");
  });

  it("sends SIGTERM to the process group when the command runs out of time", async () => {
    const result = await runCommand(script("setInterval(() => {}, 1000)"), { cwd: dir, env: {}, timeoutMs: 200 });
    expect(result).toMatchObject({ code: null, signal: "SIGTERM", timedOut: true, spawnError: null });
    expect(result.durationMs).toBeLessThan(STOP_GRACE_MS);
  });

  it("follows with SIGKILL after the grace period, and reaches the command's own children", async () => {
    const result = await runCommand(
      script(`process.on('SIGTERM', () => {}); ${LEAVES_A_GRANDCHILD} setInterval(() => {}, 1000);`),
      { cwd: dir, env: {}, timeoutMs: 300 },
    );
    expect(result).toMatchObject({ code: null, signal: "SIGKILL", timedOut: true });
    expect(result.durationMs).toBeGreaterThanOrEqual(300 + STOP_GRACE_MS - 50);
    expect(await gone(Number(result.stdout.trim()))).toBe(true);
  });

  it("returns once the command exits even when a process it left behind holds the output open", async () => {
    const result = await runCommand(script(LEAVES_A_GRANDCHILD), { cwd: dir, env: {}, timeoutMs: 30_000 });
    expect(result).toMatchObject({ code: 0, signal: null, timedOut: false });
    expect(result.durationMs).toBeLessThan(STOP_GRACE_MS + 1_500);
    expect(await gone(Number(result.stdout.trim()))).toBe(true);
  });

  it("keeps the head and the tail of an oversized stream and says what it dropped", async () => {
    const result = await runCommand(
      script("process.stdout.write('FIRST-FAILURE ' + 'x'.repeat(100000) + ' FINAL-SUMMARY')"),
      { cwd: dir, env: {}, maxOutputBytes: 1_000 },
    );
    expect(result.stdout.startsWith("FIRST-FAILURE ")).toBe(true);
    expect(result.stdout.endsWith(" FINAL-SUMMARY")).toBe(true);
    expect(result.stdout).toMatch(/\[\.\.\. \d+ bytes omitted \.\.\.\]/);
    expect(result.stdout.length).toBeLessThan(1_100);
  });

  it("never cuts a multi-byte character in half", async () => {
    const result = await runCommand(
      script("process.stdout.write('\\u00e9'.repeat(5000))"),
      { cwd: dir, env: {}, maxOutputBytes: 102 },
    );
    expect(result.stdout).toContain("bytes omitted");
    expect(result.stdout).not.toContain("\ufffd");
  });

  it("leaves output under the limit untouched", async () => {
    const result = await runCommand(script("process.stdout.write('a'.repeat(500))"), { cwd: dir, env: {}, maxOutputBytes: 500 });
    expect(result.stdout).toBe("a".repeat(500));
  });
});

describe("baseEnvironment", () => {
  it("passes a shell and a home through, and no credential", () => {
    process.env.HIVEMIND_TEST_TOKEN = "must-not-travel";
    try {
      const env = baseEnvironment();
      expect(env.PATH).toBe(process.env.PATH);
      expect(env).not.toHaveProperty("HIVEMIND_TEST_TOKEN");
      expect(Object.values(env)).not.toContain("must-not-travel");
    } finally {
      delete process.env.HIVEMIND_TEST_TOKEN;
    }
  });

  it("adds what the caller declares, over what it inherited", () => {
    const env = baseEnvironment({ PATH: "/declared/bin", APP_FLAVOUR: "review" });
    expect(env).toMatchObject({ PATH: "/declared/bin", APP_FLAVOUR: "review" });
  });
});
