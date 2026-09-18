import { describe, expect, it } from "vitest";
import { HttpSystemOne, JudgeError, type SystemOneRequest } from "./system-one.js";

const REQUEST: SystemOneRequest = {
  model: "jev-latest",
  state: { reasons: ["the dev server was not listening"] },
  questions: {
    reason_0: { type: "noul", instructions: "Is this about the box?", criteria: { true: "yes", false: "no" } },
  },
};

function client(call: typeof globalThis.fetch, timeoutMs = 1000): HttpSystemOne {
  return new HttpSystemOne({
    endpoint: "https://judge.example/v1/systemone",
    apiKey: "key-under-test",
    timeoutMs,
    fetch: call,
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("HttpSystemOne", () => {
  it("sends the question as one posted document with the key on the request alone", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const judge = client(async (url, init) => {
      seen = { url: String(url), init: init as RequestInit };
      return json({ answers: { reason_0: { type: "noul", noul: 0.9 } } });
    });

    await judge.ask(REQUEST);

    expect(seen!.url).toBe("https://judge.example/v1/systemone");
    expect(seen!.init.method).toBe("POST");
    const headers = seen!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer key-under-test");
    expect(JSON.parse(String(seen!.init.body))).toEqual(REQUEST);
  });

  it("reads the probability back for each question it asked", async () => {
    const judge = client(async () => json({
      answers: { reason_0: { type: "noul", noul: 0.91 }, reason_1: { type: "noul", noul: 0.04 } },
    }));

    const response = await judge.ask(REQUEST);

    expect(response.answers.reason_0?.noul).toBe(0.91);
    expect(response.answers.reason_1?.noul).toBe(0.04);
  });

  it("tells a refused credential apart from a busy service and from a broken one", async () => {
    for (const [status, kind] of [[401, "auth"], [403, "auth"], [429, "rate_limit"], [500, "server"]] as const) {
      const judge = client(async () => json({ error: "nope" }, status));
      await expect(judge.ask(REQUEST)).rejects.toMatchObject({ kind });
    }
  });

  it("refuses an answer that is not a probability rather than comparing it against the threshold", async () => {
    // An undefined or out-of-range value silently compares false against every
    // threshold, which would read as "the judge is sure it is the code" when
    // what happened is that the contract changed.
    for (const answers of [
      { reason_0: { type: "noul" } },
      { reason_0: { type: "noul", noul: "0.9" } },
      { reason_0: { type: "noul", noul: 1.4 } },
      { reason_0: { type: "noul", noul: Number.NaN } },
    ]) {
      const judge = client(async () => json({ answers }));
      await expect(judge.ask(REQUEST)).rejects.toMatchObject({ kind: "contract" });
    }
  });

  it("refuses a body with no answers at all", async () => {
    const judge = client(async () => json({ model: "jev-latest" }));
    await expect(judge.ask(REQUEST)).rejects.toBeInstanceOf(JudgeError);
  });

  it("reports a service it could not reach as transport rather than as an answer", async () => {
    const judge = client(async () => {
      throw new Error("getaddrinfo ENOTFOUND judge.example");
    });
    await expect(judge.ask(REQUEST)).rejects.toMatchObject({ kind: "transport" });
  });

  it("gives up on a service that never answers", async () => {
    const judge = client((_url, init) =>
      new Promise((_resolve, reject) => {
        (init as RequestInit).signal?.addEventListener("abort", () => reject(new Error("aborted")));
      }), 10);
    await expect(judge.ask(REQUEST)).rejects.toMatchObject({ kind: "transport" });
  });
});
