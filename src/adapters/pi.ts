import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { clampThinkingLevel, isContextOverflow, isRetryableAssistantError, retryDelayMs, type Api, type AssistantMessage, type Model, type Models, type TSchema } from "@earendil-works/pi-ai";
import { createBashTool, createEditTool, createFindTool, createGrepTool, createLsTool, createReadTool, createWriteTool, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ModelsFile } from "../agents/models.ts";
import { decideToolCall } from "../gates/tool-guard.ts";
import type { AgentSession, AgentSessions, BuiltinTool, ModelChoice, OpenedSession, SessionOutcome, SessionRequest, SessionUsage, ToolSpec } from "../ports.ts";
import { closedHealth, earliestRetryAt, onProviderFailure, onProviderSuccess, usableProviders, type BreakerPolicy, type ProviderHealth } from "../resilience/breaker.ts";
import { classifyError } from "../resilience/classify.ts";

/**
 * The only module that knows pi. Sessions run in this process on the pi
 * agent SDK; there is no child process, no RPC framing and no session file to
 * pin, so a crashed session is simply started again from the same inputs.
 */

/**
 * The model runtime: pi's built-in providers and catalogue, credentials from
 * pi's auth file (OAuth subscriptions are refreshed there, under pi's own
 * lock), and the providers `config/models.yaml` declares itself. pi's own
 * models.json is not read: what this service may run on is its own file.
 */
