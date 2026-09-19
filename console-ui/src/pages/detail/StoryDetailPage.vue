<script setup lang="ts">
/**
 * The task card's detail screen: where the current round is, what it has won,
 * where it is stuck and what it has cost, plus the rounds before it.
 *
 * It owns exactly three things -- which round a person picked, the read state,
 * and the refresh timer -- and nothing else. It writes nothing: the ledger is
 * the only truth and this screen reads one snapshot of it, so a failure here
 * can never move a card.
 *
 * The shell mounts it for a task card and passes the id in; the screen never
 * reads the URL. That is what lets the same screen be mounted by desktop and
 * phone shells without either of them owning its content.
 *
 * Regions in reading order. Design 08 section 6 checks these roles against the
 * accessibility tree, so the roles are part of the contract, not decoration:
 *
 *   1. title bar    -- the card's own title as the page heading, its state as
 *                      a status tag, and the way back to the overview
 *   2. round panel  -- the selected round: a heading (`当前轮阶段与结果` for the
 *                      current round, `第 2 轮` for an older one), the round's
 *                      cause in a `status` node (`触发原因：返工`), its phase and
 *                      what it has won. A round that is open with no result yet
 *                      replaces the result line with `本轮结果尚未产生，将自动刷新`
 *                      in a `status` node, and never shows zero.
 *   3. cost panel   -- `本轮费用` and `累计费用`, each a heading with the amount
 *                      and its scope beside it
 *   4. blockers     -- `卡点：1 项验收未通过`, or `卡点：无`
 *   5. history      -- `轮次切换与历史`: the round switcher, whose entries are
 *                      the `当前轮` entry plus one per older round, and which
 *                      expands only the selected round's panel above
 *
 * The five read states are the shell's shared state views (design 03 section
 * 9): `当前还没有工作轮次` with the way back to the overview when the card has
 * run no round; `正在读取当前轮与历史轮次` over the content that is already
 * there; `无法读取任务进展` with `重新读取` when a read failed; and nothing at
 * all invented for a round that has not produced a result.
 *
 * On phone widths the content is one column in the order above, the round
 * switcher stays reachable, and one entry labelled `当前` is fixed at the
 * bottom (`layer.navigation`) so a person can get back to the current round
 * from anywhere on the screen. Exactly one such entry exists on the screen: if
 * the shell's own mobile navigation already carries it, the screen uses that
 * one and adds none. The content column reserves the space it takes, so the
 * entry never covers an amount, a blocker or a round.
 *
 * Copy, formatting and the state machine live in ./contracts.ts.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  STORY_DETAIL_COPY,
  STORY_DETAIL_REFRESH_INTERVAL_MS,
  currentRoundOf,
  formatRoundBlockerLine,
  formatRoundCostValue,
  formatRoundLabel,
  formatRoundPanelHeading,
  formatRoundPhaseLine,
  formatRoundResultLine,
  formatRoundTriggerLine,
  formatTotalCostValue,
  initialStoryDetailView,
  reduceStoryDetailView,
  selectedRoundOf,
  storyDetailMobileNavigation,
  type StoryDetailPort,
  type StoryDetailViewState,
} from "./contracts.js";

const props = withDefaults(
  defineProps<{
    /** The task card this screen is about. */
    cardId: string;
    /** Where the snapshot comes from. The shell passes the HTTP port; a test
     * passes a fake, which is what keeps this screen testable without a server. */
    port: StoryDetailPort;
    /** Overridden only to make a test's refresh deterministic. */
    refreshIntervalMs?: number;
  }>(),
  { refreshIntervalMs: STORY_DETAIL_REFRESH_INTERVAL_MS },
);

const view = ref<StoryDetailViewState>(initialStoryDetailView(props.cardId));
let timer: ReturnType<typeof setInterval> | null = null;

/** Starts one read. The content and the selection stay where they are; only the
 * pending marker moves, so a refresh never blanks the screen. */
function read(): void {
  const loading = reduceStoryDetailView(view.value, { type: "load" });
  view.value = loading;
  const requestId = loading.requestId;
  props.port.readStoryDetail(props.cardId).then(
    (result) => {
      view.value = reduceStoryDetailView(view.value, { type: "loaded", requestId, result });
    },
    () => {
      // The port answers a failed read with `failed`, so a rejected promise is
      // the same answer arriving a different way; it must not escape as an
      // unhandled rejection or be read as a fresh snapshot.
      view.value = reduceStoryDetailView(view.value, { type: "failed", requestId });
    },
  );
}

