<script setup>
import { onMounted, ref } from "vue";
import { createAgentRulesPageController } from "./agent-rules";

const controller = createAgentRulesPageController({
  async load() {
    const response = await fetch("/api/agent-rules");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  },
  async save(request) {
    const response = await fetch("/api/agent-rules", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    // A rejected rule (422) and a stale one (409) both carry the effective
    // rule in the body; anything else is a transport failure, not a verdict.
    if (!response.ok && response.status !== 422 && response.status !== 409) {
      throw new Error(`HTTP ${response.status}`);
    }
    return response.json();
  },
});

const state = ref(controller.state);
const failure = ref("");
const saving = ref(false);

function sync() {
  state.value = controller.state;
}

async function open() {
  failure.value = "";
  try {
    await controller.open();
  } catch (cause) {
    failure.value = cause instanceof Error ? cause.message : "Request failed";
  }
  sync();
}

function choicesFor(provider) {
  return state.value.persisted?.providers.find((entry) => entry.name === provider)?.modelChoices ?? [];
}

function selectProvider(provider) {
  controller.selectDefaultProvider(provider);
  const choices = choicesFor(provider);
  if (choices.length > 0 && !choices.includes(state.value.draft.defaultModel)) {
    controller.selectDefaultModel(choices[0]);
  }
  sync();
}

function selectModel(model) {
  controller.selectDefaultModel(model);
  sync();
}

function toggle(provider) {
  const next = state.value.draft.providerStates[provider] === "enabled" ? "disabled" : "enabled";
  controller.setProviderState(provider, next);
  sync();
}

function move(provider, offset) {
  const order = [...state.value.draft.failoverOrder];
  const index = order.indexOf(provider);
  const target = index + offset;
  if (index < 0 || target < 0 || target >= order.length) return;
  [order[index], order[target]] = [order[target], order[index]];
  controller.reorderProviders(order);
  sync();
}

async function save() {
  failure.value = "";
  saving.value = true;
  try {
    await controller.save("maintainer");
  } catch (cause) {
    failure.value = cause instanceof Error ? cause.message : "Request failed";
  }
  saving.value = false;
  sync();
}

onMounted(open);
</script>

<template>
  <h2>Agent rules</h2>
  <p v-if="failure" class="error">{{ failure }}</p>
  <p v-if="state.message" :class="state.status === 'saved' ? 'message' : 'error'">{{ state.message }}</p>
  <p v-if="!state.draft" class="empty">Loading rules…</p>
  <template v-else>
    <p>Default provider: {{ state.draft.defaultProvider }}</p>
    <p v-if="state.fieldErrors.defaultProvider" class="error">{{ state.fieldErrors.defaultProvider }}</p>
    <p>Default model: {{ state.draft.defaultModel }}</p>
    <p v-if="state.fieldErrors.defaultModel" class="error">{{ state.fieldErrors.defaultModel }}</p>
    <ul class="rule-list">
      <li v-for="(provider, index) in state.draft.failoverOrder" :key="provider" class="rule-row">
        <span class="rule-name">{{ provider }} — {{ state.draft.providerStates[provider] === "enabled" ? "Enabled" : "Disabled" }}</span>
        <label>
          <input
            type="radio"
            name="default-provider"
            :checked="state.draft.defaultProvider === provider"
            @change="selectProvider(provider)"
          />
          default
        </label>
        <select
          v-if="state.draft.defaultProvider === provider"
          :value="state.draft.defaultModel"
          @change="selectModel($event.target.value)"
        >
          <option v-for="model in choicesFor(provider)" :key="model" :value="model">{{ model }}</option>
        </select>
        <button @click="toggle(provider)">{{ state.draft.providerStates[provider] === "enabled" ? "Disable" : "Enable" }}</button>
        <button :disabled="index === 0" @click="move(provider, -1)">Up</button>
        <button :disabled="index === state.draft.failoverOrder.length - 1" @click="move(provider, 1)">Down</button>
      </li>
    </ul>
    <p>Failover order: {{ state.draft.failoverOrder.join(" → ") }}</p>
    <button class="save" :disabled="saving" @click="save">Save rules</button>
  </template>
</template>
