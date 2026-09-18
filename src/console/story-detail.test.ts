import { describe, expect, it } from "vitest";
import { classifyRoundStart, currentRound, roundByNumber } from "./story-detail.js";
import {
  STORY_DETAIL_COPY,
  createStoryDetailHttpPort,
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
  type StoryDetailReadResult,
  type StoryDetailSnapshotDto,
  type StoryRoundAcceptanceDto,
  type StoryRoundDto,
  type StoryDetailViewState,
} from "../../console-ui/src/pages/detail/contracts.js";

const CARD = "S-R237511DT-02";

function passed(scenarioId: string, text: string): StoryRoundAcceptanceDto {
  return { scenarioId, text, outcome: "passed" };
}

function failed(scenarioId: string, text: string): StoryRoundAcceptanceDto {
  return { scenarioId, text, outcome: "failed" };
}

function dtoRound(round: number, overrides: Partial<StoryRoundDto> = {}): StoryRoundDto {
  return {
    round,
    trigger: "first_run",
    triggerNote: null,
    phase: "CODE",
    startedAt: 1_700_000_000_000 + round,
    endedAt: 1_700_000_100_000 + round,
    resultPending: false,
    acceptance: [],
    costUsd: 0,
    ...overrides,
  };
}

function dtoSnapshot(rounds: readonly StoryRoundDto[], totalCostUsd: number): StoryDetailSnapshotDto {
  return { cardId: CARD, title: "费用投影核对", state: "MERGE", rounds, totalCostUsd, generatedAt: 1_700_000_200_000 };
}

const roundOne = dtoRound(1, {
  trigger: "first_run",
  phase: "SHAPE",
  costUsd: 0.9,
  acceptance: [passed("S-R237511DT-02-alpha", "首轮验收")],
});
const roundTwo = dtoRound(2, {
  trigger: "rework",
  triggerNote: "请把这句话改掉",
  phase: "CODE",
  costUsd: 0.96,
  acceptance: [passed("S-R237511DT-02-beta", "返工验收")],
});
const roundThree = dtoRound(3, {
  trigger: "restart",
  phase: "CODE",
  costUsd: 1.24,
  acceptance: [
    passed("S-R237511DT-02-gamma", "当前轮验收一"),
    passed("S-R237511DT-02-delta", "当前轮验收二"),
    failed("S-R237511DT-02-epsilon", "当前轮验收三"),
  ],
});
const threeRounds = dtoSnapshot([roundOne, roundTwo, roundThree], 3.8);

/** Brings a view from its initial state to a settled one, whichever request
 * number the reducer assigns to a load. */
function loadInto(state: StoryDetailViewState, result: StoryDetailReadResult): StoryDetailViewState {
  const loading = reduceStoryDetailView(state, { type: "load" });
  return reduceStoryDetailView(loading, { type: "loaded", requestId: loading.requestId, result });
}

describe("round start classification", () => {
  it("@scenario S-R237511DT-02-current 没有被拒结论时第 2 轮之后由人推动记为重新开始", () => {
    const start = classifyRoundStart({
      round: 3,
      feedbackChannel: null,
      feedbackBody: null,
      refusedPreviousResult: false,
      humanRestart: true,
    });

    expect(start).toEqual({ trigger: "restart", note: null });
  });

  it("@scenario S-R237511DT-02-history 返工评论让该轮记为返工并保留人的原话", () => {
    const start = classifyRoundStart({
      round: 2,
      feedbackChannel: "rework",
      feedbackBody: "这段把费用和用量写混了，请分开",
      refusedPreviousResult: true,
      humanRestart: false,
    });

    expect(start).toEqual({ trigger: "rework", note: "这段把费用和用量写混了，请分开" });
  });

  it("@scenario S-R237511DT-02-history 被拒结果在没有评论时也记为返工", () => {
    const start = classifyRoundStart({
      round: 2,
      feedbackChannel: null,
      feedbackBody: null,
      refusedPreviousResult: true,
      humanRestart: false,
    });

    expect(start).toEqual({ trigger: "rework", note: null });
  });

  it("@scenario S-R237511DT-02-history 第 1 轮始终记为首次执行", () => {
    const start = classifyRoundStart({
      round: 1,
      feedbackChannel: null,
      feedbackBody: null,
      refusedPreviousResult: false,
      humanRestart: false,
    });

    expect(start).toEqual({ trigger: "first_run", note: null });
  });
});

