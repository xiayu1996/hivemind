/**
 * The second model path, outside pi.
 *
 * Everything pi runs writes text that we then have to parse; this one returns
 * typed judgements and nothing else, which is why it is worth a separate
 * client rather than another purpose on the failover chain. It is deliberately
 * thin: one endpoint, one request shape, no retries, no streaming. The rules
 * that keep it safe live at the call sites, not here -- every question asked
 * through it must already have a deterministic answer that holds when this
 * service is unreachable, and the judgement may only move a case off that
 * answer in the direction the call site declared safe.
 *
 * Nothing here logs the key, and callers are expected to swallow `JudgeError`:
 * a judge that is down has to cost the caller its opinion, never its round.
 */

/** A yes/no question. `criteria` is where the boundary cases are spelled out;
 * the model answers the words it is given rather than the intent behind them. */
export interface NoulQuestion {
  type: "noul";
  instructions: string;
  criteria?: { true: string; false: string };
}

export interface SystemOneRequest {
  model: string;
  /** Only what the questions need. Unrelated context reads as a distractor. */
  state: unknown;
  questions: Readonly<Record<string, NoulQuestion>>;
}

/** The probability the answer is yes, 0 to 1. There is no separate confidence
 * field: a value near 0.5 is the model saying the two outcomes are as likely,
 * not that it is half sure. */
export interface NoulAnswer {
  type: "noul";
  noul: number;
}

export interface SystemOneResponse {
  answers: Readonly<Record<string, NoulAnswer>>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export interface SystemOne {
  ask(request: SystemOneRequest): Promise<SystemOneResponse>;
}

export class JudgeError extends Error {
  constructor(message: string, readonly kind: "auth" | "rate_limit" | "transport" | "contract" | "server") {
    super(message);
    this.name = "JudgeError";
  }
}

export interface HttpSystemOneOptions {
  endpoint: string;
  apiKey: string;
  timeoutMs: number;
  /** Injected so the request shape can be asserted without a network. */
  fetch?: typeof globalThis.fetch;
}

function classify(status: number): JudgeError["kind"] {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
  return "server";
}

/**
 * Parsed rather than cast: a shape change reads as `contract` and the caller
 * falls back, instead of a `noul` of `undefined` silently comparing false
 * against every threshold and quietly disabling the judgement.
 */
function parseResponse(body: unknown): SystemOneResponse {
  if (typeof body !== "object" || body === null) throw new JudgeError("the judge returned no object", "contract");
  const answers = (body as { answers?: unknown }).answers;
  if (typeof answers !== "object" || answers === null) throw new JudgeError("the judge returned no answers", "contract");
  const parsed: Record<string, NoulAnswer> = {};
  for (const [id, answer] of Object.entries(answers as Record<string, unknown>)) {
    const value = (answer as { noul?: unknown }).noul;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new JudgeError(`the judge answered ${id} with something that is not a probability`, "contract");
    }
    parsed[id] = { type: "noul", noul: value };
  }
  return { answers: parsed };
}

export class HttpSystemOne implements SystemOne {
  private readonly call: typeof globalThis.fetch;

  constructor(private readonly options: HttpSystemOneOptions) {
    this.call = options.fetch ?? globalThis.fetch;
  }

  async ask(request: SystemOneRequest): Promise<SystemOneResponse> {
    const abort = AbortSignal.timeout(this.options.timeoutMs);
    let response: Response;
    try {
      response = await this.call(this.options.endpoint, {
        method: "POST",
        headers: {
          // The key appears here and nowhere else: no log line, no error text,
          // no retry wrapper that would carry the headers into a report.
          authorization: `Bearer ${this.options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(request),
        signal: abort,
      });
    } catch (error) {
      throw new JudgeError(`the judge could not be reached: ${(error as Error).message}`, "transport");
    }
    if (!response.ok) {
      throw new JudgeError(`the judge refused the request with ${response.status}`, classify(response.status));
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new JudgeError(`the judge returned unreadable JSON: ${(error as Error).message}`, "contract");
    }
    return parseResponse(body);
  }
}