export async function createModelRuntime(options: { authPath: string; models: ModelsFile }): Promise<ModelRuntime> {
  const runtime = await ModelRuntime.create({ authPath: options.authPath, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  for (const [providerId, provider] of Object.entries(options.models.providers)) {
    if (provider.declaration === undefined) continue;
    runtime.registerProvider(providerId, {
      name: providerId,
      baseUrl: provider.declaration.baseUrl,
      api: provider.declaration.api,
      apiKey: `$${provider.apiKeyEnv ?? ""}`,
      models: provider.declaration.models,
    });
  }
  return runtime;
}

export interface HealthStore {
  providerHealth(): Promise<Map<string, ProviderHealth>>;
  putProviderHealth(health: ProviderHealth): Promise<void>;
}

export interface RetrySettings {
  /** Transient failures retried on the same model before it is given up on for the session. */
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY: RetrySettings = { maxRetries: 4, baseDelayMs: 2_000, maxDelayMs: 60_000 };

export interface PiSessionsOptions {
  models: Models;
  providers: ModelsFile["providers"];
  /** Credentials by name. They reach a provider request and nothing else: not process.env, not a tool. */
  secrets: ReadonlyMap<string, string>;
  health: HealthStore;
  breaker: BreakerPolicy;
  retry?: RetrySettings;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export function createPiSessions(options: PiSessionsOptions): AgentSessions {
  return {
    async open(request: SessionRequest): Promise<OpenedSession> {
      const at = (options.now ?? Date.now)();
      const health = await options.health.providerHealth();
      const providers = [...new Set(request.candidates.map((candidate) => candidate.provider))];
      const usable = new Set(usableProviders(providers, health, at));
      const queue = request.candidates.filter((candidate) => usable.has(candidate.provider) && options.models.getModel(candidate.provider, candidate.model) !== undefined);
      if (queue.length === 0) {
        return { ok: false, reason: `no model for the ${request.role} is usable now (${providers.join(", ")})`, retryAt: earliestRetryAt(providers, health) };
      }
      return { ok: true, session: new PiSession(options, request, queue) };
    },
  };
}

const BUILTIN_ORDER: readonly BuiltinTool[] = ["read", "bash", "edit", "write", "grep", "find", "ls"];

const EMPTY_USAGE: SessionUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, turns: 0 };

class PiSession implements AgentSession {
  readonly #options: PiSessionsOptions;
  readonly #request: SessionRequest;
  readonly #queue: ModelChoice[];
  readonly #agent: Agent;
  #current: ModelChoice;
  #usage: SessionUsage = { ...EMPTY_USAGE };
  #endRequested = false;
  #deadline: number | null = null;
  #unsubscribe: () => void;

  constructor(options: PiSessionsOptions, request: SessionRequest, queue: ModelChoice[]) {
    this.#options = options;
    this.#request = request;
    const [first, ...rest] = queue;
    if (first === undefined) throw new Error("a session needs at least one model");
    this.#current = first;
    this.#queue = rest;
    const model = this.#model(first);
    this.#agent = new Agent({
      initialState: {
        systemPrompt: request.systemPrompt,
        model,
        thinkingLevel: this.#thinking(model, first),
        tools: buildTools(request, () => {
          this.#endRequested = true;
        }),
      },
      // Every request carries the credentials and the long cache retention; the agent adds the session id.
      streamFn: (streamModel, context, streamOptions) =>
        options.models.streamSimple(streamModel, context, { ...streamOptions, ...this.#credentials(streamModel.provider), cacheRetention: "long" }),
      sessionId: request.runId,
      beforeToolCall: async ({ toolCall, args }) => {
        const decision = decideToolCall(request.policy, { name: toolCall.name, args: isRecord(args) ? args : {} });
        return decision.allow ? undefined : { block: true, reason: decision.reason };
      },
      finishTurn: () => (this.#endRequested || this.#usage.turns >= request.maxTurns ? { action: "end" } : undefined),
    });
    this.#unsubscribe = this.#agent.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "assistant") this.#count(event.message);
    });
  }

  get model(): ModelChoice {
    return this.#current;
  }

  usage(): SessionUsage {
    return { ...this.#usage };
  }

  close(): void {
    this.#agent.abort();
    this.#unsubscribe();
  }

  async send(message: string): Promise<SessionOutcome> {
    const now = this.#options.now ?? Date.now;
    this.#deadline ??= now() + this.#request.timeoutMs;
    const remaining = this.#deadline - now();
    if (remaining <= 0) return { kind: "timeout" };
    this.#endRequested = false;
    const deadline = new AbortController();
    const timer = setTimeout(() => {
      deadline.abort();
      this.#agent.abort();
    }, remaining);
    try {
      let retries = 0;
      let first = true;
      for (;;) {
        if (first) await this.#agent.prompt(message);
        else await this.#agent.continue();
        first = false;
        if (deadline.signal.aborted) return { kind: "timeout" };
        if (this.#endRequested) {
          await this.#succeeded();
          return { kind: "ended" };
        }
        const last = this.#agent.state.messages.at(-1);
        if (last?.role !== "assistant" || last.stopReason !== "error") {
          await this.#succeeded();
          if (this.#usage.turns >= this.#request.maxTurns) return { kind: "turn_limit" };
          return { kind: "stopped", text: last?.role === "assistant" ? textOf(last) : "" };
        }
        // Drop the failed reply so the transcript ends on the message that asked for it again.
        this.#agent.state.messages = this.#agent.state.messages.slice(0, -1);
        const errorMessage = last.errorMessage ?? "the provider returned an error without a message";
        // A transcript too long for the model is this session's problem, not the provider's: no retry, no breaker.
        if (isContextOverflow(last, this.#agent.state.model.contextWindow)) {
          return { kind: "error", errorClass: "CONTEXT_OVERFLOW", message: errorMessage, needsHuman: false };
        }
        const classification = classifyError(errorMessage);
        const retry = this.#options.retry ?? DEFAULT_RETRY;
        if ((classification.retryable || isRetryableAssistantError(last)) && retries < retry.maxRetries) {
          retries += 1;
          await (this.#options.sleep ?? sleep)(retryDelayMs({ baseDelayMs: retry.baseDelayMs, maxAgentDelayMs: retry.maxDelayMs }, retries), deadline.signal);
          if (deadline.signal.aborted) return { kind: "timeout" };
          continue;
        }
        await this.#failed(errorMessage);
        const next = this.#nextCandidate();
        if (next === undefined) return { kind: "error", errorClass: classification.class, message: errorMessage, needsHuman: classification.needsHuman };
        this.#switchTo(next);
        retries = 0;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  #model(choice: ModelChoice): Model<Api> {
    const model = this.#options.models.getModel(choice.provider, choice.model);
    if (model === undefined) throw new Error(`model ${choice.provider}/${choice.model} is not known to the model runtime`);
    return model;
  }

  #thinking(model: Model<Api>, choice: ModelChoice) {
    return model.reasoning ? clampThinkingLevel(model, choice.effort) : "off";
  }

  #credentials(provider: string): { env: Record<string, string>; apiKey?: string } {
    const env = Object.fromEntries(this.#options.secrets);
    const keyName = this.#options.providers[provider]?.apiKeyEnv;
    const apiKey = keyName === undefined ? undefined : this.#options.secrets.get(keyName);
    return apiKey === undefined ? { env } : { env, apiKey };
  }

  #count(message: AssistantMessage): void {
    const usage = message.usage;
    this.#usage.inputTokens += usage.input;
    this.#usage.outputTokens += usage.output;
    this.#usage.cacheReadTokens += usage.cacheRead;
    this.#usage.cacheWriteTokens += usage.cacheWrite;
    this.#usage.costUsd += usage.cost.total;
    if (message.stopReason !== "error" && message.stopReason !== "aborted") this.#usage.turns += 1;
  }

  /** The next candidate on another provider: the one that just failed has had its chance in this session. */
  #nextCandidate(): ModelChoice | undefined {
    const failed = this.#current.provider;
    while (this.#queue.length > 0) {
      const next = this.#queue.shift();
      if (next !== undefined && next.provider !== failed) return next;
    }
    return undefined;
  }

  #switchTo(choice: ModelChoice): void {
    const model = this.#model(choice);
    this.#current = choice;
    this.#agent.state.model = model;
    this.#agent.state.thinkingLevel = this.#thinking(model, choice);
  }

  async #succeeded(): Promise<void> {
    const health = (await this.#options.health.providerHealth()).get(this.#current.provider);
    if (health !== undefined && health.state !== "closed") await this.#options.health.putProviderHealth(onProviderSuccess(health, (this.#options.now ?? Date.now)()));
  }

  async #failed(errorMessage: string): Promise<void> {
    const at = (this.#options.now ?? Date.now)();
    const provider = this.#current.provider;
    const current = (await this.#options.health.providerHealth()).get(provider) ?? closedHealth(provider, at);
    await this.#options.health.putProviderHealth(onProviderFailure(current, { at, errorMessage, policy: this.#options.breaker }));
  }
}

function builtinTool(name: BuiltinTool, request: SessionRequest): AgentTool {
  switch (name) {
    case "read":
      return createReadTool(request.cwd);
    case "bash":
      // Commands see only the environment the request gives them: never this process's, never pi's session variables.
      return createBashTool(request.cwd, { spawnHook: (context) => ({ ...context, env: { ...request.env } }), exposeSessionEnvironment: false });
    case "edit":
      return createEditTool(request.cwd);
    case "write":
      return createWriteTool(request.cwd);
    case "grep":
      return createGrepTool(request.cwd);
    case "find":
      return createFindTool(request.cwd);
    case "ls":
      return createLsTool(request.cwd);
  }
}

function buildTools(request: SessionRequest, onEnd: () => void): AgentTool[] {
  const tools: AgentTool[] = BUILTIN_ORDER.filter((name) => request.builtinTools.includes(name)).map((name) => builtinTool(name, request));
  // A stable order keeps the tool declarations, and with them the cached prefix, identical between sessions.
  const custom = [...request.tools].toSorted((left, right) => (left.name < right.name ? -1 : 1));
  for (const spec of custom) tools.push(toAgentTool(spec, onEnd));
  return tools;
}

function toAgentTool(spec: ToolSpec, onEnd: () => void): AgentTool {
  return {
    name: spec.name,
    label: spec.name,
    description: spec.description,
    parameters: spec.parameters as unknown as TSchema,
    execute: async (_toolCallId, params, signal) => {
      const output = await spec.execute(params, signal);
      if (output.endsSession === true) onEnd();
      const images = (output.images ?? []).map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType }));
      return { content: [{ type: "text" as const, text: output.text }, ...images], details: undefined };
    },
  };
}

function textOf(message: AssistantMessage): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
