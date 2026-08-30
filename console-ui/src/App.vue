<script setup>
import { ref, watchEffect } from "vue";

const views = ["nodes", "tasks", "costs", "config", "stats", "providers"];
const current = ref(views.includes(location.pathname.slice(1)) ? location.pathname.slice(1) : "nodes");
const rows = ref([]);
const error = ref("");

watchEffect(async () => {
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
    <header><h1>hivemind</h1><span>read-only operations console</span></header>
    <nav>
      <button v-for="view in views" :key="view" :class="{ active: current === view }" @click="navigate(view)">
        {{ view }}
      </button>
      <a href="/queues">queues</a>
    </nav>
    <section>
      <h2>{{ current }}</h2>
      <p v-if="error" class="error">{{ error }}</p>
      <p v-else-if="rows.length === 0" class="empty">No records</p>
      <article v-for="(row, index) in rows" :key="row.id || row.key || row.runId || index">
        <pre>{{ JSON.stringify(row, null, 2) }}</pre>
      </article>
    </section>
  </main>
</template>
