import type { CanonicalEvent } from "../canonical-log.js";
import type { ProjectionDefinition } from "./types.js";

export interface TokenUsageProjection {
  uncachedInput: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}

export const tokenUsageProjection: ProjectionDefinition<"tokenUsage", TokenUsageProjection> = {
  key: "tokenUsage",
  stateVersion: 1,
  init: () => ({ uncachedInput: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }),
  apply(state, event) {
    if (event.type !== "usage") return state;
    const data = event.data as Partial<TokenUsageProjection>;
    return {
      uncachedInput: state.uncachedInput + (data.uncachedInput ?? 0),
      output: state.output + (data.output ?? 0),
      cacheRead: state.cacheRead + (data.cacheRead ?? 0),
      cacheWrite: state.cacheWrite + (data.cacheWrite ?? 0),
      reasoning: state.reasoning + (data.reasoning ?? 0),
    };
  },
  view: (state) => state,
};

export interface CostProjection { usd: number }

export const costProjection: ProjectionDefinition<"cost", CostProjection> = {
  key: "cost",
  stateVersion: 1,
  init: () => ({ usd: 0 }),
  apply(state, event) {
    if (event.type !== "cost.recorded") return state;
    const cost = Number((event.data as Record<string, unknown>).costUsd ?? 0);
    return { usd: state.usd + (Number.isFinite(cost) ? cost : 0) };
  },
  view: (state) => state,
};

export interface StatsProjection {
  turns: number;
  steps: number;
  llmMs: number;
  toolMs: number;
  ttftMs: number;
  ttftSamples: number;
  stepStartedAt: Record<string, number>;
  firstChunkSeen: Record<string, true>;
  toolStartedAt: Record<string, number>;
}

function coordinates(event: CanonicalEvent): { turn?: number; step?: number; callId?: string; text?: string } {
  return event.data as { turn?: number; step?: number; callId?: string; text?: string };
}

function stepKey(data: { turn?: number; step?: number }): string | null {
  return data.turn === undefined || data.step === undefined ? null : `${data.turn}:${data.step}`;
}

export const statsProjection: ProjectionDefinition<"stats", StatsProjection, Omit<StatsProjection, "stepStartedAt" | "firstChunkSeen" | "toolStartedAt">> = {
  key: "stats",
  stateVersion: 1,
  init: () => ({
    turns: 0,
    steps: 0,
    llmMs: 0,
    toolMs: 0,
    ttftMs: 0,
    ttftSamples: 0,
    stepStartedAt: {},
    firstChunkSeen: {},
    toolStartedAt: {},
  }),
  apply(state, event) {
    const data = coordinates(event);
    const key = stepKey(data);
    if (event.type === "turn_end") return { ...state, turns: state.turns + 1 };
    if (event.type === "step_start" && key) {
      return { ...state, steps: state.steps + 1, stepStartedAt: { ...state.stepStartedAt, [key]: event.time } };
    }
    if (event.type === "assistant/chunk" && key && data.text && !state.firstChunkSeen[key]) {
      const started = state.stepStartedAt[key];
      if (started === undefined) return state;
      return {
        ...state,
        ttftMs: state.ttftMs + event.time - started,
        ttftSamples: state.ttftSamples + 1,
        firstChunkSeen: { ...state.firstChunkSeen, [key]: true },
      };
    }
    if (event.type === "assistant_message" && key) {
      const started = state.stepStartedAt[key];
      if (started === undefined) return state;
      return { ...state, llmMs: state.llmMs + event.time - started };
    }
    if (event.type === "tool_call" && data.callId) {
      return { ...state, toolStartedAt: { ...state.toolStartedAt, [data.callId]: event.time } };
    }
    if (event.type === "tool_result" && data.callId) {
      const started = state.toolStartedAt[data.callId];
      if (started === undefined) return state;
      const toolStartedAt = { ...state.toolStartedAt };
      delete toolStartedAt[data.callId];
      return { ...state, toolMs: state.toolMs + event.time - started, toolStartedAt };
    }
    return state;
  },
  view: ({ turns, steps, llmMs, toolMs, ttftMs, ttftSamples }) => ({ turns, steps, llmMs, toolMs, ttftMs, ttftSamples }),
};

export interface TraceNode {
  type: string;
  time: number;
  turn?: number;
  step?: number;
  callId?: string;
}

export interface TraceProjection { nodes: TraceNode[] }

const TRACE_TYPES = new Set(["turn_start", "turn_end", "step_start", "step_end", "assistant_message", "tool_call", "tool_result"]);

export const traceProjection: ProjectionDefinition<"trace", TraceProjection> = {
  key: "trace",
  stateVersion: 1,
  init: () => ({ nodes: [] }),
  apply(state, event) {
    if (!TRACE_TYPES.has(event.type)) return state;
    const data = coordinates(event);
    return {
      nodes: [...state.nodes, {
        type: event.type,
        time: event.time,
        ...(data.turn === undefined ? {} : { turn: data.turn }),
        ...(data.step === undefined ? {} : { step: data.step }),
        ...(data.callId === undefined ? {} : { callId: data.callId }),
      }],
    };
  },
  view: (state) => state,
};
