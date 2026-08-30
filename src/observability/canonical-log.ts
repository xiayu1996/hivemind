import { appendFile, readFile } from "node:fs/promises";
import { z } from "zod";

export interface CanonicalEvent<T = unknown> {
  type: string;
  seq: number;
  time: number;
  data: T;
  ignorable?: true;
}

export interface ModelRequestHeader {
  systemPrompt: string;
  tools: unknown[];
}

export interface ModelRequestContext {
  provider: string;
  model: string;
  contextWindow: number;
}

export interface RebuiltModelRequest {
  header: ModelRequestHeader;
  context: ModelRequestContext;
  messages: unknown[];
}

const envelopeSchema = z.object({
  type: z.string().min(1),
  seq: z.number().int().nonnegative(),
  time: z.number().int().nonnegative(),
  data: z.unknown(),
  ignorable: z.literal(true).optional(),
}).strict();

const KNOWN_TYPES = new Set([
  "request/header",
  "request/context",
  "request/messages",
  "request/provider-payload",
  "turn_start",
  "turn_end",
  "step_start",
  "step_end",
  "assistant/chunk",
  "assistant_message",
  "tool_call",
  "tool_result",
  "usage",
  "cost.recorded",
  "llm/retry",
  "llm/retry-started",
  "shutdown",
]);

function parseData<T>(event: CanonicalEvent, schema: z.ZodType<T>): T {
  const parsed = schema.safeParse(event.data);
  if (!parsed.success) throw new Error(`${event.type} has invalid data`);
  return parsed.data;
}

/** Reads the authoritative log and refuses unknown required events. */
export function parseCanonicalLog(raw: string): CanonicalEvent[] {
  const events: CanonicalEvent[] = [];
  let previous = -1;
  for (const [index, line] of raw.split("\n").entries()) {
    if (!line) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`canonical log line ${index + 1} is not valid JSON`);
    }
    const parsed = envelopeSchema.safeParse(value);
    if (!parsed.success) throw new Error(`canonical log line ${index + 1} has an invalid envelope`);
    const event = parsed.data as CanonicalEvent;
    if (event.seq <= previous) throw new Error(`canonical log seq ${event.seq} is not monotonic`);
    previous = event.seq;
    if (!KNOWN_TYPES.has(event.type) && event.ignorable !== true) {
      throw new Error(`unknown required canonical event: ${event.type}`);
    }
    events.push(event);
  }
  return events;
}

export async function readCanonicalLog(path: string): Promise<CanonicalEvent[]> {
  return parseCanonicalLog(await readFile(path, "utf8"));
}

/** Serialises appends so each JSON envelope occupies one complete line. */
export class CanonicalLogWriter {
  #nextSeq: number;
  #pending: Promise<void> = Promise.resolve();

  constructor(
    private readonly path: string,
    initialSeq = 0,
    private readonly now: () => number = Date.now,
  ) {
    this.#nextSeq = initialSeq;
  }

  append<T>(type: string, data: T, options: { ignorable?: true } = {}): Promise<CanonicalEvent<T>> {
    const event: CanonicalEvent<T> = {
      type,
      seq: this.#nextSeq++,
      time: this.now(),
      data,
      ...(options.ignorable ? { ignorable: true as const } : {}),
    };
    const line = `${JSON.stringify(event)}\n`;
    const write = this.#pending.then(() => appendFile(this.path, line, "utf8"));
    this.#pending = write;
    return write.then(() => event);
  }

  flush(): Promise<void> {
    return this.#pending;
  }
}

const headerSchema = z.object({ systemPrompt: z.string(), tools: z.array(z.unknown()) }).strict();
const contextSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  contextWindow: z.number().int().positive(),
}).strict();
const messagesSchema = z.object({ messages: z.array(z.unknown()) }).strict();

/** Reconstructs exactly the model-visible fields from one request boundary. */
export function rebuildModelRequest(events: readonly CanonicalEvent[]): RebuiltModelRequest {
  const headerEvent = events.findLast((event) => event.type === "request/header");
  const contextEvent = events.findLast((event) => event.type === "request/context");
  const messagesEvent = events.findLast((event) => event.type === "request/messages");
  if (!headerEvent || !contextEvent || !messagesEvent) throw new Error("canonical log is missing model request fields");
  return {
    header: parseData(headerEvent, headerSchema),
    context: parseData(contextEvent, contextSchema),
    messages: parseData(messagesEvent, messagesSchema).messages,
  };
}

/** Returns the exact provider-serialized request rather than a reconstructed approximation. */
export function rebuildProviderPayload(events: readonly CanonicalEvent[]): unknown {
  const event = events.findLast((candidate) => candidate.type === "request/provider-payload");
  if (!event) throw new Error("canonical log is missing the provider payload");
  return event.data;
}

const coordinateSchema = z.object({ turn: z.number().int().positive(), step: z.number().int().positive().optional() }).passthrough();

/** Validates paired numeric turn/step coordinates in a completed log. */
export function validateCoordinates(events: readonly CanonicalEvent[]): void {
  const turns = new Set<number>();
  const steps = new Set<string>();
  for (const event of events) {
    if (!["turn_start", "turn_end", "step_start", "step_end"].includes(event.type)) continue;
    const coordinate = parseData(event, coordinateSchema);
    if (event.type === "turn_start") {
      if (turns.has(coordinate.turn)) throw new Error(`turn ${coordinate.turn} already open`);
      turns.add(coordinate.turn);
    } else if (event.type === "turn_end") {
      if (!turns.delete(coordinate.turn)) throw new Error(`turn ${coordinate.turn} ended without a start`);
    } else {
      if (coordinate.step === undefined) throw new Error(`${event.type} is missing step`);
      const key = `${coordinate.turn}:${coordinate.step}`;
      if (event.type === "step_start") {
        if (!turns.has(coordinate.turn)) throw new Error(`step ${key} started outside an open turn`);
        if (steps.has(key)) throw new Error(`step ${key} already open`);
        steps.add(key);
      } else if (!steps.delete(key)) {
        throw new Error(`step ${key} ended without a start`);
      }
    }
  }
  if (steps.size > 0) throw new Error(`unclosed steps: ${[...steps].join(",")}`);
  if (turns.size > 0) throw new Error(`unclosed turns: ${[...turns].join(",")}`);
}

/** Recovery alone may synthesise interrupted turn endings after a crash. */
export async function recoverInterruptedTurns(
  writer: CanonicalLogWriter,
  events: readonly CanonicalEvent[],
): Promise<number> {
  const open = new Set<number>();
  for (const event of events) {
    if (event.type !== "turn_start" && event.type !== "turn_end") continue;
    const coordinate = parseData(event, coordinateSchema);
    if (event.type === "turn_start") open.add(coordinate.turn);
    else open.delete(coordinate.turn);
  }
  for (const turn of [...open].toSorted((a, b) => a - b)) {
    await writer.append("turn_end", { turn, reason: "interrupted", synthetic: true });
  }
  return open.size;
}
