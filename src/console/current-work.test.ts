import { describe, expect, it } from "vitest";
import {
  currentWorkDetailPath,
  type RequirementCurrentWorkDetail,
  type RunningOverviewEntry,
  type TaskCurrentWorkDetail,
} from "./current-work-contracts.js";
import {
  detailPath,
  initialCurrentWorkDetailView,
  reduceCurrentWorkDetailView,
  type CurrentWorkDetailDto,
  type RunningEntryDto,
} from "../../console-ui/src/pages/current-work/contracts.js";

const NOW = 1_700_000_000_000;
const REQUIREMENT_ID = "R-237511dd5162";
const CARD_ID = "S-R237511DT-02";

const requirementDetail: RequirementCurrentWorkDetail = {
  kind: "requirement",
  requirementId: REQUIREMENT_ID,
  title: "Hivemind 的 web 管理后台",
  state: "running",
  currentRound: {
    round: 3,
    phase: "绘制原型",
    results: [{ resultId: "approved-direction", text: "页面清单与浅色运行控制台方向已批准" }],
    blockers: [{ blockerId: "prototype-gate", text: "等待原型出口检查" }],
    costUsd: 3.84,
    startedAt: NOW,
  },
  historicalRounds: [
    { round: 1, phase: "澄清需求", trigger: "first_run" },
    { round: 2, phase: "确定方案", trigger: "rework" },
  ],
  tasks: [
    {
      kind: "task",
      cardId: CARD_ID,
      requirementId: REQUIREMENT_ID,
      title: "费用投影核对",
      state: "running",
    },
  ],
  generatedAt: NOW + 1,
};

const taskDetail: TaskCurrentWorkDetail = {
  kind: "task",
  cardId: CARD_ID,
  title: "费用投影核对",
  state: "running",
  currentRound: {
    round: 3,
    phase: "编写改动",
    results: [
      { resultId: "accepted-1", text: "费用范围已核对" },
      { resultId: "accepted-2", text: "美元金额已核对" },
    ],
    blockers: [{ blockerId: "cost-basis", text: "费用口径仍有 1 项待核对" }],
    costUsd: 1.24,
    startedAt: NOW,
  },
  historicalRounds: [
    { round: 1, phase: "明确范围", trigger: "first_run" },
    { round: 2, phase: "返工", trigger: "rework" },
  ],
  parentRequirement: {
    requirementId: REQUIREMENT_ID,
    title: "Hivemind 的 web 管理后台",
  },
  generatedAt: NOW + 1,
};

function asDto(detail: RequirementCurrentWorkDetail | TaskCurrentWorkDetail): CurrentWorkDetailDto {
  return detail;
}

function load(detail: CurrentWorkDetailDto) {
  const initial = initialCurrentWorkDetailView();
  const loading = reduceCurrentWorkDetailView(initial, { type: "load" });
  return reduceCurrentWorkDetailView(loading, {
    type: "loaded",
    requestId: loading.requestId,
    result: { kind: "ok", detail },
  });
}

