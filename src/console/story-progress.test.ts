import { describe, expect, it } from "vitest";
import {
  STORY_PROGRESS_API_PATH,
  STORY_PROGRESS_COPY,
  classifyRoundStart,
  currentRound,
  formatLimitLine,
  formatLimitStateLine,
  formatRoundBlockerLine,
  formatRoundCostValue,
  formatRoundLabel,
  formatRoundPanelHeading,
  formatRoundPhaseLine,
  formatRoundResultLine,
  formatRoundTriggerLine,
  formatTotalCostValue,
  formatWorkStateLine,
  initialStoryProgressView,
  limitStateOf,
  reduceStoryProgressView,
  roundByNumber,
  selectedRoundOf,
  validateSnapshot,
  type StoryProgressReadResult,
  type StoryProgressRound,
  type StoryProgressSnapshot,
  type StoryProgressViewAction,
  type StoryProgressViewState,
  type StoryRoundAcceptance,
} from "./story-progress.js";

const STORY = "S-R237511DT-01";
const CEILING = 10;

function passed(scenarioId: string, text: string): StoryRoundAcceptance {
  return { scenarioId, text, outcome: "passed" };
}

function failed(scenarioId: string, text: string): StoryRoundAcceptance {
  return { scenarioId, text, outcome: "failed" };
}

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

function snapshot(
  rounds: readonly StoryProgressRound[],
  totalCostUsd: number,
  overrides: Partial<StoryProgressSnapshot> = {},
): StoryProgressSnapshot {
  return {
    storyId: STORY,
    title: "费用投影核对",
    state: "VERIFY",
    currentRoundId: rounds.at(-1)?.round ?? 0,
    rounds,
    totalCostUsd,
    costCeilingUsd: CEILING,
    workState: "running",
    generatedAt: 1_700_000_200_000,
    ...overrides,
  };
}

const roundOne = round(1, {
  trigger: "first_run",
  phase: "CODE",
  costUsd: 0.9,
  result: { state: "available", items: [passed("S-R237511DT-01-alpha", "首轮验收")] },
});
const roundTwo = round(2, {
  trigger: "rework",
  triggerNote: "这段把费用和用量写混了，请分开",
  phase: "CODE",
  costUsd: 0.96,
  result: { state: "available", items: [passed("S-R237511DT-01-beta", "返工验收")] },
});
const roundThree = round(3, {
  trigger: "restart",
  phase: "VERIFY",
  endedAt: null,
  costUsd: 1.24,
  result: {
    state: "available",
    items: [
      passed("S-R237511DT-01-gamma", "当前轮验收一"),
      passed("S-R237511DT-01-delta", "当前轮验收二"),
      passed("S-R237511DT-01-epsilon", "当前轮验收三"),
      failed("S-R237511DT-01-zeta", "当前轮验收四"),
    ],
  },
  blockers: [{ scenarioId: "S-R237511DT-01-zeta", text: "当前轮验收四" }],
});
const threeRounds = snapshot([roundOne, roundTwo, roundThree], 3.8);

const pendingRound = round(3, {
  trigger: "restart",
  phase: "VERIFY",
  endedAt: null,
  costUsd: 0.8,
  result: { state: "pending" },
});

/** Brings a view from its initial state to a settled one, whichever request
 * number the reducer assigns to a load. */
function loadInto(state: StoryProgressViewState, result: StoryProgressReadResult): StoryProgressViewState {
  const loading = reduceStoryProgressView(state, { type: "load" });
  return reduceStoryProgressView(loading, { type: "loaded", requestId: loading.requestId, result });
}

function act(state: StoryProgressViewState, action: StoryProgressViewAction): StoryProgressViewState {
  return reduceStoryProgressView(state, action);
}

describe("round start classification", () => {
  it("@scenario S-R237511DT-01-history 第 1 轮始终记为首次工作", () => {
    const start = classifyRoundStart({
      round: 1,
      feedbackChannel: null,
      feedbackBody: null,
      refusedPreviousResult: false,
      humanRestart: false,
    });

    expect(start).toEqual({ trigger: "first_run", note: null });
  });

  it("@scenario S-R237511DT-01-history 返工评论让该轮记为返工并保留人的原话", () => {
    const start = classifyRoundStart({
      round: 2,
      feedbackChannel: "rework",
      feedbackBody: "这段把费用和用量写混了，请分开",
      refusedPreviousResult: true,
      humanRestart: false,
    });

    expect(start).toEqual({ trigger: "rework", note: "这段把费用和用量写混了，请分开" });
  });

  it("@scenario S-R237511DT-01-history 被拒结果在没有评论时也记为返工", () => {
    const start = classifyRoundStart({
      round: 2,
      feedbackChannel: null,
      feedbackBody: null,
      refusedPreviousResult: true,
      humanRestart: false,
    });

    expect(start).toEqual({ trigger: "rework", note: null });
  });

  it("@scenario S-R237511DT-01-current 没有被拒结论时第 2 轮之后由人推动记为重新开始", () => {
    const start = classifyRoundStart({
      round: 3,
      feedbackChannel: null,
      feedbackBody: null,
      refusedPreviousResult: false,
      humanRestart: true,
    });

    expect(start).toEqual({ trigger: "restart", note: null });
  });
});