describe("round lookup", () => {
  it("@scenario S-R237511DT-02-current 当前轮是快照里的最后一个轮次", () => {
    expect(currentRound(threeRounds)).toEqual(roundThree);
  });

  it("@scenario S-R237511DT-02-history 按轮次号取到的是那一轮自己的记录", () => {
    expect(roundByNumber(threeRounds, 2)).toEqual(roundTwo);
  });

  it("@scenario S-R237511DT-02-history 不存在的轮次号不返回任何轮次", () => {
    expect(roundByNumber(threeRounds, 9)).toBeNull();
    expect(currentRound(dtoSnapshot([], 0))).toBeNull();
  });
});

describe("round copy", () => {
  it("@scenario S-R237511DT-02-current 当前轮的触发原因、阶段、结果、卡点与费用按口径成句", () => {
    expect(formatRoundTriggerLine(roundThree)).toBe("触发原因：重新开始");
    expect(formatRoundPhaseLine(roundThree)).toBe("阶段：CODE");
    expect(formatRoundResultLine(roundThree)).toBe("已取得的结果：2 项验收已通过");
    expect(formatRoundBlockerLine(roundThree)).toBe("卡点：1 项验收未通过");
    expect(formatRoundCostValue(roundThree, 3)).toBe("$1.24（本任务当前轮）");
    expect(formatTotalCostValue(threeRounds.totalCostUsd)).toBe("$3.80（本任务全部轮次）");
    expect(formatRoundLabel(3, 3)).toBe("当前轮");
    expect(formatRoundPanelHeading(3, 3)).toBe("当前轮阶段与结果");
  });

  it("@scenario S-R237511DT-02-current 当前轮的标签与面板标题不写成历史轮次", () => {
    expect(formatRoundLabel(3, 3)).not.toBe("第 3 轮");
    expect(formatRoundPanelHeading(3, 3)).not.toBe("第 3 轮");
  });

  it("@scenario S-R237511DT-02-history 第 2 轮显示自己的触发原因与本轮费用", () => {
    expect(formatRoundLabel(2, 3)).toBe("第 2 轮");
    expect(formatRoundPanelHeading(2, 3)).toBe("第 2 轮");
    expect(formatRoundTriggerLine(roundTwo)).toBe("触发原因：返工");
    expect(formatRoundCostValue(roundTwo, 3)).toBe("$0.96（本任务第 2 轮）");
  });

  it("@scenario S-R237511DT-02-history 第 2 轮的本轮费用与全部轮次累计费用是两个数", () => {
    const roundCost = formatRoundCostValue(roundTwo, 3);
    const totalCost = formatTotalCostValue(threeRounds.totalCostUsd);

    expect(roundCost).not.toBe(totalCost);
    expect(roundCost).toContain("本任务第 2 轮");
    expect(totalCost).toContain("本任务全部轮次");
  });

  it("@scenario S-R237511DT-02-waiting 阶段还在进行时结果行说明尚未产生", () => {
    const pending = dtoRound(3, { resultPending: true, phase: "CODE", costUsd: 1.24 });

    expect(formatRoundResultLine(pending)).toBe("本轮结果尚未产生，将自动刷新");
  });

  it("@scenario S-R237511DT-02-waiting 尚未产生的结果不被写成零项通过", () => {
    const pending = dtoRound(3, { resultPending: true, acceptance: [] });

    expect(formatRoundResultLine(pending)).not.toBe("已取得的结果：0 项验收已通过");
    expect(formatRoundResultLine(pending)).not.toContain("已完成");
    expect(formatRoundResultLine(pending)).toBe("本轮结果尚未产生，将自动刷新");
  });
});

