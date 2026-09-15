/**
 * Ring 0: the only place the delivery path touches observation.
 *
 * `emit` is synchronous, does no I/O and never throws. Everything a person or
 * a projection later wants to see is written by ring 1, out of the way, so a
 * slow disk, a full disk or a broken sink cannot stall a card. That is not a
 * quality of the implementation to be preserved by care -- the rule is that no
 * `await` on an observability call may appear in the delivery path at all, and
 * the way to check it is to replace `emit` with an empty function and see that
 * the pipeline still type-checks and behaves the same.
 *
 * The buffer is bounded and drops the oldest event when it is full, counting
 * what it dropped. Dropping is the design: blocking the emitter to avoid a drop
 * is exactly the back pressure this ring exists to prevent, and the count is
 * what tells a reader their window is incomplete.
 */

export interface EventEnvelope<T = unknown> {
  type: string;
  at: number;
  /** Lets a projection state the range it understands and count, rather than
   * reject, what it does not. A projection that refuses an unknown version
   * cannot be rebuilt after the emitter moves on. */
  schemaVersion: number;
  data: T;
}

export interface EventBufferOptions {
  /** Events held before the oldest is dropped. */
  capacity?: number;
  now?: () => number;
}

const DEFAULT_CAPACITY = 4096;

export class EventBuffer {
  private readonly events: EventEnvelope[] = [];
  private readonly capacity: number;
  private readonly now: () => number;
  private droppedCount = 0;

  constructor(options: EventBufferOptions = {}) {
    this.capacity = options.capacity ?? DEFAULT_CAPACITY;
    this.now = options.now ?? Date.now;
  }

  /** Never throws: a caller that has to guard an emit would be paying for the
   * observation it was promised it could ignore. */
  emit(type: string, data: unknown, schemaVersion = 1): void {
    try {
      if (this.events.length >= this.capacity) {
        this.events.shift();
        this.droppedCount += 1;
      }
      this.events.push({ type, at: this.now(), schemaVersion, data });
    } catch {
      // A buffer that cannot take an event has nothing useful to report to a
      // caller whose job is somewhere else entirely; the count below is the
      // only honest signal and it is already lost in this case.
    }
  }

  /** Takes up to `max` events out of the buffer, oldest first. */
  drain(max = Number.POSITIVE_INFINITY): EventEnvelope[] {
    if (this.events.length === 0) return [];
    const count = Math.min(this.events.length, max);
    return this.events.splice(0, count);
  }

  get size(): number {
    return this.events.length;
  }

  /** Events the buffer threw away because nobody drained it fast enough. */
  get dropped(): number {
    return this.droppedCount;
  }
}