describe("round lookup", () => {
  it("@scenario S-R237511DT-01-current 当前轮是快照里的最后一个轮次", () => {
    expect(currentRound(threeRounds)).toEqual(roundThree);
  });

  it("@scenario S-R237511DT-01-history 按轮次号取到的是那一轮自己的记录", () => {
    expect(roundByNumber(threeRounds, 2)).toEqual(roundTwo);
  });

  it("@scenario S-R237511DT-01-history 不存在的轮次号不返回任何轮次", () => {
    expect(roundByNumber(threeRounds, 9)).toBeNull();
    expect(currentRound(snapshot([], 0))).toBeNull();
  });
});

describe("snapshot invariants", () => {
  it("完整快照通过不变量检查", () => {
    expect(validateSnapshot(threeRounds)).toBeNull();
  });

  it("@scenario S-R237511DT-01-current 轮次序号必须唯一且递增", () => {
    const duplicated = snapshot([roundOne, round(2, { costUsd: 0.96 }), roundTwo], 3.8);

    expect(validateSnapshot(duplicated)).toBe("round ordinals must be unique and increasing");
  });

  it("@scenario S-R237511DT-01-current 当前轮必须指向一个真实存在的轮次", () => {
    const dangling = snapshot([roundOne, roundTwo, roundThree], 3.8, { currentRoundId: 9 });

    expect(validateSnapshot(dangling)).toBe("currentRoundId must name a round in the snapshot");
  });
});

