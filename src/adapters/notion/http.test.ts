import { afterEach, describe, expect, it, vi } from "vitest";
import { NOTION_VERSION, NotionError, createNotionTransport, type NotionTransportOptions } from "./http.ts";

afterEach(() => {
  vi.useRealTimers();
});

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
  at: number;
}

type Reply = Response | Error;

/** A fetch that records what it was sent and answers from a script; once the
 * script runs out, its last reply repeats. */
function scriptedFetch(...replies: Reply[]): { fetch: typeof fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    sent.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: { ...(init?.headers as Record<string, string>) },
      body: typeof init?.body === "string" ? init.body : undefined,
      at: Date.now(),
    });
    const reply = replies[Math.min(sent.length, replies.length) - 1]!;
    if (reply instanceof Error) throw reply;
    return reply.clone();
  };
  return { fetch: fetchImpl as typeof fetch, sent };
}

function json(status: number, data: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers });
}

function notionError(status: number, code: string, message: string, headers: Record<string, string> = {}): Response {
  return json(status, { object: "error", status, code, message }, headers);
}

/** What undici throws when the connection itself fails. */
function fetchFailed(code: string): Error {
  return new TypeError("fetch failed", { cause: Object.assign(new Error(`read ${code}`), { code }) });
}

/** What the request's AbortSignal.timeout rejects with. */
function timedOut(): Error {
  return new DOMException("The operation was aborted due to timeout", "TimeoutError");
}

const FAST: Partial<NotionTransportOptions> = { ratePerSecond: 1_000_000, retryBackoffMs: 0 };

describe("requests", () => {
  it("speaks the versioned API with the token as a bearer header", async () => {
    const { fetch, sent } = scriptedFetch(json(200, { object: "page", id: "page-1" }));
    const transport = createNotionTransport({ token: "secret-token", fetch, ...FAST });

    await expect(transport({ method: "PATCH", path: "/v1/pages/page-1", body: { properties: {} } }))
      .resolves.toEqual({ object: "page", id: "page-1" });
    expect(sent[0]).toMatchObject({
      url: "https://api.notion.com/v1/pages/page-1",
      method: "PATCH",
      body: JSON.stringify({ properties: {} }),
      headers: {
        authorization: "Bearer secret-token",
        "notion-version": "2025-09-03",
        "content-type": "application/json",
      },
    });
    expect(NOTION_VERSION).toBe("2025-09-03");
  });

  it("sends no content type with a bodiless read", async () => {
    const { fetch, sent } = scriptedFetch(json(200, { object: "user", id: "u-1" }));
    await createNotionTransport({ token: "t", fetch, ...FAST })({ method: "GET", path: "/v1/users/u-1" });
    expect(sent[0]?.headers).not.toHaveProperty("content-type");
  });

  it("says which request failed and why, never repeating the token, and does not resend a refusal", async () => {
    const { fetch, sent } = scriptedFetch(notionError(
      400,
      "validation_error",
      "body.children[0].paragraph.rich_text[0].text.content.length should be <= 2000",
    ));
    const transport = createNotionTransport({ token: "secret-token", fetch, ...FAST });

    const error = await transport({ method: "PATCH", path: "/v1/blocks/page-1/children", body: { children: [] } })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NotionError);
    expect(error).toMatchObject({ status: 400, code: "validation_error" });
    const message = (error as Error).message;
    expect(message).toContain("PATCH /v1/blocks/page-1/children failed with status 400 validation_error");
    expect(message).toContain("should be <= 2000");
    expect(message).not.toContain("secret-token");
    expect(sent).toHaveLength(1);
  });

  it("hands a page a person deleted back as a 404 the caller can tell apart", async () => {
    const { fetch } = scriptedFetch(notionError(404, "object_not_found", "Could not find block with ID: page-1."));
    await expect(createNotionTransport({ token: "t", fetch, ...FAST })({ method: "GET", path: "/v1/blocks/page-1/children" }))
      .rejects.toMatchObject({ name: "NotionError", status: 404, code: "object_not_found" });
  });

  it("treats archiving an already archived block as done", async () => {
    const { fetch, sent } = scriptedFetch(notionError(
      400,
      "validation_error",
      "Can't edit block that is archived. You must unarchive the block before editing.",
    ));
    const transport = createNotionTransport({ token: "t", fetch, ...FAST });

    await expect(transport({ method: "PATCH", path: "/v1/blocks/block-1", body: { archived: true } })).resolves.toBeDefined();
    expect(sent).toHaveLength(1);
    // The same refusal to an edit that is not an archive is still a failure.
    await expect(transport({ method: "PATCH", path: "/v1/blocks/block-1", body: { paragraph: { rich_text: [] } } }))
      .rejects.toMatchObject({ status: 400 });
  });
});

