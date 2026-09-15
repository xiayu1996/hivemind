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
export function presentAgentRules(
  revision: number,
  rules: AgentRules,
  validation: AgentRulesValidationContext,
): AgentRulesView {
  const providers = rules.failoverOrder.map((name): AgentRulesProviderView => {
    const state = rules.providerStates[name] ?? "disabled";
    return {
      name,
      state,
      stateLabel: state === "enabled" ? "Enabled" : "Disabled",
      modelChoices: (validation.configuredProviders[name]?.catalogue ?? []).map((model) => model.id),
    };
  });
  return {
    revision,
    defaultProvider: rules.defaultProvider,
    defaultModel: rules.defaultModel,
    providers,
    failoverOrder: [...rules.failoverOrder],
  };
}

/** The service is the only console writer for this aggregate; generic per-key
 * writes must not bypass its complete-rule validation or transaction. */
export function createConsoleAgentRulesService(
  repository: AgentRulesRepository,
  catalogues: AgentRulesCatalogueSource,
): ConsoleAgentRulesService {
  return {
    async view() {
      const current = await repository.read();
      return presentAgentRules(current.revision, current.rules, await catalogues.validationContext());
    },

    async save(request) {
      const validation = await catalogues.validationContext();
      const proposal: AgentRules = {
        defaultProvider: request.defaultProvider,
        defaultModel: request.defaultModel,
        providerStates: request.providerStates,
        failoverOrder: request.failoverOrder,
      };
      const result = await repository.replace({
        proposal,
        expectedRevision: request.revision,
        updatedBy: request.updatedBy,
        validation,
      });
      if (result.saved) {
        return {
          status: "saved",
          message: "Rules saved",
          rules: presentAgentRules(result.current.revision, result.current.rules, validation),
        };
      }
      // The rejection carries the effective rule, never the proposal: a save
      // that is refused has persisted none of the submitted fields.
      const rules = presentAgentRules(result.current.revision, result.current.rules, validation);
      if (result.reason === "validation") {
        return { status: "rejected", message: result.rejection.message, rejection: result.rejection, rules };
      }
      return { status: "conflict", message: "The rules changed while you were editing.", rules };
    },
  };
}
