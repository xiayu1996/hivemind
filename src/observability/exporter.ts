import { appendFile, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { CanonicalEvent } from "./canonical-log.js";
import { redactForExport } from "./redact.js";

export interface ExportEnvelope {
  runId: string;
  event: CanonicalEvent;
}

export interface TelemetrySink {
  send(batch: readonly ExportEnvelope[]): Promise<void>;
}

export interface TelemetrySpool {
  append(batch: readonly ExportEnvelope[]): Promise<void>;
  readAfter(cursor: number, limit: number): Promise<Array<{ offset: number; envelope: ExportEnvelope }>>;
  getCursor(sink: string): Promise<number>;
  setCursor(sink: string, cursor: number): Promise<void>;
}

/** Capture-side boundary: synchronous memory enqueue only, with no I/O or awaits. */
export class TelemetryEmitter {
  #queue: ExportEnvelope[] = [];

  emit(envelope: ExportEnvelope): void {
    this.#queue.push(envelope);
  }

  take(limit = this.#queue.length): ExportEnvelope[] {
    return this.#queue.splice(0, limit);
  }

  get depth(): number {
    return this.#queue.length;
  }
}

export class JsonlTelemetrySpool implements TelemetrySpool {
  readonly #path: string;
  readonly #cursorDirectory: string;

  constructor(path: string, cursorDirectory = resolve(dirname(path), "cursors")) {
    this.#path = path;
    this.#cursorDirectory = cursorDirectory;
  }

  async append(batch: readonly ExportEnvelope[]): Promise<void> {
    if (batch.length === 0) return;
    await appendFile(this.#path, batch.map((item) => JSON.stringify(item)).join("\n") + "\n", "utf8");
  }

  async readAfter(cursor: number, limit: number): Promise<Array<{ offset: number; envelope: ExportEnvelope }>> {
    const raw = await readFile(this.#path, "utf8").catch((cause: NodeJS.ErrnoException) => {
      if (cause.code === "ENOENT") return "";
      throw cause;
    });
    return raw.split("\n")
      .filter(Boolean)
      .map((line, offset) => ({ offset, envelope: JSON.parse(line) as ExportEnvelope }))
      .filter((item) => item.offset > cursor)
      .slice(0, limit);
  }

  async getCursor(sink: string): Promise<number> {
    const path = this.#cursorPath(sink);
    const raw = await readFile(path, "utf8").catch((cause: NodeJS.ErrnoException) => {
      if (cause.code === "ENOENT") return "-1";
      throw cause;
    });
    const cursor = Number(raw);
    if (!Number.isInteger(cursor) || cursor < -1) throw new Error(`invalid telemetry cursor for ${sink}`);
    return cursor;
  }

  async setCursor(sink: string, cursor: number): Promise<void> {
    await import("node:fs/promises").then(({ mkdir }) => mkdir(this.#cursorDirectory, { recursive: true }));
    const path = this.#cursorPath(sink);
    const temporary = `${path}.tmp-${process.pid}`;
    await writeFile(temporary, String(cursor), "utf8");
    await rename(temporary, path);
  }

  #cursorPath(sink: string): string {
    if (!/^[A-Za-z0-9._-]+$/.test(sink)) throw new Error("sink name is not a safe path segment");
    return resolve(this.#cursorDirectory, `${sink}.cursor`);
  }
}

/** Transport worker: redacts export copies, persists first, then delivers at least once. */
export class TelemetryExportWorker {
  constructor(
    private readonly emitter: TelemetryEmitter,
    private readonly spool: TelemetrySpool,
  ) {}

  async persistCaptured(): Promise<number> {
    const captured = this.emitter.take();
    try {
      const exported = captured.map((item) => redactForExport(item) as ExportEnvelope);
      await this.spool.append(exported);
      return captured.length;
    } catch (cause) {
      for (const item of captured.toReversed()) this.emitter.emit(item);
      throw cause;
    }
  }

  async deliver(sinkName: string, sink: TelemetrySink, batchSize = 100): Promise<number> {
    const cursor = await this.spool.getCursor(sinkName);
    const batch = await this.spool.readAfter(cursor, batchSize);
    if (batch.length === 0) return 0;
    await sink.send(batch.map((item) => item.envelope));
    await this.spool.setCursor(sinkName, batch.at(-1)!.offset);
    return batch.length;
  }
}

/** Orchestrator-side idempotency boundary for at-least-once worker delivery. */
export class DeduplicatingTelemetryReceiver implements TelemetrySink {
  readonly #seen = new Set<string>();

  constructor(private readonly accept: (envelope: ExportEnvelope) => Promise<void>) {}

  async send(batch: readonly ExportEnvelope[]): Promise<void> {
    for (const envelope of batch) {
      const key = `${envelope.runId}:${envelope.event.seq}`;
      if (this.#seen.has(key)) continue;
      await this.accept(envelope);
      this.#seen.add(key);
    }
  }
}
