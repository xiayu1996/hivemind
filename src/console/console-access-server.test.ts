import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ConsoleAccessDecision,
  ConsoleAccessPage,
  ConsoleAccessPolicy,
} from "./access-control.js";
import type { OverviewSnapshot } from "./overview-contract.js";
import type { ConsoleOverviewPage } from "./overview-page.js";
import {
  createConsoleServer,
  type ConsoleConfigWritePort,
  type ConsoleDataSource,
} from "./server.js";

const OVERVIEW = "\u8fd0\u884c\u603b\u89c8";
const TODO = "\u7b49\u5f85\u672c\u4eba\u5904\u7406";
const ACCESS_VERIFICATION = "\u8bbf\u95ee\u9a8c\u8bc1";
const UNAVAILABLE = "\u65e0\u6cd5\u8bbf\u95ee";
const DEVICE_DENIED = "\u5f53\u524d\u8bbe\u5907\u65e0\u6cd5\u8fdb\u5165\u540e\u53f0";
const RETRY_NETWORK = "\u91cd\u65b0\u68c0\u67e5\u7f51\u7edc";
const SECRET_RUN = "RUN-SECRET-91";
const SECRET_CONFIG = "CONFIG-SECRET-72";
const apps: Array<{ close(): Promise<void> }> = [];

function snapshot(): OverviewSnapshot {
  return {
    revision: SECRET_RUN,
    generatedAtMs: 1_800_000_000_000,
    contentState: { kind: "ready" },
    sections: {
      todos: [],
      active: [],
      failures: [],
      completed: [],
    },
    summary: {
      range: {
        startInclusiveMs: 1_799_395_200_000,
        endInclusiveMs: 1_800_000_000_000,
        timeZone: "Asia/Shanghai",
      },
      completedCount: 0,
      runningCount: 1,
      failureCount: 0,
      costUsd: 73.21,
      overruns: [],
    },
  };
}

function dataSource(): ConsoleDataSource {
  return {
    readOverview: vi.fn(async () => snapshot()),
    nodes: vi.fn(async () => [{ name: SECRET_RUN }]),
    tasks: vi.fn(async () => [{ id: SECRET_RUN }]),
    costs: vi.fn(async () => [{ amount: 73.21 }]),
    config: vi.fn(async () => [{ value: SECRET_CONFIG }]),
    stats: vi.fn(async () => ({ status: SECRET_RUN })),
    providers: vi.fn(async () => [{ value: SECRET_CONFIG }]),
    queue: vi.fn(async () => ({ waiting: [{ id: SECRET_RUN }] })),
  };
}

function writer(): ConsoleConfigWritePort {
  return {
    describe: vi.fn(async () => [{ value: SECRET_CONFIG }]),
    apply: vi.fn(async () => ({ value: SECRET_CONFIG })),
    rollback: vi.fn(async () => ({ value: SECRET_CONFIG })),
    history: vi.fn(async () => [{ value: SECRET_CONFIG }]),
  };
}

function overviewPage(): ConsoleOverviewPage {
  return {
    renderDocument: vi.fn(() => `<h1>${OVERVIEW}</h1><h2>${TODO}</h2><p>${SECRET_RUN}</p>`),
    renderBody: vi.fn(() => `<h2>${TODO}</h2><p>${SECRET_RUN}</p>`),
    renderRefreshedAt: vi.fn(() => "12:00"),
  };
}

function accessPage(): ConsoleAccessPage {
  return {
    renderDocument: vi.fn(() => `<main><h1>${ACCESS_VERIFICATION}</h1><h2>${UNAVAILABLE}</h2>`
      + `<p>${DEVICE_DENIED}</p><p>HOME-OFFICE-NETWORK</p><button>${RETRY_NETWORK}</button></main>`),
  };
}

function policy(
  decide: (remoteAddress: string | null) => ConsoleAccessDecision,
): ConsoleAccessPolicy & { authorize: ReturnType<typeof vi.fn> } {
  return {
    authorize: vi.fn((source: { remoteAddress: string | null }) => decide(source.remoteAddress)),
  };
}

function deniedPolicy(reason: "allowed_networks_unconfigured" | "source_outside_allowed_networks" = "source_outside_allowed_networks") {
  return policy(() => ({ allowed: false, reason }));
}

function callsOf(data: ConsoleDataSource, configWriter?: ConsoleConfigWritePort): unknown[] {
  const ports = [
    data.readOverview,
    data.nodes,
    data.tasks,
    data.costs,
    data.config,
    data.stats,
    data.providers,
    data.queue,
    configWriter?.describe,
    configWriter?.apply,
    configWriter?.rollback,
    configWriter?.history,
  ];
  return ports.flatMap((port) => port && "mock" in port ? (port as ReturnType<typeof vi.fn>).mock.calls : []);
}

