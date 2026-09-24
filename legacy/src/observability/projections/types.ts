import type { CanonicalEvent } from "../canonical-log.js";

export interface ProjectionDefinition<K extends string, S, V = S> {
  key: K;
  stateVersion: number;
  init(): S;
  apply(state: S, event: CanonicalEvent): S;
  view(state: S): V;
}

export interface ProjectionCacheRecord {
  runId: string;
  key: string;
  version: number;
  seq: number;
  value: unknown;
}

export interface ProjectionCache {
  put(record: ProjectionCacheRecord): Promise<void>;
}
