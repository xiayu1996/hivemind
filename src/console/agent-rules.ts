import type {
  AgentRules,
  AgentRulesRejection,
  AgentRulesRepository,
  AgentRulesValidationContext,
  ProviderRuleState,
} from "../config/agent-rules.js";

export interface AgentRulesProviderView {
  name: string;
  state: ProviderRuleState;
  stateLabel: "Enabled" | "Disabled";
  /** Model ids from this provider's catalogue only. */
  modelChoices: readonly string[];
}

/** The complete editable page contract. Credentials and transient provider
 * health are intentionally absent rather than redacted editable properties. */
export interface AgentRulesView {
  revision: number;
  defaultProvider: string;
  defaultModel: string;
  providers: readonly AgentRulesProviderView[];
  failoverOrder: readonly string[];
}

export interface SaveAgentRulesRequest {
  revision: number;
  defaultProvider: string;
  defaultModel: string;
  providerStates: Readonly<Record<string, ProviderRuleState>>;
  failoverOrder: readonly string[];
  updatedBy: string;
}

export type SaveAgentRulesResponse =
  | {
      status: "saved";
      message: "Rules saved";
      rules: AgentRulesView;
    }
  | {
      status: "rejected";
      message: string;
      rejection: AgentRulesRejection;
      rules: AgentRulesView;
    }
  | {
      status: "conflict";
      message: string;
      rules: AgentRulesView;
    };

export interface AgentRulesCatalogueSource {
  validationContext(): Promise<AgentRulesValidationContext>;
}

/** HTTP-facing service for GET /api/agent-rules and PUT /api/agent-rules.
 * Validation failures map to 422, revision conflicts to 409, and successful
 * replacement to 200. It never exposes auth settings or health records. */
export interface ConsoleAgentRulesService {
  view(): Promise<AgentRulesView>;
  save(request: SaveAgentRulesRequest): Promise<SaveAgentRulesResponse>;
}

/** Builds the UI view from effective rules and static provider catalogues. */
export declare function presentAgentRules(
  revision: number,
  rules: AgentRules,
  validation: AgentRulesValidationContext,
): AgentRulesView;

/** The service is the only console writer for this aggregate; generic per-key
 * writes must not bypass its complete-rule validation or transaction. */
export declare function createConsoleAgentRulesService(
  repository: AgentRulesRepository,
  catalogues: AgentRulesCatalogueSource,
): ConsoleAgentRulesService;