async function server(input: {
  accessPolicy: ConsoleAccessPolicy;
  source?: ConsoleDataSource;
  configWriter?: ConsoleConfigWritePort;
}) {
  const app = await createConsoleServer(input.source ?? dataSource(), {
    accessPolicy: input.accessPolicy,
    accessPage: accessPage(),
    ...(input.configWriter === undefined ? {} : { configWriter: input.configWriter }),
    overviewPage: overviewPage(),
  });
  apps.push(app);
  return app;
}

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  vi.restoreAllMocks();
});

describe("console access boundary", () => {
  it("@scenario S-R237511OV-02-allowed serves overview content from home and office peers", async () => {
    const accessPolicy = policy((remoteAddress) => remoteAddress === "192.0.2.40" || remoteAddress === "198.51.100.60"
      ? { allowed: true, matchedNetwork: remoteAddress === "192.0.2.40" ? "192.0.2.0/24" : "198.51.100.0/24" }
      : { allowed: false, reason: "source_outside_allowed_networks" });
    const app = await server({ accessPolicy });

    for (const remoteAddress of ["192.0.2.40", "198.51.100.60"]) {
      const response = await app.inject({ method: "GET", url: "/overview", remoteAddress });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain(OVERVIEW);
      expect(response.body).toContain(TODO);
      expect(response.body).not.toContain(ACCESS_VERIFICATION);
      expect(response.body).not.toContain(UNAVAILABLE);
    }
    expect(accessPolicy.authorize).toHaveBeenNthCalledWith(1, { remoteAddress: "192.0.2.40" });
    expect(accessPolicy.authorize).toHaveBeenNthCalledWith(2, { remoteAddress: "198.51.100.60" });
  });

  it("@scenario S-R237511OV-02-allowed checks every request rather than trusting an earlier allowed request", async () => {
    const accessPolicy = policy((remoteAddress) => remoteAddress === "192.0.2.40"
      ? { allowed: true, matchedNetwork: "192.0.2.0/24" }
      : { allowed: false, reason: "source_outside_allowed_networks" });
    const app = await server({ accessPolicy });

    expect((await app.inject({ method: "GET", url: "/overview", remoteAddress: "192.0.2.40" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/overview", remoteAddress: "203.0.113.90" })).statusCode).toBe(403);
    expect(accessPolicy.authorize).toHaveBeenCalledTimes(2);
  });

  it("@scenario S-R237511OV-02-deniedrequest refuses health, reads and writes before touching a port", async () => {
    const source = dataSource();
    const configWriter = writer();
    const app = await server({ accessPolicy: deniedPolicy(), source, configWriter });
    const requests = [
      { method: "GET", url: "/health" },
      { method: "GET", url: "/api/overview?timeZone=Asia%2FShanghai" },
      { method: "GET", url: "/api/config" },
      { method: "GET", url: "/api/config/schema" },
      { method: "POST", url: "/api/config/value", payload: { key: "x", value: SECRET_CONFIG, updatedBy: "owner" } },
    ] as const;

    for (const request of requests) {
      const response = await app.inject({ ...request, remoteAddress: "203.0.113.90" });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({
        error: "console_access_denied",
        reason: "source_outside_allowed_networks",
      });
      expect(response.body).not.toContain(SECRET_RUN);
      expect(response.body).not.toContain(SECRET_CONFIG);
      expect(response.body).not.toContain("73.21");
    }
    expect(callsOf(source, configWriter)).toEqual([]);
  });

  it("@scenario S-R237511OV-02-deniedrequest denies unsupported and unknown requests before route handling", async () => {
    const source = dataSource();
    const app = await server({ accessPolicy: deniedPolicy(), source });

    for (const request of [
      { method: "DELETE", url: "/api/tasks" },
      { method: "POST", url: "/unknown", payload: { value: SECRET_CONFIG } },
      { method: "HEAD", url: "/health" },
    ] as const) {
      const response = await app.inject({ ...request, remoteAddress: "203.0.113.90" });
      expect(response.statusCode).toBe(403);
      expect(response.body).not.toContain(SECRET_RUN);
      expect(response.body).not.toContain(SECRET_CONFIG);
    }
    expect(callsOf(source)).toEqual([]);
  });

  it("@scenario S-R237511OV-02-retry enters the same requested page after the peer joins an allowed network", async () => {
    const accessPolicy = policy((remoteAddress) => remoteAddress === "192.0.2.40"
      ? { allowed: true, matchedNetwork: "192.0.2.0/24" }
      : { allowed: false, reason: "source_outside_allowed_networks" });
    const app = await server({ accessPolicy });
    const originalUrl = "/overview?state=empty";

    const denied = await app.inject({ method: "GET", url: originalUrl, remoteAddress: "203.0.113.90" });
    expect(denied.statusCode).toBe(403);
    expect(denied.body).toContain(DEVICE_DENIED);
    expect(denied.body).toContain(RETRY_NETWORK);

    const retried = await app.inject({ method: "GET", url: originalUrl, remoteAddress: "192.0.2.40" });
    expect(retried.statusCode).toBe(200);
    expect(retried.body).toContain(OVERVIEW);
    expect(retried.body).not.toContain(DEVICE_DENIED);
    expect(accessPolicy.authorize).toHaveBeenCalledTimes(2);
  });

  it("@scenario S-R237511OV-02-retry does not use a caller-supplied return target", async () => {
    const app = await server({ accessPolicy: deniedPolicy() });
    const externalTarget = "https://example.invalid/stolen";

    const response = await app.inject({
      method: "GET",
      url: `/overview?returnTo=${encodeURIComponent(externalTarget)}`,
      remoteAddress: "203.0.113.90",
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toContain(RETRY_NETWORK);
    expect(response.body).not.toContain(externalTarget);
    expect(response.headers.location).toBeUndefined();
  });

  it("@scenario S-R237511OV-02-spoof ignores forwarding headers and claimed source parameters", async () => {
    const accessPolicy = deniedPolicy();
    const source = dataSource();
    const app = await server({ accessPolicy, source });

    const response = await app.inject({
      method: "GET",
      url: "/api/tasks?remoteAddress=192.0.2.40",
      remoteAddress: "203.0.113.90",
      headers: {
        forwarded: "for=192.0.2.40",
        "x-forwarded-for": "192.0.2.40",
        "x-real-ip": "192.0.2.40",
        cookie: "console_source=192.0.2.40",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: "console_access_denied",
      reason: "source_outside_allowed_networks",
    });
    expect(accessPolicy.authorize).toHaveBeenCalledWith({ remoteAddress: "203.0.113.90" });
    expect(callsOf(source)).toEqual([]);
  });

  it("@scenario S-R237511OV-02-spoof ignores a claimed source in a mutation body", async () => {
    const accessPolicy = deniedPolicy();
    const configWriter = writer();
    const source = dataSource();
    const app = await server({ accessPolicy, source, configWriter });

    const response = await app.inject({
      method: "POST",
      url: "/api/config/value",
      remoteAddress: "203.0.113.90",
      payload: {
        key: "console.allowedNetworks",
        value: ["0.0.0.0/0"],
        updatedBy: "owner",
        remoteAddress: "192.0.2.40",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(accessPolicy.authorize).toHaveBeenCalledWith({ remoteAddress: "203.0.113.90" });
    expect(callsOf(source, configWriter)).toEqual([]);
  });

  it("@scenario S-R237511OV-02-unconfigured denies page and API access before reading content", async () => {
    const source = dataSource();
    const app = await server({ accessPolicy: deniedPolicy("allowed_networks_unconfigured"), source });

    const page = await app.inject({ method: "GET", url: "/overview", remoteAddress: "127.0.0.1" });
    const api = await app.inject({ method: "GET", url: "/api/tasks", remoteAddress: "10.0.0.8" });

    expect(page.statusCode).toBe(403);
    expect(page.body).toContain(ACCESS_VERIFICATION);
    expect(page.body).not.toContain(SECRET_RUN);
    expect(api.statusCode).toBe(403);
    expect(api.json()).toEqual({
      error: "console_access_denied",
      reason: "allowed_networks_unconfigured",
    });
    expect(callsOf(source)).toEqual([]);
  });

  it("@scenario S-R237511OV-02-unconfigured does not implicitly trust loopback or private peers", async () => {
    const accessPolicy = deniedPolicy("allowed_networks_unconfigured");
    const app = await server({ accessPolicy });

    for (const remoteAddress of ["127.0.0.1", "10.0.0.8", "192.168.1.8", "::1"]) {
      const response = await app.inject({ method: "GET", url: "/health", remoteAddress });
      expect(response.statusCode).toBe(403);
      expect(response.json().reason).toBe("allowed_networks_unconfigured");
    }
    expect(accessPolicy.authorize).toHaveBeenCalledTimes(4);
  });
});