describe("round copy", () => {
  it("@scenario S-R237511DT-01-current 当前轮的触发原因、阶段、结果、卡点与两个费用口径按口径成句", () => {
    expect(formatRoundTriggerLine(roundThree)).toBe("触发原因：重新开始");
    expect(formatRoundPhaseLine(roundThree)).toBe("阶段：VERIFY");
    expect(formatRoundResultLine(roundThree)).toBe("已取得的结果：3 项验收已通过");
    expect(formatRoundBlockerLine(roundThree)).toBe("卡点：1 项验收未通过");
    expect(formatRoundCostValue(roundThree, 3)).toBe("$1.24（本需求当前轮）");
    expect(formatTotalCostValue(threeRounds.totalCostUsd)).toBe("$3.80（本需求全部轮次）");
    expect(formatRoundLabel(3, 3)).toBe("当前轮");
    expect(formatRoundPanelHeading(3, 3)).toBe("当前轮阶段与结果");
  });

  it("@scenario S-R237511DT-01-current 当前轮的标签与面板标题不写成历史轮次", () => {
    expect(formatRoundLabel(3, 3)).not.toBe("第 3 轮");
    expect(formatRoundPanelHeading(3, 3)).not.toBe("第 3 轮");
  });

  it("@scenario S-R237511DT-01-current 没有卡点时卡点行明确写无", () => {
    expect(formatRoundBlockerLine(roundOne)).toBe("卡点：无");
  });

  it("@scenario S-R237511DT-01-history 第 2 轮显示自己的触发原因与本轮费用", () => {
    expect(formatRoundLabel(2, 3)).toBe("第 2 轮");
    expect(formatRoundPanelHeading(2, 3)).toBe("第 2 轮");
    expect(formatRoundTriggerLine(roundTwo)).toBe("触发原因：返工");
    expect(formatRoundCostValue(roundTwo, 3)).toBe("$0.96（本需求第 2 轮）");
  });

  it("@scenario S-R237511DT-01-history 第 2 轮的本轮费用与全部轮次累计费用是两个数", () => {
    const roundCost = formatRoundCostValue(roundTwo, 3);
    const totalCost = formatTotalCostValue(threeRounds.totalCostUsd);

    expect(roundCost).not.toBe(totalCost);
    expect(roundCost).toContain("本需求第 2 轮");
    expect(totalCost).toContain("本需求全部轮次");
  });

  it("@scenario S-R237511DT-01-waiting 阶段还在进行时结果行说明尚未产生", () => {
    expect(formatRoundResultLine(pendingRound)).toBe("本轮结果尚未产生，将自动刷新");
  });

  it("@scenario S-R237511DT-01-waiting 尚未产生的结果不被写成零项通过或已完成", () => {
    expect(formatRoundResultLine(pendingRound)).not.toBe("已取得的结果：0 项验收已通过");
    expect(formatRoundResultLine(pendingRound)).not.toContain("已完成");
    expect(formatRoundResultLine(pendingRound)).toBe("本轮结果尚未产生，将自动刷新");
  });

  it("@scenario S-R237511DT-01-waiting 已经结束但零项结果的轮次与尚未产生是两个状态", () => {
    const concluded = round(3, { result: { state: "available", items: [] }, costUsd: 0.8 });

    expect(formatRoundResultLine(concluded)).toBe("已取得的结果：0 项验收已通过");
    expect(formatRoundResultLine(concluded)).not.toBe(formatRoundResultLine(pendingRound));
  });

  it("@scenario S-R237511DT-01-overlimit 超限时费用摘要给出金额、范围、已超限与工作仍继续", () => {
    const overRound = round(3, { costUsd: 12.4, result: { state: "pending" } });
    const over = snapshot([roundOne, roundTwo, overRound], 14.26, { costCeilingUsd: CEILING });
    const summary = [
      formatRoundCostValue(overRound, 3),
      formatLimitLine(over),
      formatLimitStateLine(over),
      formatWorkStateLine(over),
    ].join("；");

    expect(limitStateOf(over)).toBe("over");
    expect(summary).toBe("$12.40（本需求当前轮）；上限 $10.00；已超限；工作仍继续");
  });

  it("@scenario S-R237511DT-01-overlimit 超限不提已暂停", () => {
    const over = snapshot([round(1, { costUsd: 12.4 })], 12.4);

    expect(formatLimitStateLine(over)).not.toBeNull();
    expect(formatWorkStateLine(over)).not.toContain("已暂停");
    expect(formatLimitStateLine(over)).not.toContain("已暂停");
  });

  it("@scenario S-R237511DT-01-overlimit 恰好等于上限不算超限", () => {
    const atCeiling = snapshot([round(1, { costUsd: CEILING })], CEILING);

    expect(limitStateOf(atCeiling)).toBe("normal");
    expect(formatLimitStateLine(atCeiling)).toBeNull();
  });
});

