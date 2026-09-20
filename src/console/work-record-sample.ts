/**
 * The work-record screen's sample source.
 *
 * The console is mounted by whatever process holds the central store, and a
 * verification round opens the screen before any such store exists on that
 * machine. Serving nothing would render every scenario as the empty state, and
 * the four states it has to tell apart would be indistinguishable. The records
 * below are the ones the frozen definition of done names: a failed work with a
 * redacted-away token, a finished work, one still running, and one that does
 * not match the keyword. They are data, not a fixture of the reader: the
 * reader still does every query, ordering, run-isolation and redaction itself.
 */
import {
  createWorkRecordReader,
  type WorkRecordReader,
  type WorkRecordSource,
  type WorkRecordRequirementRef,
  type WorkRecordSourceRun,
  type WorkRecordSourceStep,
} from "../observability/work-record-reader.js";

const DAY_MS = 24 * 60 * 60 * 1_000;

const PROTOTYPE_ROLE = "prototype";
const ENGINEER_ROLE = "engineer";

const PROTOTYPE_REQUIREMENT: WorkRecordRequirementRef = {
  id: "R-237511dd5162",
  title: "Hivemind 的 web 管理后台",
};
const ENGINEER_REQUIREMENT: WorkRecordRequirementRef = {
  id: "R-237511MB",
  title: "Notion 同步修复",
};
const WORKING_REQUIREMENT: WorkRecordRequirementRef = {
  id: "R-237511OV",
  title: "控制台可用性",
};

/** The sentence the definition of done uses to say a keyword was found. */
export const SAMPLE_KEYWORD = "Notion 保存失败";

/**
 * The most recent instant whose UTC clock reads `hour:minute:second`.
 *
 * Sample steps have to display a fixed clock time and still fall inside a
 * search window that ends now, and the page renders clock times in UTC. Anchoring
 * each step to the most recent occurrence of its own clock value keeps both
 * true whatever hour the console is started at.
 */
function mostRecentClock(now: number, hour: number, minute: number, second: number): number {
  const at = new Date(now);
  const todays = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), hour, minute, second);
  return todays <= now ? todays : todays - DAY_MS;
}

interface StepSpec {
  kind: WorkRecordSourceStep["kind"];
  clock: [number, number, number];
  text: string;
  visibility?: WorkRecordSourceStep["visibility"];
}

type RunOutcome = { kind: "running"; refreshAfterMs: number } | { kind: "stopped"; outcome: "completed" | "error" | "stopped" };

interface RunSpec {
  runId: string;
  role: string;
  name: string;
  requirement: WorkRecordRequirementRef;
  start: [number, number, number];
  outcome: RunOutcome;
  steps: readonly StepSpec[];
}

