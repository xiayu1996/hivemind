<script setup>
import { computed, ref, watchEffect } from "vue";
import { formatStartedWaiting, formatWaitingDuration } from "../../src/console/work-status-time.js";

const views = ["work-status", "nodes", "tasks", "costs", "config", "stats", "providers"];
const taskPath = /^\/tasks\/([^/]+)$/.exec(location.pathname);
const current = ref(taskPath ? "tasks" : views.includes(location.pathname.slice(1)) ? location.pathname.slice(1) : "work-status");
const handlingTaskId = ref(taskPath?.[1] ?? null);
const rows = ref([]);
const displayedRows = computed(() => handlingTaskId.value
  ? rows.value.filter((row) => row.id === handlingTaskId.value)
  : rows.value);
const overview = ref(null);
const error = ref("");

async function load() {
  error.value = "";
  try {
    const response = await fetch(`/api/${current.value}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    overview.value = current.value === "work-status" ? payload : null;
    rows.value = Array.isArray(payload) ? payload : [payload];
  } catch (cause) {
    overview.value = null;
    error.value = cause instanceof Error ? cause.message : "Request failed";
  }
}

watchEffect(load);

function navigate(view) {
  history.pushState({}, "", `/${view}`);
  current.value = view;
  handlingTaskId.value = null;
}

</script>

<template>
  <main>
    <header><h1>hivemind</h1><span>read-only operations console</span></header>
    <nav>
      <button v-for="view in views" :key="view" :class="{ active: current === view }" @click="navigate(view)">
        {{ view }}
      </button>
      <a href="/queues">queues</a>
    </nav>
    <section v-if="current === 'work-status'" class="overview">
      <h2>Work status</h2>
      <div v-if="error" class="error" role="alert">
        <p>Unable to load work status: {{ error }}</p>
        <button @click="load">Retry</button>
      </div>
      <template v-else-if="overview">
        <section class="overview-section">
          <h3>Pending responses</h3>
          <p v-if="overview.pendingResponseState === 'no_pending_responses'" class="empty">No pending responses</p>
          <article v-for="gate in overview.pendingResponses" :key="gate.id">
            <strong>{{ gate.requiredAction }}</strong>
            <dl>
              <dt>Requirement</dt><dd>{{ gate.requirementTitle }}</dd>
              <dt>Current phase</dt><dd>{{ gate.currentPhase }}</dd>
              <dt>Context</dt><dd>{{ gate.context }}</dd>
              <dt>Started waiting</dt><dd>Started waiting: {{ formatStartedWaiting(gate.startedWaitingAt) }}</dd>
              <dt>Waiting duration</dt><dd>Waiting for {{ formatWaitingDuration(gate.waitingDurationMinutes) }}</dd>
            </dl>
            <a :href="gate.navigationTarget">Open handling location</a>
          </article>
        </section>
        <section class="overview-section">
          <h3>Active requirements</h3>
          <p v-if="overview.activeRequirementState === 'no_active_requirements'" class="empty">No active requirements</p>
          <article v-for="requirement in overview.activeRequirements" :key="requirement.id">
            <strong>{{ requirement.title }}</strong>
            <p>Current phase: {{ requirement.phase }}</p>
            <p>Last updated: {{ requirement.updated_at }}</p>
          </article>
        </section>
      </template>
    </section>
    <section v-else>
      <h2>{{ current }}</h2>
      <p v-if="error" class="error">{{ error }}</p>
      <p v-else-if="displayedRows.length === 0" class="empty">No records</p>
      <article v-for="(row, index) in displayedRows" :key="row.id || row.key || row.runId || index">
        <pre>{{ JSON.stringify(row, null, 2) }}</pre>
      </article>
    </section>
  </main>
</template>