describe("current work navigation contract", () => {
  it("@scenario S-R237511DT-03-overview 运行中的需求和任务各自进入对应详情", () => {
    const entries: RunningOverviewEntry[] = [
      {
        kind: "requirement",
        requirementId: REQUIREMENT_ID,
        title: "Hivemind 的 web 管理后台",
        state: "running",
        phase: "绘制原型",
      },
      {
        kind: "task",
        cardId: CARD_ID,
        requirementId: REQUIREMENT_ID,
        title: "费用投影核对",
        state: "running",
        phase: "编写改动",
      },
    ];

    expect(entries.map((entry) => [entry.title, entry.kind])).toEqual([
      ["Hivemind 的 web 管理后台", "requirement"],
      ["费用投影核对", "task"],
    ]);
    expect(entries.map(currentWorkDetailPath)).toEqual([
      "/requirements/R-237511dd5162/detail",
      "/stories/S-R237511DT-02/detail",
    ]);
  });

  it("@scenario S-R237511DT-03-overview 任务标题和身份不会由内部编号推断", () => {
    const entry: RunningEntryDto = {
      kind: "task",
      cardId: CARD_ID,
      requirementId: REQUIREMENT_ID,
      title: "费用投影核对",
      state: "running",
      phase: "编写改动",
    };

    expect(entry.title).toBe("费用投影核对");
    expect(entry.title).not.toBe(CARD_ID);
    expect(entry.kind).toBe("task");
    expect(detailPath(entry)).toBe("/stories/S-R237511DT-02/detail");
  });

  it("@scenario S-R237511DT-03-requirement 需求详情初始选择当前轮且不展开历史", () => {
    const initial = initialCurrentWorkDetailView();

    expect(initial.selectedRound).toBeNull();
    expect(initial.historyExpanded).toBe(false);

    const ready = load(asDto(requirementDetail));
    expect(ready.status).toBe("ready");
    expect(ready.detail).toEqual(requirementDetail);
    expect(ready.selectedRound).toBeNull();
    expect(ready.historyExpanded).toBe(false);
  });

  it("@scenario S-R237511DT-03-requirement 默认需求内容只有当前轮摘要而不混入历史正文或工作记录", () => {
    const ready = load(asDto(requirementDetail));
    const visible = ready.detail;

    expect(visible?.title).toBe("Hivemind 的 web 管理后台");
    expect(visible?.kind).toBe("requirement");
    expect(visible?.currentRound).toMatchObject({
      round: 3,
      phase: "绘制原型",
      results: [{ text: "页面清单与浅色运行控制台方向已批准" }],
      blockers: [{ text: "等待原型出口检查" }],
      costUsd: 3.84,
    });
    expect(visible).not.toHaveProperty("taskDescription");
    expect(visible).not.toHaveProperty("workRecords");
    expect(ready.historyExpanded).toBe(false);
  });

  it("@scenario S-R237511DT-03-task 任务详情初始显示第 3 轮阶段、两项结果、卡点和美元费用", () => {
    const ready = load(asDto(taskDetail));

    expect(ready.status).toBe("ready");
    expect(ready.selectedRound).toBeNull();
    expect(ready.detail).toMatchObject({
      kind: "task",
      title: "费用投影核对",
      currentRound: {
        round: 3,
        phase: "编写改动",
        results: [{ text: "费用范围已核对" }, { text: "美元金额已核对" }],
        blockers: [{ text: "费用口径仍有 1 项待核对" }],
        costUsd: 1.24,
      },
    });
  });

  it("@scenario S-R237511DT-03-task 任务详情不以需求身份或内部编号呈现且默认不混入详细记录", () => {
    const ready = load(asDto(taskDetail));

    expect(ready.detail?.kind).toBe("task");
    expect(ready.detail?.title).toBe("费用投影核对");
    expect(ready.detail?.title).not.toBe(CARD_ID);
    expect(ready.detail).not.toHaveProperty("taskDescription");
    expect(ready.detail).not.toHaveProperty("workRecords");
    expect(ready.historyExpanded).toBe(false);
    expect(detailPath({
      kind: "task",
      cardId: CARD_ID,
      requirementId: REQUIREMENT_ID,
      title: taskDetail.title,
      state: taskDetail.state,
      phase: taskDetail.currentRound.phase,
    })).toBe("/stories/S-R237511DT-02/detail");
  });

  it("@scenario S-R237511DT-03-taskentry 需求详情列出所属运行中任务并进入任务详情", () => {
    const ready = load(asDto(requirementDetail));
    const task = ready.detail?.kind === "requirement" ? ready.detail.tasks[0] : undefined;

    expect(task).toEqual({
      kind: "task",
      cardId: CARD_ID,
      requirementId: REQUIREMENT_ID,
      title: "费用投影核对",
      state: "running",
    });
    expect(task && currentWorkDetailPath(task)).toBe("/stories/S-R237511DT-02/detail");
  });

  it("@scenario S-R237511DT-03-taskentry 所属任务入口不会停在需求详情", () => {
    const task = requirementDetail.tasks[0]!;
    const taskRoute = currentWorkDetailPath(task);

    expect(task.kind).toBe("task");
    expect(task.title).toBe("费用投影核对");
    expect(taskRoute).toBe("/stories/S-R237511DT-02/detail");
    expect(taskRoute).not.toBe("/requirements/R-237511dd5162/detail");
  });
});

describe("current work refresh boundary", () => {
  it("@scenario S-R237511DT-03-requirement 迟到的读取不能覆盖较新的当前轮", () => {
    const initial = initialCurrentWorkDetailView();
    const first = reduceCurrentWorkDetailView(initial, { type: "load" });
    const second = reduceCurrentWorkDetailView(first, { type: "load" });
    const stale = reduceCurrentWorkDetailView(second, {
      type: "loaded",
      requestId: first.requestId,
      result: { kind: "ok", detail: asDto(requirementDetail) },
    });

    expect(stale.status).toBe("loading");
    expect(stale.requestId).toBe(second.requestId);
    expect(stale.detail).toBeNull();
  });
});