describe("round selection and read state", () => {
  it("@scenario S-R237511DT-02-current 未选择轮次时显示的是当前轮", () => {
    const ready = loadInto(initialStoryDetailView(CARD), { kind: "ok", snapshot: threeRounds });

    expect(ready.status).toBe("ready");
    expect(selectedRoundOf(ready)).toEqual(roundThree);
  });

  it("@scenario S-R237511DT-02-history 主动选择第 2 轮后显示第 2 轮自己的记录", () => {
    const ready = loadInto(initialStoryDetailView(CARD), { kind: "ok", snapshot: threeRounds });
    const selected = reduceStoryDetailView(ready, { type: "select", round: 2 });

    expect(selectedRoundOf(selected)).toEqual(roundTwo);
    expect(formatRoundTriggerLine(selectedRoundOf(selected)!)).toBe("触发原因：返工");
    expect(formatRoundResultLine(selectedRoundOf(selected)!)).toBe("已取得的结果：1 项验收已通过");
  });

  it("@scenario S-R237511DT-02-history 选择历史轮次不改变快照与全部轮次累计费用", () => {
    const ready = loadInto(initialStoryDetailView(CARD), { kind: "ok", snapshot: threeRounds });
    const selected = reduceStoryDetailView(ready, { type: "select", round: 1 });

    expect(selected.snapshot).toBe(ready.snapshot);
    expect(selectedRoundOf(selected)).toEqual(roundOne);
    expect(formatTotalCostValue(selected.snapshot!.totalCostUsd)).toBe("$3.80（本任务全部轮次）");
    expect(selected.snapshot!.rounds).toHaveLength(3);
  });

  it("@scenario S-R237511DT-02-loading 刷新时保留原有内容与所选轮次", () => {
    const ready = loadInto(initialStoryDetailView(CARD), { kind: "ok", snapshot: threeRounds });
    const loading = reduceStoryDetailView(ready, { type: "load" });

    expect(loading.status).toBe("loading");
    expect(loading.snapshot).toBe(ready.snapshot);
    expect(loading.selectedRound).toBe(ready.selectedRound);
    expect(selectedRoundOf(loading)).toEqual(roundThree);
  });

  it("@scenario S-R237511DT-02-loading 刷新期间选中的历史轮次不被切回当前轮", () => {
    const ready = loadInto(initialStoryDetailView(CARD), { kind: "ok", snapshot: threeRounds });
    const selected = reduceStoryDetailView(ready, { type: "select", round: 2 });
    const loading = reduceStoryDetailView(selected, { type: "load" });

    expect(loading.status).toBe("loading");
    expect(loading.selectedRound).toBe(2);
    expect(selectedRoundOf(loading)).toEqual(roundTwo);
  });

  it("@scenario S-R237511DT-02-loading 迟到的新结果不能顶掉更新的读取", () => {
    const ready = loadInto(initialStoryDetailView(CARD), { kind: "ok", snapshot: threeRounds });
    const loading = reduceStoryDetailView(ready, { type: "load" });
    const stale = reduceStoryDetailView(loading, {
      type: "loaded",
      requestId: ready.requestId,
      result: { kind: "ok", snapshot: dtoSnapshot([], 0) },
    });

    expect(stale.status).toBe("loading");
    expect(stale.snapshot).toBe(ready.snapshot);
    expect(stale.snapshot?.rounds).toHaveLength(3);
  });

  it("@scenario S-R237511DT-02-error 读取失败保留已读到的内容并进入失败状态", () => {
    const ready = loadInto(initialStoryDetailView(CARD), { kind: "ok", snapshot: threeRounds });
    const errored = reduceStoryDetailView(ready, { type: "failed", requestId: ready.requestId });

    expect(errored.status).toBe("error");
    expect(errored.snapshot).toBe(ready.snapshot);
    expect(errored.selectedRound).toBe(ready.selectedRound);
  });

  it("@scenario S-R237511DT-02-error 读取失败不写成当前轮的卡点", () => {
    const ready = loadInto(initialStoryDetailView(CARD), { kind: "ok", snapshot: threeRounds });
    const errored = reduceStoryDetailView(ready, { type: "failed", requestId: ready.requestId });
    const shown = selectedRoundOf(errored);

    expect(formatRoundBlockerLine(shown!)).toBe("卡点：1 项验收未通过");
    expect(formatRoundBlockerLine(shown!)).not.toContain("无法读取");
  });

  it("@scenario S-R237511DT-02-empty 读到没有轮次的任务时进入空状态", () => {
    const empty = loadInto(initialStoryDetailView(CARD), { kind: "ok", snapshot: dtoSnapshot([], 0) });

    expect(empty.status).toBe("empty");
    expect(empty.snapshot?.rounds).toEqual([]);
  });

  it("@scenario S-R237511DT-02-empty 没有轮次时不拿出阶段、结果、卡点或零美元费用", () => {
    const empty = loadInto(initialStoryDetailView(CARD), { kind: "ok", snapshot: dtoSnapshot([], 0) });

    expect(currentRoundOf(empty.snapshot)).toBeNull();
    expect(selectedRoundOf(empty)).toBeNull();
  });
});

