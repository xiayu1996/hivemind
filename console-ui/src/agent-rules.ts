import type {
  AgentRulesView,
  SaveAgentRulesRequest,
  SaveAgentRulesResponse,
} from "../../src/console/agent-rules.js";

export interface AgentRulesPageState {
  status: "loading" | "ready" | "saving" | "saved" | "rejected";
  persisted: AgentRulesView | null;
  draft: SaveAgentRulesRequest | null;
  message: string;
  fieldErrors: Partial<Record<"defaultProvider" | "defaultModel" | "providerStates" | "failoverOrder", string>>;
}

/** Browser transport for the dedicated aggregate endpoint. */
export interface AgentRulesApi {
  load(): Promise<AgentRulesView>;
  save(request: SaveAgentRulesRequest): Promise<SaveAgentRulesResponse>;
}

/** Owns one page draft. A rejected response restores no server fields, keeps the
 * draft visible for correction, and renders the server's exact message. */
export interface AgentRulesPageController {
  readonly state: Readonly<AgentRulesPageState>;
  open(): Promise<void>;
  selectDefaultProvider(provider: string): void;
  selectDefaultModel(model: string): void;
  setProviderState(provider: string, state: "enabled" | "disabled"): void;
  reorderProviders(order: readonly string[]): void;
  save(updatedBy: string): Promise<void>;
}

export declare function createAgentRulesPageController(api: AgentRulesApi): AgentRulesPageController;
