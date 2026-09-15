<script setup>
import { ref, watchEffect } from "vue";
import AgentRules from "./AgentRules.vue";

const views = ["nodes", "tasks", "queue", "costs", "config", "stats", "providers", "agent-rules"];
const current = ref(views.includes(location.pathname.slice(1)) ? location.pathname.slice(1) : "nodes");
const rows = ref([]);
const error = ref("");

watchEffect(async () => {
  if (current.value === "agent-rules") {
    // The rules page owns its own form and transport; there is no generic
    // read to render beside it.
    rows.value = [];
    error.value = "";
    return;
  }
  error.value = "";
  try {
    const response = await fetch(`/api/${current.value}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    rows.value = Array.isArray(payload) ? payload : [payload];
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "Request failed";
  }
});

function navigate(view) {
  history.pushState({}, "", `/${view}`);
  current.value = view;
}
</script>

<template>
  <main>
    <header><h1>hivemind</h1><span>operations console</span></header>
    <nav>
      <button v-for="view in views" :key="view" :class="{ active: current === view }" @click="navigate(view)">
        {{ view }}
      </button>
    </nav>
    <section>
      <AgentRules v-if="current === 'agent-rules'" />
      <template v-else>
        <h2>{{ current }}</h2>
        <p v-if="error" class="error">{{ error }}</p>
        <p v-else-if="rows.length === 0" class="empty">No records</p>
        <article v-for="(row, index) in rows" :key="row.id || row.key || row.runId || index">
          <pre>{{ JSON.stringify(row, null, 2) }}</pre>
        </article>
      </template>
    </section>
  </main>
</template>
