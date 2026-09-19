import { describe, expect, it } from "vitest";
import { startAppLane } from "./app-lane.js";
import { browserLaneInstructions } from "./executor.js";

const SERVER = [
  process.execPath,
  "-e",
  [
    "const http = require('node:http');",
    "http.createServer((req, res) => res.end('ok')).listen(Number(process.env.APP_PORT));",
    "setInterval(() => undefined, 1000);",
  ].join(" "),
];

let nextPort = 44_000 + Math.floor(Math.random() * 1000);
const port = () => nextPort++;

describe("startAppLane", () => {
  it("hands the verifier the address it started the application on, and the host to reach it", async () => {
    const p = port();
    const lane = await startAppLane(
      {
        cwd: process.cwd(),
        command: SERVER,
        readyUrl: `http://127.0.0.1:${p}/`,
        timeoutMs: 10_000,
        env: { APP_PORT: String(p) },
      },
      ["localhost"],
    );
    try {
      expect(lane.app).toEqual({ url: `http://127.0.0.1:${p}/` });
      expect(lane.allowedHosts).toEqual(["localhost", "127.0.0.1"]);
    } finally {
      await lane.stop();
    }
    await expect(fetch(`http://127.0.0.1:${p}/`, { signal: AbortSignal.timeout(500) })).rejects.toThrow();
  });

  it("says the repository declares no application rather than leaving the verifier to invent one", async () => {
    const lane = await startAppLane(
      { cwd: process.cwd(), command: [], readyUrl: "", timeoutMs: 1_000 },
      ["127.0.0.1"],
    );
    expect(lane.app).toEqual({ unavailable: expect.stringContaining("verify.appStartCommand is empty") });
    expect(lane.allowedHosts).toEqual(["127.0.0.1"]);
    await lane.stop();
  });

  it("reports an application that never answers, and leaves nothing running", async () => {
    const lane = await startAppLane(
      {
        cwd: process.cwd(),
        command: [process.execPath, "-e", "process.exit(3)"],
        readyUrl: `http://127.0.0.1:${port()}/`,
        timeoutMs: 5_000,
      },
      [],
    );
    expect(lane.app).toEqual({ unavailable: expect.stringContaining("could not be started") });
    await lane.stop();
  });

  it("keeps the same host list when the lane already allows the application's host", async () => {
    const p = port();
    const lane = await startAppLane(
      {
        cwd: process.cwd(),
        command: SERVER,
        readyUrl: `http://127.0.0.1:${p}/`,
        timeoutMs: 10_000,
        env: { APP_PORT: String(p) },
      },
      ["127.0.0.1"],
    );
    try {
      expect(lane.allowedHosts).toEqual(["127.0.0.1"]);
    } finally {
      await lane.stop();
    }
  });
});

describe("browserLaneInstructions", () => {
  it("names the running application and forbids a substitute", () => {
    const text = browserLaneInstructions("s", ["127.0.0.1"], { url: "http://127.0.0.1:4319/" });
    expect(text).toContain("already running at http://127.0.0.1:4319/");
    expect(text).not.toContain("start it yourself");
  });

  it("makes a missing application an inconclusive screen scenario rather than a reason to improvise", () => {
    const text = browserLaneInstructions("s", ["127.0.0.1"], { unavailable: "no application is configured" });
    expect(text).toContain("no application is configured");
    expect(text).toContain("inconclusive this round");
    expect(text).not.toContain("start it yourself");
  });

  it("still tells a repository with no application lane to bring up what a page needs", () => {
    const text = browserLaneInstructions("s", ["127.0.0.1"]);
    expect(text).toContain("start it yourself");
  });
});
