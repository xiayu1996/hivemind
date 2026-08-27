import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcPiRunner } from "./rpc-runner.js";
import { RunnerDeadError, RunnerHandshakeError } from "./types.js";

const FAKE_PI = fileURLToPath(new URL("./testing/fake-pi.mjs", import.meta.url));
const FIXTURES = join(process.cwd(), "fixtures/rpc-errors");

const runners: RpcPiRunner[] = [];

// The fake speaks the RPC protocol on stdin/stdout, so it stands in for the binary.
function makeNodeRunner(mode = "normal", extraEnv: Record<string, string> = {}) {
  const runner = new RpcPiRunner({
    binary: FAKE_PI,
    provider: "fake",
    model: "fake-1",
    cwd: process.cwd(),
    tools: [],
    env: { FAKE_PI_MODE: mode, ...extraEnv },
  });
  runners.push(runner);
  return runner;
}

afterEach(async () => {
  await Promise.all(runners.splice(0).map((r) => r.stop().catch(() => undefined)));
});

describe("handshake", () => {
  it("completes against a healthy process", async () => {
    const runner = makeNodeRunner();
    await expect(runner.start()).resolves.toBeUndefined();
    expect(runner.alive).toBe(true);
  });

  it("kills the process when the handshake never answers, instead of reusing it", async () => {
    const runner = new RpcPiRunner({
      binary: FAKE_PI,
      provider: "fake", model: "fake-1", cwd: process.cwd(),
      env: { FAKE_PI_MODE: "silent" },
      handshakeTimeoutMs: 1_500,
    });
    runners.push(runner);

    const started = runner.start();
    await expect(started).rejects.toThrow(RunnerHandshakeError);
    // The contract that matters: a suspect process is never left running.
    expect(runner.alive).toBe(false);
  }, 30_000);

  it("fails when the process exits during startup", async () => {
    const runner = makeNodeRunner("exit");
    await expect(runner.start()).rejects.toThrow(RunnerHandshakeError);
    expect(runner.alive).toBe(false);
  });

  it("survives a non-JSON line without losing the handshake", async () => {
    const runner = makeNodeRunner("garbage");
    await expect(runner.start()).resolves.toBeUndefined();
    expect(runner.events().some((e) => e.type === "__unparseable__")).toBe(true);
  });
});

describe("prompt", () => {
  it("returns usage and no failure for a clean run", async () => {
    const runner = makeNodeRunner();
    await runner.start();
    const result = await runner.prompt("hello", 10_000);

    expect(result.settled).toBe(true);
    expect(result.failure).toBeNull();
    expect(result.usage).toMatchObject({ input: 100, output: 20, reasoning: 5 });
    expect(result.usage.costUsd).toBeCloseTo(0.001);
  });

  it("scopes events to the prompt that produced them rather than accumulating", async () => {
    const runner = makeNodeRunner();
    await runner.start();
    const first = await runner.prompt("one", 10_000);
    const second = await runner.prompt("two", 10_000);

    // Both replays are identical, so the check is that the second result covers
    // one replay and not two: usage must not double.
    expect(second.events).toHaveLength(first.events.length);
    expect(second.usage.input).toBe(100);
    expect(runner.events().length).toBeGreaterThanOrEqual(first.events.length + second.events.length);
  });

  it("throws on a command-level rejection rather than waiting for events", async () => {
    const runner = makeNodeRunner("reject-prompt");
    await runner.start();
    await expect(runner.prompt("hello", 5_000)).rejects.toThrow(/prompt rejected: agent is streaming/);
  });

  it("surfaces a provider failure replayed from a captured fixture", async () => {
    const runner = makeNodeRunner("normal", { FAKE_PI_FIXTURE: join(FIXTURES, "rate_limit.json") });
    await runner.start();
    const result = await runner.prompt("hello", 10_000);

    expect(result.failure).not.toBeNull();
    expect(result.failure!.errorMessage).toMatch(/429/);
    expect(result.failure!.willRetry).toBe(false);
  });

  it("classifies every captured error fixture through the same path", async () => {
    for (const name of ["auth", "server", "transport", "invalid_request"]) {
      const runner = makeNodeRunner("normal", { FAKE_PI_FIXTURE: join(FIXTURES, `${name}.json`) });
      await runner.start();
      const result = await runner.prompt("hello", 10_000);
      expect(result.failure, name).not.toBeNull();
      await runner.stop();
    }
  }, 30_000);
});

describe("lifecycle", () => {
  it("reports commands against a stopped process as dead", async () => {
    const runner = makeNodeRunner();
    await runner.start();
    await runner.stop();
    expect(runner.alive).toBe(false);
    await expect(runner.getState()).rejects.toThrow(RunnerDeadError);
  });

  it("refuses to start twice", async () => {
    const runner = makeNodeRunner();
    await runner.start();
    await expect(runner.start()).rejects.toThrow(/already started/);
  });

  it("stop is safe to call more than once", async () => {
    const runner = makeNodeRunner();
    await runner.start();
    await runner.stop();
    await expect(runner.stop()).resolves.toBeUndefined();
  });
});

describe("commands", () => {
  it("round-trips get_messages and get_state", async () => {
    const runner = makeNodeRunner();
    await runner.start();
    expect(await runner.getMessages()).toHaveLength(1);
    expect(await runner.getState()).toMatchObject({ sessionFile: "/tmp/fake.jsonl" });
  });

  it("accepts steer, abort and set_auto_retry", async () => {
    const runner = makeNodeRunner();
    await runner.start();
    await expect(runner.setAutoRetry(false)).resolves.toBeUndefined();
    await expect(runner.steer("change course")).resolves.toBeUndefined();
    await expect(runner.abort()).resolves.toBeUndefined();
  });
});
