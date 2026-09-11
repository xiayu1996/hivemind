<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { formatOverviewItem, overviewSections } from "../../src/console/overview.js";
import { formatSnapshotAt, hasCompleteOverview, hasFreshSnapshot, primarySections, SNAPSHOT_MAX_AGE_MS } from "../../src/console/overview-client.js";

const views = ["nodes", "tasks", "costs", "config", "stats", "providers"];
const current = ref(views.includes(location.pathname.slice(1)) ? location.pathname.slice(1) : "overview");
const rows = ref([]);
const overview = ref(null);
const error = ref("");
const showSecondary = ref(false);
let refreshTimer;
let expiryTimer;

const sections = computed(() => overview.value ? overviewSections(overview.value) : []);
const visibleSections = computed(() => showSecondary.value ? sections.value : primarySections(sections.value));

function clearOverview() {
  overview.value = null;
  showSecondary.value = false;
  error.value = "Unable to load current status.";
  clearTimeout(expiryTimer);
}

function scheduleExpiry(snapshotAt) {
  clearTimeout(expiryTimer);
  expiryTimer = setTimeout(clearOverview, Math.max(0, snapshotAt + SNAPSHOT_MAX_AGE_MS - Date.now()));
}

async function loadOverview() {
  try {
    const response = await fetch("/api/overview", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (!hasFreshSnapshot(payload) || !hasCompleteOverview(payload)) throw new Error("stale or incomplete snapshot");
    overview.value = payload;
    showSecondary.value = false;
    error.value = "";
    scheduleExpiry(payload.snapshotAt);
    requestAnimationFrame(() => { showSecondary.value = true; });
  } catch {
    clearOverview();
  }
}

async function loadView(view) {
  if (view === "overview") return loadOverview();
  error.value = "";
  try {
    const response = await fetch(`/api/${view}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    rows.value = Array.isArray(payload) ? payload : [payload];
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "Request failed";
  }
}

function navigate(view) {
  history.pushState({}, "", view === "overview" ? "/" : `/${view}`);
  current.value = view;
}

function refreshOnFocus() {
  if (current.value === "overview") void loadOverview();
}

watch(current, (view) => { void loadView(view); }, { immediate: true });
onMounted(() => {
  window.addEventListener("focus", refreshOnFocus);
  refreshTimer = window.setInterval(refreshOnFocus, 60_000);
});
onBeforeUnmount(() => {
  window.removeEventListener("focus", refreshOnFocus);
  clearInterval(refreshTimer);
  clearTimeout(expiryTimer);
});
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
      <template v-else-if="overview">
        <p class="snapshot-time">{{ formatSnapshotAt(overview.snapshotAt) }}</p>
        <article
          v-for="section in visibleSections"
          :key="section.title"
          :class="section.kind === 'cost' ? 'cost-region' : 'overview-group'"
        >
          <h2>{{ section.title }}</h2>
          <template v-if="section.kind === 'cost'">
            <p class="cost-totals">
              <span class="cost-amount">{{ section.todayLabel }}</span>
              <span class="cost-amount">{{ section.monthLabel }}</span>
              <span class="cost-updated">{{ section.updatedLabel }}</span>
            </p>
            <ol class="cost-chart">
              <li v-for="bar in section.chart" :key="bar.dateLabel" class="cost-bar">
                <span class="cost-bar-amount">{{ bar.amountLabel }}</span>
                <span class="cost-bar-track"><span class="cost-bar-fill" :style="{ height: `${bar.heightPercent}%` }"></span></span>
                <span class="cost-bar-date">{{ bar.dateLabel }}</span>
              </li>
            </ol>
            <ul class="cost-models">
              <li v-for="model in section.models" :key="model.modelId">{{ model.text }}</li>
            </ul>
          </template>
          <template v-else>
            <p v-if="section.items.length === 0" class="empty">Nothing needs attention.</p>
            <a v-for="item in section.items" :key="item.id || item.storyId" class="overview-item" :href="item.taskPath">
              <strong>{{ item.title }}</strong><span>{{ formatOverviewItem(item) }}</span>
            </a>
          </template>
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
