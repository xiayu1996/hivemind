<script setup>
import { computed, ref, watchEffect } from "vue";
import { formatRelativeTime, overviewGroups } from "../../src/console/overview.js";

const views = ["nodes", "tasks", "costs", "config", "stats", "providers"];
const current = ref(views.includes(location.pathname.slice(1)) ? location.pathname.slice(1) : "overview");
const rows = ref([]);
const overview = ref({ questions: [], active: [], events: [] });
const error = ref("");

watchEffect(async () => {
  error.value = "";
  try {
    const response = await fetch(current.value === "overview" ? "/api/overview" : `/api/${current.value}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (current.value === "overview") overview.value = payload;
    else rows.value = Array.isArray(payload) ? payload : [payload];
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "Request failed";
  }
});

const groups = computed(() => overviewGroups(overview.value));

function itemSummary(item) {
  const time = item.timestamp ?? item.updatedAt;
  if (!Number.isFinite(time)) return item.summary;
  return `${item.summary} · ${formatRelativeTime(time)}`;
}

function navigate(view) {
  history.pushState({}, "", view === "overview" ? "/" : `/${view}`);
  current.value = view;
}
</script>

<template>
  <main>
    <header><h1>hivemind</h1><span>read-only operations console</span></header>
    <nav>
      <button :class="{ active: current === 'overview' }" @click="navigate('overview')">overview</button>
      <button v-for="view in views" :key="view" :class="{ active: current === view }" @click="navigate(view)">
        {{ view }}
      </button>
      <a href="/queues">queues</a>
    </nav>
    <section v-if="current === 'overview'">
      <p v-if="error" class="error">{{ error }}</p>
      <template v-else>
        <article v-for="group in groups" :key="group.title" class="overview-group">
          <h2>{{ group.title }}</h2>
          <p v-if="group.items.length === 0" class="empty">Nothing needs attention.</p>
          <a v-for="item in group.items" :key="item.id || item.storyId" class="overview-item" :href="item.taskPath">
            <strong>{{ item.title }}</strong><span>{{ item.state }} · {{ itemSummary(item) }}</span>
          </a>
        </article>
      </template>
    </section>
    <section v-else>
      <h2>{{ current }}</h2>
      <p v-if="error" class="error">{{ error }}</p>
      <p v-else-if="rows.length === 0" class="empty">No records</p>
      <article v-for="(row, index) in rows" :key="row.id || row.key || row.runId || index">
        <pre>{{ JSON.stringify(row, null, 2) }}</pre>
      </article>
    </section>
  </main>
</template>