function selectRound(round: number | null): void {
  view.value = reduceStoryDetailView(view.value, { type: "select", round });
}

function onVisibility(): void {
  if (document.visibilityState === "visible") read();
}

onMounted(() => {
  read();
  timer = setInterval(read, props.refreshIntervalMs);
  document.addEventListener("visibilitychange", onVisibility);
});

onBeforeUnmount(() => {
  if (timer !== null) clearInterval(timer);
  document.removeEventListener("visibilitychange", onVisibility);
});

watch(
  () => props.cardId,
  (cardId) => {
    view.value = initialStoryDetailView(cardId);
    read();
  },
);

const snapshot = computed(() => view.value.snapshot);
const rounds = computed(() => snapshot.value?.rounds ?? []);
const currentRound = computed(() => currentRoundOf(snapshot.value));
const currentNumber = computed(() => currentRound.value?.round ?? null);
/** The picked round, or the current one. Never null while a round exists. */
const selected = computed(() => selectedRoundOf(view.value));
const olderRounds = computed(() => rounds.value.filter((round) => round.round !== currentNumber.value));
const hasRounds = computed(() => rounds.value.length > 0);
const mobileNavigation = computed(() => storyDetailMobileNavigation());
const isLoading = computed(() => view.value.status === "loading");
const failed = computed(() => view.value.status === "error");
const isEmpty = computed(() => view.value.status === "empty");

function panelHeading(round: number): string {
  return formatRoundPanelHeading(round, currentNumber.value ?? round);
}

function roundLabel(round: number): string {
  return formatRoundLabel(round, currentNumber.value ?? round);
}

function costValue(round: number): string {
  const entry = rounds.value.find((item) => item.round === round);
  return entry ? formatRoundCostValue(entry, currentNumber.value ?? round) : "";
}
</script>

<template>
  <section class="story-detail" :data-card-id="props.cardId">
    <header class="page-head">
      <div>
        <h1>{{ snapshot?.title ?? "" }}</h1>
        <p v-if="snapshot" class="meta">{{ snapshot.state }}</p>
      </div>
      <a class="back-link" href="overview.html">{{ STORY_DETAIL_COPY.backToOverview }}</a>
    </header>

    <p v-if="isLoading" class="read-state" role="status">{{ STORY_DETAIL_COPY.loading }}</p>

    <div v-if="failed" class="notice danger">
      <!-- The message is the alert node's own text, not a child heading's:
           the structural layer reads role and text off one node. -->
      <p class="notice-message" role="alert">{{ STORY_DETAIL_COPY.failed }}</p>
      <button type="button" @click="read">{{ STORY_DETAIL_COPY.retry }}</button>
    </div>

    <div v-if="isEmpty" class="state-page">
      <div class="state-card">
        <h2>{{ STORY_DETAIL_COPY.noRounds }}</h2>
        <a class="button secondary" href="overview.html">{{ STORY_DETAIL_COPY.backToOverview }}</a>
      </div>
    </div>

    <template v-if="hasRounds">
      <section v-if="selected" class="panel section" aria-labelledby="round-panel-title">
        <h2 id="round-panel-title">{{ panelHeading(selected.round) }}</h2>
        <p class="line" role="status">{{ formatRoundTriggerLine(selected) }}</p>
        <p class="line">{{ formatRoundPhaseLine(selected) }}</p>
        <p class="line" role="status">{{ formatRoundResultLine(selected) }}</p>
      </section>

      <section v-if="selected" class="panel section" aria-labelledby="cost-title">
        <h2 id="cost-title">{{ STORY_DETAIL_COPY.roundCostHeading }}</h2>
        <p class="money">{{ formatRoundCostValue(selected, currentNumber ?? selected.round) }}</p>
        <h2>{{ STORY_DETAIL_COPY.totalCostHeading }}</h2>
        <p class="money">{{ formatTotalCostValue(snapshot?.totalCostUsd ?? 0) }}</p>
      </section>

      <section v-if="selected" class="panel section" aria-labelledby="blocker-title">
        <h2 id="blocker-title">卡点</h2>
        <p class="line" role="status">{{ formatRoundBlockerLine(selected) }}</p>
      </section>

      <section class="panel section" aria-labelledby="round-switcher-title">
        <h2 id="round-switcher-title">{{ STORY_DETAIL_COPY.roundSwitcherHeading }}</h2>
        <div class="tabs" role="tablist" aria-label="选择轮次">
          <button
            v-for="round in rounds"
            :key="round.round"
            class="tab"
            type="button"
            role="tab"
            :aria-selected="selected?.round === round.round"
            @click="selectRound(round.round)"
          >
            {{ roundLabel(round.round) }}
          </button>
        </div>
        <h2 class="subheading">{{ STORY_DETAIL_COPY.historyHeading }}</h2>
        <ul class="round-list">
          <li v-for="round in olderRounds" :key="round.round">
            <button type="button" class="round-entry" @click="selectRound(round.round)">
              <strong>{{ roundLabel(round.round) }}</strong>
              <span class="meta">{{ formatRoundTriggerLine(round) }}</span>
              <span class="money">{{ costValue(round.round) }}</span>
            </button>
          </li>
        </ul>
      </section>
    </template>

    <nav class="mobile-nav" aria-label="手机导航">
      <a
        v-for="entry in mobileNavigation"
        :key="entry.href"
        class="mobile-link"
        :href="entry.href"
        :aria-current="entry.current ? 'page' : undefined"
        @click.prevent="selectRound(null)"
      >
        {{ entry.label }}
      </a>
    </nav>
  </section>
