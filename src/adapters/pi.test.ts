import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type FauxProviderHandle } from "@earendil-works/pi-ai";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { runAgent, type AgentTask, type RunLog } from "../agents/run.ts";
import type { ModelChoice, SessionRequest } from "../ports.ts";
import { DEFAULT_BREAKER_POLICY, type ProviderHealth } from "../resilience/breaker.ts";
import type { FinishedRun, NewRun } from "../store/store.ts";
import { createPiSessions, type PiSessionsOptions } from "./pi.ts";

let workspace: string;
let primary: FauxProviderHandle;
let fallback: FauxProviderHandle;
let health: Map<string, ProviderHealth>;
let runs: Map<string, NewRun & Partial<FinishedRun>>;

const log: RunLog = {
  async startRun(run) {
    runs.set(run.id, { ...run });
  },
  async finishRun(id, result) {
    runs.set(id, { ...runs.get(id)!, ...result });
  },
};

const candidates: ModelChoice[] = [
  { provider: "primary", model: "fast", effort: "medium" },
  { provider: "fallback", model: "steady", effort: "medium" },
];

function options(): PiSessionsOptions {
  const models = createModels();
  models.setProvider(primary.provider);
  models.setProvider(fallback.provider);
  return {
    models,
    providers: { primary: { billing: "subscription" }, fallback: { billing: "metered" } },
    secrets: new Map(),
    health: {
      async providerHealth() {
        return new Map(health);
      },
      async putProviderHealth(record) {
        health.set(record.provider, record);
      },
    },
    breaker: DEFAULT_BREAKER_POLICY,
    retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 1 },
    sleep: async () => {},
  };
}

function session(overrides: Partial<Omit<SessionRequest, "runId">> = {}): Omit<SessionRequest, "runId"> {
  return {
    role: "builder",
    cwd: workspace,
    candidates,
    systemPrompt: "You build things.",
    builtinTools: ["read", "write"],
    tools: [],
    policy: { allowedTools: ["read", "write", "submit_result"], root: workspace, writable: ["src/**"], fenced: [".hivemind/**"] },
    env: { PATH: process.env.PATH ?? "" },
    maxTurns: 20,
    timeoutMs: 30_000,
    ...overrides,
  };
}

const resultSchema = z.object({ summary: z.string().min(1) }).strict();

function task(overrides: Partial<AgentTask<z.infer<typeof resultSchema>>> = {}): AgentTask<z.infer<typeof resultSchema>> {
  return {
    requirementId: "R1",
    itemId: "item",
    step: "build",
    session: session(),
    task: "Write src/hello.ts, then submit.",
    result: { schema: resultSchema, description: "Submit what you did." },
    maxHandbacks: 2,
    ...overrides,
  };
}

function deps() {
  let counter = 0;
  return { sessions: createPiSessions(options()), log, billing: () => "subscription" as const, newId: () => `run-${(counter += 1)}` };
}

