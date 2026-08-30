import type { CanonicalEvent } from "../canonical-log.js";
import type { ProjectionCache, ProjectionDefinition } from "./types.js";

interface UnitState {
  definition: ProjectionDefinition<string, unknown, unknown>;
  state: unknown;
}

export class ProjectionRegistry {
  readonly #units = new Map<string, UnitState>();
  #seq = -1;

  constructor(
    private readonly runId: string,
    definitions: readonly ProjectionDefinition<string, never, unknown>[],
    private readonly cache?: ProjectionCache,
  ) {
    for (const definition of definitions) {
      if (this.#units.has(definition.key)) throw new Error(`duplicate projection key: ${definition.key}`);
      const widened = definition as ProjectionDefinition<string, unknown, unknown>;
      this.#units.set(definition.key, { definition: widened, state: widened.init() });
    }
  }

  /** Call only after the canonical event has been durably appended. */
  async applyCommitted(event: CanonicalEvent): Promise<void> {
    if (event.seq <= this.#seq) throw new Error(`projection received non-monotonic seq ${event.seq}`);
    this.#seq = event.seq;
    for (const unit of this.#units.values()) {
      const next = unit.definition.apply(unit.state, event);
      if (next === unit.state) continue;
      unit.state = next;
      if (this.cache) {
        await this.cache.put({
          runId: this.runId,
          key: unit.definition.key,
          version: unit.definition.stateVersion,
          seq: event.seq,
          value: unit.definition.view(next),
        }).catch(() => undefined);
      }
    }
  }

  view<T>(key: string): T {
    const unit = this.#units.get(key);
    if (!unit) throw new Error(`unknown projection key: ${key}`);
    return unit.definition.view(unit.state) as T;
  }

  async rebuild(events: readonly CanonicalEvent[]): Promise<void> {
    for (const event of events) await this.applyCommitted(event);
  }
}
