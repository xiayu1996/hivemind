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

export function createAgentRulesPageController(api: AgentRulesApi): AgentRulesPageController {
  let state: AgentRulesPageState = {
    status: "loading",
    persisted: null,
    draft: null,
    message: "",
    fieldErrors: {},
  };

  /** The editable draft mirrors every loaded rule field; credentials and health
   * are not part of the server view, so there is nothing to carry across. */
  const draftFrom = (view: AgentRulesView): SaveAgentRulesRequest => ({
    revision: view.revision,
    defaultProvider: view.defaultProvider,
    defaultModel: view.defaultModel,
    providerStates: Object.fromEntries(view.providers.map((provider) => [provider.name, provider.state])),
    failoverOrder: [...view.failoverOrder],
    updatedBy: "",
  });

  const edit = (change: (draft: SaveAgentRulesRequest) => SaveAgentRulesRequest): void => {
    if (!state.draft) return;
    state = { ...state, draft: change(state.draft) };
  };

  return {
    get state() {
      return state;
    },

    async open() {
      state = { ...state, status: "loading", message: "", fieldErrors: {} };
      const view = await api.load();
      state = { status: "ready", persisted: view, draft: draftFrom(view), message: "", fieldErrors: {} };
    },

    selectDefaultProvider(provider) {
      edit((draft) => ({ ...draft, defaultProvider: provider }));
    },

    selectDefaultModel(model) {
      edit((draft) => ({ ...draft, defaultModel: model }));
    },

    setProviderState(provider, providerState) {
      edit((draft) => ({
        ...draft,
        providerStates: { ...draft.providerStates, [provider]: providerState },
      }));
    },

    reorderProviders(order) {
      edit((draft) => ({ ...draft, failoverOrder: [...order] }));
    },

    async save(updatedBy) {
      if (!state.draft) return;
      const draft: SaveAgentRulesRequest = { ...state.draft, updatedBy };
      state = { ...state, draft, status: "saving", message: "", fieldErrors: {} };
      const response = await api.save(draft);
      if (response.status === "saved") {
        state = {
          status: "saved",
          persisted: response.rules,
          draft: draftFrom(response.rules),
          message: response.message,
          fieldErrors: {},
        };
        return;
      }
      // A rejected or conflicting save never restores the server's fields: the
      // draft the maintainer edited stays on screen so it can be corrected.
      const fieldErrors =
        response.status === "rejected" && response.rejection.kind !== "unavailable_agent_types"
          ? { [response.rejection.field]: response.rejection.message }
          : {};
      state = { status: "rejected", persisted: response.rules, draft, message: response.message, fieldErrors };
    },
  };
}