const submit = (summary: unknown) => fauxAssistantMessage(fauxToolCall("submit_result", { summary } as never), { stopReason: "toolUse" });

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "hivemind-pi-"));
  primary = fauxProvider({ provider: "primary", models: [{ id: "fast", reasoning: true }] });
  fallback = fauxProvider({ provider: "fallback", models: [{ id: "steady" }] });
  health = new Map();
  runs = new Map();
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("pi sessions", () => {
  it("runs tools in the workspace and returns the submitted result with its usage", async () => {
    primary.setResponses([
      fauxAssistantMessage(fauxToolCall("write", { path: "src/hello.ts", content: "export const hello = 1;\n" }), { stopReason: "toolUse" }),
      submit("wrote hello"),
    ]);
    const run = await runAgent(deps(), task());
    expect(run).toMatchObject({ ok: true, value: { summary: "wrote hello" } });
    expect(await readFile(join(workspace, "src/hello.ts"), "utf8")).toBe("export const hello = 1;\n");
    const record = runs.get("run-1");
    expect(record).toMatchObject({ outcome: "submitted", provider: "primary", model: "fast", turns: 2 });
    expect(record?.promptSha256).toHaveLength(64);
    expect(primary.getPendingResponseCount()).toBe(0);
  });

  it("refuses a write outside the session's paths and lets the model carry on", async () => {
    primary.setResponses([
      fauxAssistantMessage(fauxToolCall("write", { path: ".hivemind/plan.yaml", content: "x" }), { stopReason: "toolUse" }),
      (context) => {
        const refusal = JSON.stringify(context.messages.at(-1));
        return submit(refusal.includes("cannot write") ? "refused as expected" : "not refused");
      },
    ]);
    const run = await runAgent(deps(), task());
    expect(run).toMatchObject({ ok: true, value: { summary: "refused as expected" } });
  });

  it("retries a transient failure on the same model", async () => {
    primary.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 Service Unavailable: upstream connect error" }), submit("after retry")]);
    const run = await runAgent(deps(), task());
    expect(run).toMatchObject({ ok: true, value: { summary: "after retry" } });
    expect(runs.get("run-1")?.provider).toBe("primary");
  });

  it("hands a spent quota over to the next provider within the same session", async () => {
    primary.setResponses([
      fauxAssistantMessage(fauxToolCall("write", { path: "src/a.ts", content: "a\n" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 You exceeded your current quota, please check your plan and billing details." }),
    ]);
    fallback.setResponses([
      (context) => {
        const sawEarlierWork = JSON.stringify(context.messages).includes("src/a.ts");
        return submit(sawEarlierWork ? "continued the same transcript" : "started over");
      },
    ]);
    const run = await runAgent(deps(), task());
    expect(run).toMatchObject({ ok: true, value: { summary: "continued the same transcript" } });
    expect(runs.get("run-1")).toMatchObject({ provider: "fallback", model: "steady" });
    expect(health.get("primary")?.state).toBe("open");
    expect(health.get("primary")?.lastErrorClass).toBe("QUOTA");
  });

  it("does not open a session on a provider whose breaker is open", async () => {
    health.set("primary", { provider: "primary", state: "open", consecutiveFailures: 1, openedAt: Date.now(), retryAt: Date.now() + 60_000, needsHuman: false, lastErrorClass: "QUOTA", lastError: "quota", updatedAt: Date.now() });
    fallback.setResponses([submit("served by fallback")]);
    const run = await runAgent(deps(), task());
    expect(run).toMatchObject({ ok: true, value: { summary: "served by fallback" } });
    expect(primary.state.callCount).toBe(0);
  });

  it("reports when no model can serve and when one can again", async () => {
    const retryAt = Date.now() + 60_000;
    for (const provider of ["primary", "fallback"]) {
      health.set(provider, { provider, state: "open", consecutiveFailures: 1, openedAt: Date.now(), retryAt, needsHuman: false, lastErrorClass: "RATE_LIMIT", lastError: "slow down", updatedAt: Date.now() });
    }
    const run = await runAgent(deps(), task());
    expect(run).toMatchObject({ ok: false, reason: "unavailable", retryAt });
  });

  it("hands check findings back into the same session", async () => {
    primary.setResponses([
      submit("first try"),
      (context) => submit(JSON.stringify(context.messages.at(-1)).includes("mention the test") ? "second try, with the test" : "ignored the finding"),
    ]);
    const run = await runAgent(
      deps(),
      task({ check: (value) => (value.summary.includes("test") ? [] : ["mention the test you wrote"]) }),
    );
    expect(run).toMatchObject({ ok: true, value: { summary: "second try, with the test" } });
    expect(primary.state.callCount).toBe(2);
  });

  it("returns a malformed result to the model as a tool error", async () => {
    primary.setResponses([
      submit(""),
      (context) => {
        const last = context.messages.at(-1);
        return submit(last?.role === "toolResult" && last.isError ? "fixed" : "unseen");
      },
    ]);
    const run = await runAgent(deps(), task());
    expect(run).toMatchObject({ ok: true, value: { summary: "fixed" } });
  });

  it("nudges a session that stopped without submitting, once", async () => {
    primary.setResponses([fauxAssistantMessage(fauxText("I am done.")), submit("submitted after the nudge")]);
    expect(await runAgent(deps(), task())).toMatchObject({ ok: true, value: { summary: "submitted after the nudge" } });

    primary.setResponses([fauxAssistantMessage(fauxText("done")), fauxAssistantMessage(fauxText("still done"))]);
    expect(await runAgent(deps(), task())).toMatchObject({ ok: false, reason: "no_result" });
  });

  it("stops a session at its turn limit", async () => {
    primary.setResponses(Array.from({ length: 5 }, () => fauxAssistantMessage(fauxToolCall("read", { path: "missing.txt" }), { stopReason: "toolUse" })));
    const run = await runAgent(deps(), task({ session: session({ maxTurns: 3 }) }));
    expect(run).toMatchObject({ ok: false, reason: "turn_limit" });
    expect(runs.get("run-1")?.turns).toBe(3);
  });
});
