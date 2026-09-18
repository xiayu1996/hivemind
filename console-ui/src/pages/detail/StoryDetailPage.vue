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
 * Copy, formatting and the state machine live in ./contracts.ts. CODE fills
 * this file in; the props below are the seam the shell binds to.
 */
import type { StoryDetailPort } from "./contracts.js";
import { STORY_DETAIL_REFRESH_INTERVAL_MS } from "./contracts.js";

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
</script>

<template>
  <!-- CODE: the regions, states and switcher described above. -->
  <section class="story-detail" :data-card-id="props.cardId" />
</template>
