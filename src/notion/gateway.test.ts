import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NotionGateway,
  type NotionRequest,
  type NotionTransport,
  type NotionTransportResponse,
} from "./gateway.js";

afterEach(() => {
  vi.useRealTimers();
});

function ok(data: unknown = {}): NotionTransportResponse {
  return { status: 200, data };
}

describe("priority queue", () => {
  it("lets an interaction overtake queued report and projection work", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let calls = 0;
    const transport: NotionTransport = async (request) => {
      order.push(request.path);
      if (calls++ === 0) await firstGate;
      return ok();
    };
    const gateway = new NotionGateway({ transport, ratePerSecond: 1_000_000, mergeWindowMs: 10 });

    const active = gateway.request({ method: "POST", path: "/active", priority: "report" });
    const report = gateway.request({ method: "POST", path: "/report", priority: "report" });
    const projection = gateway.request({ method: "POST", path: "/projection", priority: "projection" });
    const interaction = gateway.request({ method: "POST", path: "/interaction", priority: "interaction" });
    releaseFirst();
    await Promise.all([active, report, projection, interaction]);
    expect(order).toEqual(["/active", "/interaction", "/report", "/projection"]);
  });
});

describe("rate and retry", () => {
  it("paces requests at 2.5 rps", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const times: number[] = [];
    const gateway = new NotionGateway({
      transport: async () => { times.push(Date.now()); return ok(); },
      ratePerSecond: 2.5,
      mergeWindowMs: 10,
    });
    const requests = [1, 2, 3].map((value) => gateway.request({
      method: "GET", path: `/${value}`, priority: "status",
    }));
    await vi.advanceTimersByTimeAsync(800);
    await Promise.all(requests);
    expect(times).toEqual([0, 400, 800]);
  });

  it("paces one hundred concurrent writes without producing a 429 burst", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let last = -400;
    let rateLimits = 0;
    const gateway = new NotionGateway({
      transport: async () => {
        const now = Date.now();
        if (now - last < 400) rateLimits++;
        last = now;
        return ok();
      },
      ratePerSecond: 2.5,
      mergeWindowMs: 10,
    });
    const writes = Array.from({ length: 100 }, (_, index) => gateway.request({
      method: "PATCH",
      path: `/pages/${index}`,
      priority: "report",
      body: { index },
    }));
    await vi.advanceTimersByTimeAsync(39_600);
    await Promise.all(writes);
    expect(rateLimits).toBe(0);
  });

  it("honours Retry-After on 429 before retrying the same request", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const times: number[] = [];
    const gateway = new NotionGateway({
      transport: async () => {
        times.push(Date.now());
        return times.length === 1 ? { status: 429, data: {}, retryAfterSeconds: 2 } : ok();
      },
      ratePerSecond: 1_000_000,
      mergeWindowMs: 10,
    });
    const request = gateway.request({ method: "GET", path: "/retry", priority: "interaction" });
    await vi.advanceTimersByTimeAsync(2_000);
    await request;
    expect(times).toEqual([0, 2_000]);
  });
});

describe("property writes", () => {
  it("merges same-page writes in the configured window", async () => {
    vi.useFakeTimers();
    const sent: NotionRequest[] = [];
    const gateway = new NotionGateway({
      transport: async (request) => { sent.push(request); return ok({ id: "page-1" }); },
      ratePerSecond: 1_000_000,
      mergeWindowMs: 100,
    });
    const first = gateway.updatePageProperties({
      pageId: "page-1", properties: { status: "running", rounds: 1 }, fingerprint: "a",
    });
    const second = gateway.updatePageProperties({
      pageId: "page-1", properties: { rounds: 2, cost: 1.5 }, fingerprint: "b",
    });
    await vi.advanceTimersByTimeAsync(100);
    await Promise.all([first, second]);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toEqual({ properties: { status: "running", rounds: 2, cost: 1.5 } });
  });

  it("drops a write when the sync fingerprint is already current", async () => {
    const transport = vi.fn<NotionTransport>(async () => ok());
    const gateway = new NotionGateway({ transport, ratePerSecond: 1_000_000, mergeWindowMs: 1 });
    const result = await gateway.updatePageProperties({
      pageId: "page-1",
      properties: { status: "running" },
      fingerprint: "same",
      currentFingerprint: "same",
    });
    expect(result.skipped).toBe(true);
    expect(transport).not.toHaveBeenCalled();
  });
});