</template>

<style scoped>
.story-detail {
  display: grid;
  gap: var(--space-section-gap);
  padding-bottom: calc(var(--space-section-gap) + 64px);
  color: var(--color-text);
  font-family: var(--font-interface);
  font-size: var(--font-body);
}
.page-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-section-gap);
}
.page-head h1 {
  margin: 0;
  font-size: var(--font-heading-page);
  line-height: 1.2;
}
.read-state {
  margin: 0;
  color: var(--color-text-muted);
  font-size: var(--font-caption);
}
.panel {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-panel);
  padding: 18px;
}
.panel h2 {
  margin: 0;
  font-size: var(--font-heading-small);
}
.panel h2.subheading {
  margin-top: var(--space-section-gap);
}
.line {
  margin: var(--space-content-gap) 0 0;
  font-size: var(--font-body-large);
}
.money {
  margin: var(--space-inline-tight) 0 var(--space-section-gap);
  font-family: var(--font-numeric);
  font-variant-numeric: tabular-nums;
  font-size: var(--font-body-large);
}
.tabs {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-control-gap);
  margin-top: var(--space-content-gap);
}
.tab {
  min-height: 44px;
  padding: 9px 13px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-control);
  background: var(--color-surface);
  color: var(--color-text);
}
.tab[aria-selected="true"] {
  background: var(--color-surface-selected);
  border-color: var(--color-action);
  color: var(--color-action);
  font-weight: var(--weight-strong);
}
.notice.danger {
  border: 1px solid var(--color-border);
  border-left: 4px solid var(--color-danger);
  border-radius: var(--radius-control);
  background: var(--color-surface-danger);
  padding: 12px 14px;
}
.notice-message {
  margin: 0;
  font-size: var(--font-heading-small);
  font-weight: var(--weight-medium);
}
.notice.danger button {
  margin-top: var(--space-content-gap);
  min-height: 44px;
  border: 1px solid var(--color-action);
  border-radius: var(--radius-control);
  background: var(--color-action);
  color: var(--color-surface);
  padding: 10px 16px;
}
.state-page {
  display: flex;
  justify-content: center;
}
.state-card {
  width: min(560px, 100%);
  padding: 30px;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-panel);
}
.round-list {
  list-style: none;
  margin: var(--space-content-gap) 0 0;
  padding: 0;
}
.round-entry {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr) auto;
  gap: var(--space-content-gap);
  align-items: center;
  width: 100%;
  min-height: 44px;
  padding: 10px 0;
  border: 0;
  border-top: 1px solid var(--color-border);
  background: transparent;
  color: var(--color-text);
  text-align: left;
}
.round-list li:first-child .round-entry {
  border-top: 0;
}
.mobile-nav {
  display: none;
}
@media (max-width: 760px) {
  .mobile-nav {
    display: block;
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: var(--layer-navigation);
    background: var(--color-surface);
    border-top: 1px solid var(--color-border);
    box-shadow: var(--shadow-raised);
  }
  .mobile-link {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 44px;
    color: var(--color-action);
    font-weight: var(--weight-strong);
  }
  .round-entry {
    grid-template-columns: 1fr;
  }
}
</style>
