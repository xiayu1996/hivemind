import { describe, expect, it } from "vitest";
import { renderStoryProgressPage, storyProgressPageView } from "./story-progress-page.js";
import {
  STORY_PROGRESS_COPY,
  formatRoundBlockerLine,
  formatRoundCostValue,
  formatRoundLabel,
  formatTotalCostValue,
  initialStoryProgressView,
  reduceStoryProgressView,
  selectedRoundOf,
  type StoryProgressRound,
  type StoryProgressSnapshot,
} from "./story-progress.js";

const STORY = "S-R237511DT-01";

function round(number: number, overrides: Partial<StoryProgressRound> = {}): StoryProgressRound {
  return {
    round: number,
    trigger: "first_run",
    triggerNote: null,
    phase: "CODE",
    startedAt: 1_700_000_000_000 + number,
    endedAt: 1_700_000_100_000 + number,
    result: { state: "available", items: [] },
    blockers: [],
    costUsd: 0,
    ...overrides,
  };
}

function snapshot(rounds: readonly StoryProgressRound[], totalCostUsd: number): StoryProgressSnapshot {
  return {
    storyId: STORY,
    title: "费用投影核对",
    state: "VERIFY",
    currentRoundId: rounds.at(-1)?.round ?? 0,
    rounds,
    totalCostUsd,
    costCeilingUsd: 10,
    workState: "running",
    generatedAt: 1_700_000_200_000,
  };
}

const current = round(3, {
  trigger: "restart",
  phase: "VERIFY",
  endedAt: null,
  costUsd: 1.24,
  result: {
    state: "available",
    items: [
      { scenarioId: `${STORY}-gamma`, text: "当前轮验收一", outcome: "passed" },
      { scenarioId: `${STORY}-delta`, text: "当前轮验收二", outcome: "passed" },
    ],
  },
});
const older = round(2, {
  trigger: "rework",
  phase: "CODE",
  costUsd: 0.96,
  result: { state: "available", items: [{ scenarioId: `${STORY}-beta`, text: "返工验收", outcome: "failed" }] },
  blockers: [{ scenarioId: `${STORY}-beta`, text: "返工验收" }],
});
const threeRounds = snapshot([round(1, { costUsd: 0.9 }), older, current], 3.8);

function loaded(): ReturnType<typeof reduceStoryProgressView> {
  const loading = reduceStoryProgressView(initialStoryProgressView(STORY), { type: "load" });
  return reduceStoryProgressView(loading, {
    type: "loaded",
    requestId: loading.requestId,
    result: { kind: "progress", snapshot: threeRounds },
  });
}

/**
 * The mobile scenario is settled by the ui layer: one column, the bottom "当前"
 * entry, and where each section lands on a phone are layout facts no test runner
 * can see. What CODE owns is the markup that column is built from: the source
 * order the phone stacks (current round, its blocker, its cost, then history),
 * that the switcher starts on the current round, that a history round is
 * reachable by its own number, and that the story-wide total is the same number
 * whichever round is selected, so the bottom entry never replaces it with one
 * round's own spend.
 */
describe("@scenario S-R237511DT-01-mobile the column a phone shows starts on the current round", () => {
  it("starts on the current round and keeps the story-wide total while a history round is read", () => {
    const ready = loaded();
    expect(formatRoundLabel(selectedRoundOf(ready)!.round, threeRounds.currentRoundId)).toBe(STORY_PROGRESS_COPY.currentRoundTab);
    expect(selectedRoundOf(ready)!.round).toBe(3);

    const selected = reduceStoryProgressView(ready, { type: "select", round: 2 });
    const shown = selectedRoundOf(selected)!;
    expect(shown.round).toBe(2);
    expect(formatRoundLabel(shown.round, threeRounds.currentRoundId)).toBe("第 2 轮");
    expect(formatRoundCostValue(shown, threeRounds.currentRoundId)).toBe("$0.96（本需求第 2 轮）");
    expect(formatTotalCostValue(selected.snapshot!.totalCostUsd)).toBe("$3.80（本需求全部轮次）");
  });

  it("names the three sections the phone stacks in one column", () => {
    expect(STORY_PROGRESS_COPY.currentRoundPanelHeading).toBe("当前轮阶段与结果");
    expect(STORY_PROGRESS_COPY.roundCostHeading).toBe("本轮费用");
    expect(STORY_PROGRESS_COPY.historyHeading).toBe("历史轮次");
  });

  it("keeps a round's blocker legible without the colour that marks it", () => {
    expect(formatRoundBlockerLine(older)).toBe("卡点：1 项验收未通过");
    expect(formatRoundBlockerLine(current)).toBe(STORY_PROGRESS_COPY.noBlocker);
  });

  it("@scenario S-R237511DT-01-mobile 单列把卡点排在本轮费用之前，再排历史轮次", () => {
    const withBlocker = snapshot([
      round(1, { costUsd: 0.9 }),
      older,
      { ...current, blockers: [{ scenarioId: `${STORY}-zeta`, text: "当前轮验收未通过" }] },
    ], 3.8);
    const html = renderStoryProgressPage(
      storyProgressPageView({ kind: "progress", snapshot: withBlocker }, {}),
    );
    const order = ["round-panel", "blocker-panel", "cost-panel", "switcher-panel"]
      .map((name) => html.indexOf(`class="panel section ${name}"`));
    expect(order[0]).toBeGreaterThan(-1);
    expect(order[1]).toBeGreaterThan(order[0]!);
    expect(order[2]).toBeGreaterThan(order[1]!);
    expect(order[3]).toBeGreaterThan(order[2]!);
  });
});