describe("round selection and read state", () => {
  it("@scenario S-R237511DT-01-current 未选择轮次时显示当前轮", () => {
    const ready = loadInto(initialStoryProgressView(STORY), { kind: "progress", snapshot: threeRounds });

    expect(ready.status).toBe("ready");
    expect(selectedRoundOf(ready)).toEqual(roundThree);
  });

  it("@scenario S-R237511DT-01-history 主动选择第 2 轮后显示第 2 轮自己的记录", () => {
    const ready = loadInto(initialStoryProgressView(STORY), { kind: "progress", snapshot: threeRounds });
    const selected = act(ready, { type: "select", round: 2 });

    expect(selectedRoundOf(selected)).toEqual(roundTwo);
    expect(formatRoundTriggerLine(selectedRoundOf(selected)!)).toBe("触发原因：返工");
    expect(formatRoundResultLine(selectedRoundOf(selected)!)).toBe("已取得的结果：1 项验收已通过");
  });

  it("@scenario S-R237511DT-01-history 选择历史轮次不改变快照与全部轮次累计费用", () => {
    const ready = loadInto(initialStoryProgressView(STORY), { kind: "progress", snapshot: threeRounds });
    const selected = act(ready, { type: "select", round: 1 });

    expect(selected.snapshot).toBe(ready.snapshot);
    expect(selectedRoundOf(selected)).toEqual(roundOne);
    expect(formatTotalCostValue(selected.snapshot!.totalCostUsd)).toBe("$3.80（本需求全部轮次）");
    expect(selected.snapshot!.rounds).toHaveLength(3);
  });

  it("@scenario S-R237511DT-01-loading 刷新时保留原有内容与所选轮次", () => {
    const ready = loadInto(initialStoryProgressView(STORY), { kind: "progress", snapshot: threeRounds });
    const loading = act(ready, { type: "load" });

    expect(loading.status).toBe("loading");
    expect(loading.snapshot).toBe(ready.snapshot);
    expect(loading.selectedRoundId).toBe(ready.selectedRoundId);
    expect(selectedRoundOf(loading)).toEqual(roundThree);
  });

  it("@scenario S-R237511DT-01-loading 刷新期间选中的历史轮次不被切回当前轮", () => {
    const ready = loadInto(initialStoryProgressView(STORY), { kind: "progress", snapshot: threeRounds });
    const selected = act(ready, { type: "select", round: 2 });
    const loading = act(selected, { type: "load" });

    expect(loading.status).toBe("loading");
    expect(loading.selectedRoundId).toBe(2);
    expect(selectedRoundOf(loading)).toEqual(roundTwo);
  });

  it("@scenario S-R237511DT-01-loading 迟到的新结果不能顶掉更新的读取", () => {
    const ready = loadInto(initialStoryProgressView(STORY), { kind: "progress", snapshot: threeRounds });
    const loading = act(ready, { type: "load" });
    const stale = act(loading, {
      type: "loaded",
      requestId: ready.requestId,
      result: { kind: "progress", snapshot: snapshot([roundOne], 0.9) },
    });

    expect(stale.status).toBe("loading");
    expect(stale.snapshot).toBe(ready.snapshot);
    expect(stale.snapshot?.rounds).toHaveLength(3);
  });

  it("@scenario S-R237511DT-01-error 读取失败保留已读到的内容并进入失败状态", () => {
    const ready = loadInto(initialStoryProgressView(STORY), { kind: "progress", snapshot: threeRounds });
    const errored = act(ready, { type: "loaded", requestId: ready.requestId, result: { kind: "failed" } });

    expect(errored.status).toBe("error");
    expect(errored.snapshot).toBe(ready.snapshot);
    expect(errored.selectedRoundId).toBe(ready.selectedRoundId);
  });

  it("@scenario S-R237511DT-01-error 读取失败不写成当前轮的卡点", () => {
    const ready = loadInto(initialStoryProgressView(STORY), { kind: "progress", snapshot: threeRounds });
    const errored = act(ready, { type: "loaded", requestId: ready.requestId, result: { kind: "failed" } });
    const shown = selectedRoundOf(errored);

    expect(formatRoundBlockerLine(shown!)).toBe("卡点：1 项验收未通过");
    expect(formatRoundBlockerLine(shown!)).not.toContain("无法读取");
  });

  it("@scenario S-R237511DT-01-empty 读到没有轮次的需求时进入空状态", () => {
    const empty = loadInto(initialStoryProgressView(STORY), { kind: "empty", storyId: STORY });

    expect(empty.status).toBe("empty");
  });

  it("@scenario S-R237511DT-01-empty 没有轮次时不拿出阶段、结果、卡点或零美元费用", () => {
    const empty = loadInto(initialStoryProgressView(STORY), { kind: "empty", storyId: STORY });

    expect(empty.snapshot).toBeNull();
    expect(selectedRoundOf(empty)).toBeNull();
  });
});

describe("frozen screen copy", () => {
  it("@scenario S-R237511DT-01-empty 空状态的文案是当前还没有工作轮次并给出返回运行总览", () => {
    expect(STORY_PROGRESS_COPY.noRounds).toBe("当前还没有工作轮次");
    expect(STORY_PROGRESS_COPY.backToOverview).toBe("返回运行总览");
  });

  it("加载与失败状态的文案与冻结定义一致", () => {
    expect(STORY_PROGRESS_COPY.loading).toBe("正在读取当前轮与历史轮次");
    expect(STORY_PROGRESS_COPY.failed).toBe("无法读取需求进展");
    expect(STORY_PROGRESS_COPY.retry).toBe("重新读取");
  });

  it("需求详情各分区的文案与冻结定义一致", () => {
    expect(STORY_PROGRESS_COPY.currentRoundTab).toBe("当前轮");
    expect(STORY_PROGRESS_COPY.roundSwitcherHeading).toBe("轮次切换与历史");
    expect(STORY_PROGRESS_COPY.historyHeading).toBe("历史轮次");
    expect(STORY_PROGRESS_COPY.currentRoundPanelHeading).toBe("当前轮阶段与结果");
    expect(STORY_PROGRESS_COPY.roundCostHeading).toBe("本轮费用");
    expect(STORY_PROGRESS_COPY.totalCostHeading).toBe("累计费用");
  });

  it("进展接口路径是只读的需求进展接口", () => {
    expect(STORY_PROGRESS_API_PATH).toBe("/api/stories/:storyId/progress");
  });
});