describe("frozen screen copy", () => {
  it("空、加载与失败状态的字面文案与冻结定义一致", () => {
    expect(STORY_DETAIL_COPY.noRounds).toBe("当前还没有工作轮次");
    expect(STORY_DETAIL_COPY.backToOverview).toBe("返回运行总览");
    expect(STORY_DETAIL_COPY.loading).toBe("正在读取当前轮与历史轮次");
    expect(STORY_DETAIL_COPY.failed).toBe("无法读取任务进展");
    expect(STORY_DETAIL_COPY.retry).toBe("重新读取");
  });

  it("当前轮与历史轮次的分区标题与冻结定义一致", () => {
    expect(STORY_DETAIL_COPY.currentRoundTab).toBe("当前轮");
    expect(STORY_DETAIL_COPY.roundSwitcherHeading).toBe("轮次切换与历史");
    expect(STORY_DETAIL_COPY.historyHeading).toBe("历史轮次");
    expect(STORY_DETAIL_COPY.currentRoundPanelHeading).toBe("当前轮阶段与结果");
    expect(STORY_DETAIL_COPY.roundCostHeading).toBe("本轮费用");
    expect(STORY_DETAIL_COPY.totalCostHeading).toBe("累计费用");
  });
});

describe("detail read boundary", () => {
  it("@scenario S-R237511DT-02-current 读取接口把 200 的正文当成任务快照", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify(threeRounds), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const port = createStoryDetailHttpPort(fetchImpl);

    const result = await port.readStoryDetail(CARD);

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.snapshot.rounds).toHaveLength(3);
    expect(result.snapshot.totalCostUsd).toBeCloseTo(3.8, 6);
  });

  it("@scenario S-R237511DT-02-error 读取接口的非 200 响应是读取失败而不是快照", async () => {
    const fetchImpl = (async () => new Response(null, { status: 500 })) as unknown as typeof fetch;
    const port = createStoryDetailHttpPort(fetchImpl);

    await expect(port.readStoryDetail(CARD)).resolves.toEqual({ kind: "failed" });
  });

  it("@scenario S-R237511DT-02-error 读取接口抛错时也是读取失败", async () => {
    const fetchImpl = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    const port = createStoryDetailHttpPort(fetchImpl);

    await expect(port.readStoryDetail(CARD)).resolves.toEqual({ kind: "failed" });
  });
});
