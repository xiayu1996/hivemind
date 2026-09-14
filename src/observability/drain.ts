import type { EventBuffer, EventEnvelope } from "./event-buffer.js";

/**
 * Ring 1: takes what ring 0 buffered and writes it somewhere.
 *
 * It depends on ring 0 and nothing depends on it, which is what makes it
 * killable: stop this loop and every card keeps running, with the buffer
 * filling and eventually dropping its oldest events. A sink that throws is
 * counted and skipped -- one broken sink must not stop the others, and neither
 * may stop the loop.
 */

export interface EventSink {
  readonly name: string;
  deliver(events: readonly EventEnvelope[]): Promise<void>;
}

export interface DrainOptions {
  intervalMs?: number;
  /** Events handed to the sinks per tick. */
  batchSize?: number;
  sleep?: (ms: number) => Promise<void>;
  onSinkFailure?: (sink: string, error: unknown) => void;
}

const DEFAULT_INTERVAL_MS = 250;
const DEFAULT_BATCH = 256;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

export class DrainLoop {
  private running = false;
  private loop: Promise<void> | null = null;
  private failureCount = 0;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly buffer: EventBuffer,
    private readonly sinks: readonly EventSink[],
    private readonly options: DrainOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.batchSize = options.batchSize ?? DEFAULT_BATCH;
    this.sleep = options.sleep ?? delay;
  }

  /** One pass. Returns how many events were handed to the sinks. */
  async tick(): Promise<number> {
    const events = this.buffer.drain(this.batchSize);
    if (events.length === 0) return 0;
    for (const sink of this.sinks) {
      try {
        await sink.deliver(events);
      } catch (error) {
        this.failureCount += 1;
        this.options.onSinkFailure?.(sink.name, error);
      }
    }
    return events.length;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = (async () => {
      while (this.running) {
        const delivered = await this.tick();
        if (delivered === 0) await this.sleep(this.intervalMs);
      }
    })();
  }

  /** Stops the loop and makes one last pass, so a process that is shutting down
   * does not take the last few events with it. */
  async stop(): Promise<void> {
    this.running = false;
    await this.loop?.catch(() => undefined);
    this.loop = null;
    while (await this.tick() > 0) { /* drain what is left */ }
  }

  /** Deliveries that threw. Never surfaced to the delivery path. */
  get failures(): number {
    return this.failureCount;
  }
}