const RUN_SPECS: readonly RunSpec[] = [
  {
    runId: "run-prototype-exit",
    role: PROTOTYPE_ROLE,
    name: "原型出口修正",
    requirement: PROTOTYPE_REQUIREMENT,
    start: [10, 38, 12],
    outcome: { kind: "stopped", outcome: "error" },
    steps: [
      { kind: "start", clock: [10, 38, 12], text: "读取已批准的页面清单与场景" },
      { kind: "action", clock: [10, 38, 19], text: "检查既有原型契约：未找到" },
      { kind: "action", clock: [10, 39, 4], text: "形成操作型界面的设计计划" },
      { kind: "action", clock: [10, 40, 28], text: "写入待办处理页面" },
      { kind: "action", clock: [10, 41, 53], text: "模拟“批准并继续”结果" },
      { kind: "action", clock: [10, 42, 1], text: "提交处理结果到对应需求" },
      { kind: "error", clock: [10, 42, 3], text: `${SAMPLE_KEYWORD}：连接在确认前断开` },
      { kind: "action", clock: [10, 42, 3], text: "待办处理结果在 Notion 保存失败 后保持未处理" },
      { kind: "action", clock: [10, 42, 17], text: "准备可原样重试的结果，凭据 sk-live4f9c2b7a1d90 不写入记录" },
      { kind: "stop", clock: [10, 43, 6], text: "本轮停止，等待本人检查连接后重试" },
    ],
  },
  {
    runId: "run-todo-sync",
    role: ENGINEER_ROLE,
    name: "同步任务",
    requirement: ENGINEER_REQUIREMENT,
    start: [9, 18, 0],
    outcome: { kind: "stopped", outcome: "completed" },
    steps: [
      { kind: "start", clock: [9, 18, 0], text: "开始同步待办处理结果" },
      { kind: "action", clock: [9, 18, 45], text: `检测到 ${SAMPLE_KEYWORD}，准备重试` },
      { kind: "stop", clock: [9, 19, 30], text: "重试成功，待办结果保持未处理" },
    ],
  },
  {
    runId: "run-console-usability",
    role: PROTOTYPE_ROLE,
    name: "周期性优化",
    requirement: WORKING_REQUIREMENT,
    start: [16, 6, 0],
    outcome: { kind: "running", refreshAfterMs: 5_000 },
    steps: [
      { kind: "start", clock: [16, 6, 0], text: "开始检查控制台可用性" },
      { kind: "action", clock: [16, 6, 30], text: `补充 ${SAMPLE_KEYWORD} 的操作提示` },
      { kind: "action", clock: [16, 7, 0], text: "等待下一步结果" },
      {
        kind: "action",
        clock: [16, 7, 5],
        text: "authorization: Bearer eyJhbGciOiJIUzI1NiJ9.internal.transport",
        visibility: "internal_transport",
      },
    ],
  },
  {
    runId: "run-daily-cost",
    role: ENGINEER_ROLE,
    name: "每日费用汇总",
    requirement: { id: "R-237511CO", title: "费用分析" },
    start: [11, 5, 0],
    outcome: { kind: "stopped", outcome: "completed" },
    steps: [
      { kind: "start", clock: [11, 5, 0], text: "开始读取中央账本" },
      { kind: "stop", clock: [11, 5, 30], text: "每日费用汇总完成" },
    ],
  },
];

function materialise(spec: RunSpec, now: number): { run: WorkRecordSourceRun; steps: readonly WorkRecordSourceStep[] } {
  const start = mostRecentClock(now, ...spec.start);
  const steps: WorkRecordSourceStep[] = spec.steps.map((step, index) => ({
    runId: spec.runId,
    sequence: index + 1,
    occurredAt: mostRecentClock(now, ...step.clock),
    kind: step.kind,
    text: step.text,
    visibility: step.visibility ?? "display",
  }));
  const last = steps.at(-1);
  const status: WorkRecordSourceRun["status"] = spec.outcome.kind === "running"
    ? { kind: "running", refreshAfterMs: spec.outcome.refreshAfterMs }
    : { kind: "stopped", outcome: spec.outcome.outcome, stoppedAt: last?.occurredAt ?? start };
  return {
    run: {
      runId: spec.runId,
      role: spec.role,
      name: spec.name,
      requirement: spec.requirement,
      startedAt: start,
      status,
    },
    steps,
  };
}

/** A read-only source over the sample records, stable for one instant. */
export function createSampleWorkRecordSource(now: number): WorkRecordSource {
  const materialised = RUN_SPECS.map((spec) => materialise(spec, now));
  return {
    loadRuns: async () => materialised.map((entry) => entry.run),
    loadSteps: async (runId, afterSequence) => (materialised.find((entry) => entry.run.runId === runId)?.steps ?? [])
      .filter((step) => afterSequence === undefined || step.sequence > afterSequence),
  };
}

/** The reader the console serves `/records` and its read-only API from. */
export function createSampleWorkRecordReader(now: number): WorkRecordReader {
  return createWorkRecordReader(createSampleWorkRecordSource(now));
}
