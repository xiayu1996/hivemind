import { afterEach, describe, expect, it, vi } from "vitest";
import {
  archiveBlock,
  isTransientNotionFailure,
  NotionGateway,
  NotionGatewayError,
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

describe("a fault that says nothing about the payload", () => {
  it("names a timeout, a 5xx and a rate limit, and nothing else", () => {
    expect(isTransientNotionFailure(new Error("The operation was aborted due to timeout"))).toBe(true);
    expect(isTransientNotionFailure(new Error("fetch failed"))).toBe(true);
    expect(isTransientNotionFailure(new NotionGatewayError("boom", 502))).toBe(true);
    expect(isTransientNotionFailure(new NotionGatewayError("slow down", 429))).toBe(true);
    expect(isTransientNotionFailure(new NotionGatewayError("body.rich_text is too long", 400))).toBe(false);
    expect(isTransientNotionFailure(new Error("Notion Story page did not converge"))).toBe(false);
  });

  it("sends a read again rather than losing the pass it belongs to", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let calls = 0;
    const gateway = new NotionGateway({
      transport: async () => {
        calls++;
        if (calls === 1) throw new Error("The operation was aborted due to timeout");
        return ok({ read: calls });
      },
      ratePerSecond: 1_000_000,
      mergeWindowMs: 10,
      readRetryBackoffMs: 1_000,
    });
    const request = gateway.request({ method: "GET", path: "/blocks/x/children", priority: "projection" });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(request).resolves.toMatchObject({ data: { read: 2 } });
    expect(calls).toBe(2);
  });

  // An append is not idempotent: the one that timed out may already have
  // landed, so sending it again is how a page grows a duplicate block.
  it("hands a timed-out append back instead of sending it again", async () => {
    let calls = 0;
    const gateway = new NotionGateway({
      transport: async () => {
        calls++;
        throw new Error("The operation was aborted due to timeout");
      },
      ratePerSecond: 1_000_000,
      mergeWindowMs: 10,
      readRetryBackoffMs: 0,
    });
    await expect(gateway.request({
      method: "PATCH",
      path: "/blocks/x/children",
      priority: "projection",
      body: { children: [] },
    })).rejects.toThrow(/aborted due to timeout/);
    expect(calls).toBe(1);
  });

  // A page projection is dozens of requests, so "The operation was aborted due
  // to timeout" on its own named an operation and a card and left the call
  // itself to guesswork -- one Story's page failed that way five times running.
  it("says which request timed out", async () => {
    const gateway = new NotionGateway({
      transport: async () => { throw new Error("The operation was aborted due to timeout"); },
      ratePerSecond: 1_000_000,
      mergeWindowMs: 10,
      readRetryBackoffMs: 0,
    });

    await expect(gateway.request({
      method: "PATCH",
      path: "/v1/blocks/page-1/children",
      priority: "projection",
      body: { children: [] },
    })).rejects.toThrow("PATCH /v1/blocks/page-1/children failed: The operation was aborted due to timeout");
  });

  // Transience is decided by reading the message, so the wrapper has to keep
  // the original inside it or a timeout stops being retryable.
  it("keeps a named timeout retryable", () => {
    expect(isTransientNotionFailure(
      new Error("PATCH /v1/blocks/page-1/children failed: The operation was aborted due to timeout"),
    )).toBe(true);
  });

  it("gives up on a read that keeps faulting", async () => {
    let calls = 0;
    const gateway = new NotionGateway({
      transport: async () => {
        calls++;
        throw new Error("fetch failed");
      },
      ratePerSecond: 1_000_000,
      mergeWindowMs: 10,
      readRetryBackoffMs: 0,
    });
    await expect(gateway.request({ method: "GET", path: "/x", priority: "projection" }))
      .rejects.toThrow(/fetch failed/);
    expect(calls).toBe(3);
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

describe("archiving a block", () => {
  it("treats Notion's refusal to edit an already archived block as done", async () => {
    const request = vi.fn(async () => {
      throw new Error(
        "PATCH /v1/blocks/abc failed with status 400: {\"code\":\"validation_error\",\"message\":\"Can't edit block that is archived. You must unarchive the block before editing.\"}",
      );
    });
    await expect(archiveBlock(request as unknown as (input: NotionRequest) => Promise<NotionTransportResponse>, "abc")).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("lets every other failure through", async () => {
    const request = vi.fn(async () => {
      throw new Error("PATCH /v1/blocks/abc failed with status 502");
    });
    await expect(
      archiveBlock(request as unknown as (input: NotionRequest) => Promise<NotionTransportResponse>, "abc"),
    ).rejects.toThrow("status 502");
  });
});
