import { describe, expect, it } from "vitest";
import { AppUnderReview } from "./app-under-review.js";

const SERVER = [
  process.execPath,
  "-e",
  [
    "const http = require('node:http');",
    "const delay = Number(process.env.APP_DELAY_MS ?? 0);",
    "setTimeout(() => http.createServer((req, res) => res.end('ok')).listen(Number(process.env.APP_PORT)), delay);",
    "setInterval(() => undefined, 1000);",
  ].join(" "),
];

let nextPort = 43_000 + Math.floor(Math.random() * 1000);
const port = () => nextPort++;

async function alive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("AppUnderReview", () => {
  it("reports started once the ready URL answers, and stops the process it started", async () => {
    const app = new AppUnderReview();
    const p = port();
    const lines: string[] = [];
    const result = await app.start({
      cwd: process.cwd(),
      command: SERVER,
      readyUrl: `http://127.0.0.1:${p}/`,
      timeoutMs: 10_000,
      env: { APP_PORT: String(p), APP_DELAY_MS: "300" },
      log: (line) => lines.push(line),
    });
    expect(result).toEqual({ started: true, url: `http://127.0.0.1:${p}/` });
    const pid = (app as unknown as { child: { pid: number } }).child.pid;
    expect(await alive(pid)).toBe(true);
    await app.stop();
    expect(await alive(pid)).toBe(false);
    await expect(fetch(`http://127.0.0.1:${p}/`)).rejects.toThrow();
  });

  it("reports a reason instead of throwing when the application never answers", async () => {
    const app = new AppUnderReview();
    const p = port();
    const result = await app.start({
      cwd: process.cwd(),
      command: SERVER,
      readyUrl: `http://127.0.0.1:${p}/`,
      timeoutMs: 700,
      env: { APP_PORT: String(p), APP_DELAY_MS: "60000" },
    });
    expect(result.started).toBe(false);
    if (!result.started) expect(result.reason).toContain("did not answer");
    await app.stop();
  });

  it("reports the application's own exit and output when it dies before it is ready", async () => {
    const app = new AppUnderReview();
    const result = await app.start({
      cwd: process.cwd(),
      command: [process.execPath, "-e", "console.error('port in use'); process.exit(3)"],
      readyUrl: `http://127.0.0.1:${port()}/`,
      timeoutMs: 5_000,
    });
    expect(result).toMatchObject({ started: false });
    if (!result.started) {
      expect(result.reason).toContain("exited with code 3");
      expect(result.reason).toContain("port in use");
    }
  });

  it("reports a command that cannot be spawned", async () => {
    const app = new AppUnderReview();
    const result = await app.start({
      cwd: process.cwd(),
      command: ["/nonexistent/hivemind-app"],
      readyUrl: `http://127.0.0.1:${port()}/`,
      timeoutMs: 5_000,
    });
    expect(result).toMatchObject({ started: false });
    if (!result.started) expect(result.reason).toContain("could not spawn");
  });

  it("has nothing to start when no command is configured", async () => {
    const result = await new AppUnderReview().start({ cwd: process.cwd(), command: [], readyUrl: "", timeoutMs: 1 });
    expect(result).toEqual({ started: false, reason: "no application start command is configured" });
  });

  it("runs the seed command with the seed text and scenario id in its environment", async () => {
    const app = new AppUnderReview();
    const result = await app.seed({
      cwd: process.cwd(),
      command: [process.execPath, "-e", "console.log(process.env.HIVEMIND_SCENARIO + '|' + process.env.HIVEMIND_SEED)"],
      scenarioId: "S-EPIC-01-a",
      seed: "one repository with 3 stories",
    });
    expect(result).toEqual({ ok: true, output: "S-EPIC-01-a|one repository with 3 stories" });
  });

  it("reports a failed seed with its output rather than throwing", async () => {
    const result = await new AppUnderReview().seed({
      cwd: process.cwd(),
      command: [process.execPath, "-e", "console.error('no database'); process.exit(2)"],
      scenarioId: "S-EPIC-01-a",
      seed: "anything",
    });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("no database");
    expect(result.output).toContain("exited with code 2");
  });
});