describe("rate", () => {
  it("paces the whole process at 2.5 requests per second", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { fetch, sent } = scriptedFetch(json(200, {}));
    const transport = createNotionTransport({ token: "t", fetch });

    const requests = [1, 2, 3].map((value) => transport({ method: "GET", path: `/v1/users/${value}` }));
    await vi.advanceTimersByTimeAsync(800);
    await Promise.all(requests);
    expect(sent.map((request) => request.at)).toEqual([0, 400, 800]);
  });

  it("holds every request for a 429's Retry-After, not only the one that drew it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { fetch, sent } = scriptedFetch(
      notionError(429, "rate_limited", "This request exceeds the number of requests allowed.", { "retry-after": "2" }),
      json(200, {}),
    );
    const transport = createNotionTransport({ token: "t", fetch });

    const limited = transport({ method: "GET", path: "/v1/limited" });
    const bystander = transport({ method: "GET", path: "/v1/bystander" });
    await vi.advanceTimersByTimeAsync(2_400);
    await Promise.all([limited, bystander]);
    expect(sent.map((request) => [new URL(request.url).pathname, request.at])).toEqual([
      ["/v1/limited", 0],
      ["/v1/bystander", 2_000],
      ["/v1/limited", 2_400],
    ]);
  });

  // Notion refuses a rate-limited request before doing any of it, so even an
  // append is safe to send again after one.
  it("resends a rate-limited write", async () => {
    const { fetch, sent } = scriptedFetch(
      notionError(429, "rate_limited", "slow down", { "retry-after": "0" }),
      json(200, { object: "list", results: [] }),
    );
    const transport = createNotionTransport({ token: "t", fetch, ...FAST });
    await expect(transport({ method: "PATCH", path: "/v1/blocks/page-1/children", body: { children: [] } }))
      .resolves.toEqual({ object: "list", results: [] });
    expect(sent).toHaveLength(2);
  });

  it("gives up on a request that stays rate limited", async () => {
    const { fetch, sent } = scriptedFetch(notionError(429, "rate_limited", "slow down", { "retry-after": "0" }));
    await expect(createNotionTransport({ token: "t", fetch, ...FAST })({ method: "GET", path: "/v1/users/u-1" }))
      .rejects.toMatchObject({ status: 429, code: "rate_limited" });
    expect(sent).toHaveLength(3);
  });
});

describe("a fault that says nothing about the payload", () => {
  it.each([
    ["a timeout", timedOut()],
    ["a reset connection", fetchFailed("ECONNRESET")],
    ["a connect timeout", fetchFailed("ETIMEDOUT")],
    ["a failed DNS lookup", fetchFailed("EAI_AGAIN")],
    ["a 502", notionError(502, "bad_gateway", "Bad Gateway")],
    ["a 503 page that is not JSON", new Response("<html>Service Unavailable</html>", { status: 503 })],
  ])("sends a read again after %s", async (_label, fault) => {
    const { fetch, sent } = scriptedFetch(fault, json(200, { object: "list", results: [] }));
    await expect(createNotionTransport({ token: "t", fetch, ...FAST })({ method: "GET", path: "/v1/blocks/page-1/children" }))
      .resolves.toEqual({ object: "list", results: [] });
    expect(sent).toHaveLength(2);
  });

  it("backs off before sending a read again", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { fetch, sent } = scriptedFetch(fetchFailed("ECONNRESET"), json(200, {}));
    const request = createNotionTransport({ token: "t", fetch })({ method: "GET", path: "/v1/users/u-1" });
    await vi.advanceTimersByTimeAsync(1_000);
    await request;
    expect(sent.map((item) => item.at)).toEqual([0, 1_000]);
  });

  it("gives up on a read that keeps failing, naming the request and the fault", async () => {
    const { fetch, sent } = scriptedFetch(fetchFailed("ECONNRESET"));
    const error = await createNotionTransport({ token: "t", fetch, ...FAST })({ method: "GET", path: "/v1/users/u-1" })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ name: "NotionError", status: null, code: "ECONNRESET" });
    expect((error as Error).message).toBe("GET /v1/users/u-1 failed: fetch failed");
    expect(sent).toHaveLength(3);
  });

  // An append is not idempotent: the one that timed out may already have
  // landed, so sending it again is how a page grows a duplicate block.
  it.each([
    ["a timeout", timedOut()],
    ["a reset connection", fetchFailed("ECONNRESET")],
    ["a 502", notionError(502, "bad_gateway", "Bad Gateway")],
  ])("hands a write back after %s instead of sending it again", async (_label, fault) => {
    const { fetch, sent } = scriptedFetch(fault, json(200, {}));
    await expect(createNotionTransport({ token: "t", fetch, ...FAST })({
      method: "PATCH",
      path: "/v1/blocks/page-1/children",
      body: { children: [] },
    })).rejects.toBeInstanceOf(NotionError);
    expect(sent).toHaveLength(1);
  });

  it("does not resend a read after a fault nobody recognises", async () => {
    const { fetch, sent } = scriptedFetch(new TypeError("Invalid URL"), json(200, {}));
    await expect(createNotionTransport({ token: "t", fetch, ...FAST })({ method: "GET", path: "/v1/users/u-1" }))
      .rejects.toMatchObject({ status: null });
    expect(sent).toHaveLength(1);
  });
});
