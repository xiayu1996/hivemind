/**
 * The work-record screen's sample source.
 *
 * The console is mounted by whatever process holds the central store, and a
 * verification round opens the screen before any such store exists on that
 * machine. Serving nothing would render every scenario as the empty state, and
 * the four states it has to tell apart would be indistinguishable. The records
 * below are the ones the frozen definition of done names: works of more than one
 * role inside the last day, one stopped with an error and a redacted-away token,
 * and one engineer work that is still being written -- it starts with the two
 * steps already on the record and gains the closing step only while the detail
 * is watched, so "the rest arrives by itself" is something a round can see
 * rather than read. They are data, not a fixture of the reader: the reader still
 * does every query, ordering, run-isolation and redaction itself.
 */
import {
  createWorkRecordReader,
  type WorkRecordReader,
  type WorkRecordSource,
  type WorkRecordRequirementRef,
  type WorkRecordSourceRun,
  type WorkRecordSourceStatus,
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

/** A running work whose remaining steps are written while it is watched. */
interface LivePlan {
  /** Steps already written when a person opens the record. */
  initialSteps: number;
  /** How long after opening the closing step is written. */
  revealEveryMs: number;
}

type RunOutcome =
  | { kind: "running"; refreshAfterMs: number; live?: LivePlan }
  | { kind: "stopped"; outcome: "completed" | "error" | "stopped" };

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
    runId: "run-engineer-optimization",
    role: ENGINEER_ROLE,
    name: "周期性优化",
    requirement: WORKING_REQUIREMENT,
    start: [10, 5, 12],
    outcome: { kind: "running", refreshAfterMs: 5_000, live: { initialSteps: 2, revealEveryMs: 8_000 } },
    steps: [
      { kind: "start", clock: [10, 5, 12], text: "读取当前任务" },
      { kind: "action", clock: [10, 6, 30], text: "检查控制台可用性" },
      { kind: "stop", clock: [10, 7, 30], text: "本轮优化完成" },
    ],
  },
  {
    runId: "run-todo-sync",
    role: ENGINEER_ROLE,
    name: "同步任务",
    requirement: ENGINEER_REQUIREMENT,
    start: [9, 18, 0],
    outcome: { kind: "running", refreshAfterMs: 5_000 },
    steps: [
      { kind: "start", clock: [9, 18, 0], text: "开始同步待办处理结果" },
      { kind: "action", clock: [9, 18, 45], text: `检测到 ${SAMPLE_KEYWORD}，准备重试` },
      { kind: "action", clock: [9, 19, 30], text: "等待下一步结果" },
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
      { kind: "action", clock: [16, 6, 30], text: "补充控制台的操作提示" },
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

/** How many steps a watch has revealed, given when it began. */
function revealedSteps(plan: LivePlan, total: number, watchedSince: number, now: number): number {
  const elapsed = Math.max(0, now - watchedSince);
  return Math.min(total, plan.initialSteps + Math.floor(elapsed / plan.revealEveryMs));
}

/**
 * One run as it stands at `now`.
 *
 * A stopped run always shows every step it wrote. A running run shows them as
 * the source declares while nobody is looking; watched in detail, it is written
 * a step at a time and stops on its closing step. `watchedSince` is undefined
 * unless this run is the one a detail read asked for, which is what keeps the
 * list showing a running work as running.
 */
function materialise(
  spec: RunSpec,
  now: number,
  watchedSince: number | undefined,
): { run: WorkRecordSourceRun; steps: readonly WorkRecordSourceStep[] } {
  const start = mostRecentClock(now, ...spec.start);
  const written: WorkRecordSourceStep[] = spec.steps.map((step, index) => ({
    runId: spec.runId,
    sequence: index + 1,
    occurredAt: mostRecentClock(now, ...step.clock),
    kind: step.kind,
    text: step.text,
    visibility: step.visibility ?? "display",
  }));
  const last = written.at(-1);
  const identity = {
    runId: spec.runId,
    role: spec.role,
    name: spec.name,
    requirement: spec.requirement,
    startedAt: start,
  };
  if (spec.outcome.kind === "stopped") {
    return {
      run: { ...identity, status: { kind: "stopped", outcome: spec.outcome.outcome, stoppedAt: last?.occurredAt ?? start } },
      steps: written,
    };
  }
  const plan = spec.outcome.live;
  const running: WorkRecordSourceStatus = { kind: "running", refreshAfterMs: spec.outcome.refreshAfterMs };
  if (plan === undefined) {
    return { run: { ...identity, status: running }, steps: written };
  }
  if (watchedSince === undefined) {
    // The list speaks about the work as it stood when the person opened the
    // screen: the closing step is part of what watching reveals, not part of
    // what the record already held.
    return { run: { ...identity, status: running }, steps: written.slice(0, plan.initialSteps) };
  }
  const exposed = revealedSteps(plan, written.length, watchedSince, now);
  if (exposed >= written.length) {
    return {
      run: { ...identity, status: { kind: "stopped", outcome: "completed", stoppedAt: last?.occurredAt ?? start } },
      steps: written,
    };
  }
  return { run: { ...identity, status: running }, steps: written.slice(0, exposed) };
}

/** The sample source, with the two views a round needs to tell apart. */
export interface SampleWorkRecordSource extends WorkRecordSource {
  /** Browse: every run keeps the result it declares. */
  browse(): void;
  /**
   * Show one run in detail. `fresh` marks the read that starts a look at the
   * record rather than a poll continuing one, and only a fresh look restarts a
   * watch that already ran to its end.
   */
  watch(runId: string, fresh: boolean): void;
}

/**
 * A read-only source over the sample records.
 *
 * A real store writes its records as the work happens; this one has no writer,
 * so a watched detail is what makes a running work advance. The clock is a
 * number for a test that wants one fixed instant, or a function for the console,
 * which keeps serving while people are looking at it.
 */
export function createSampleWorkRecordSource(clock: number | (() => number)): SampleWorkRecordSource {
  const now = typeof clock === "function" ? clock : () => clock;
  const watchedSince = new Map<string, number>();
  let detailRunId: string | null = null;
  const since = (spec: RunSpec): number | undefined =>
    detailRunId === spec.runId ? watchedSince.get(spec.runId) : undefined;
  return {
    browse: () => { detailRunId = null; },
    watch: (runId, fresh) => {
      detailRunId = runId;
      const spec = RUN_SPECS.find((entry) => entry.runId === runId);
      const plan = spec?.outcome.kind === "running" ? spec.outcome.live : undefined;
      if (spec === undefined || plan === undefined) return;
      const at = now();
      const existing = watchedSince.get(runId);
      if (existing === undefined) {
        watchedSince.set(runId, at);
        return;
      }
      // Looking at the record again after the last watch ran to its end starts
      // over, so the person sees work in progress rather than the finished one.
      // A poll that continues the same look must not: it would reset the very
      // watch whose closing step it is asking for.
      if (fresh && revealedSteps(plan, spec.steps.length, existing, at) >= spec.steps.length) {
        watchedSince.set(runId, at);
      }
    },
    loadRuns: async () => RUN_SPECS.map((spec) => materialise(spec, now(), since(spec)).run),
    loadSteps: async (runId, afterSequence) => {
      const spec = RUN_SPECS.find((entry) => entry.runId === runId);
      if (spec === undefined) return [];
      return materialise(spec, now(), since(spec)).steps
        .filter((step) => afterSequence === undefined || step.sequence > afterSequence);
    },
  };
}

/** The reader the console serves `/records` and its read-only API from. */
export function createSampleWorkRecordReader(clock: number | (() => number)): WorkRecordReader {
  const source = createSampleWorkRecordSource(clock);
  const reader = createWorkRecordReader(source);
  return {
    // A search is a browse: what it returns is every run's declared result, so
    // the list states a running work as running however the detail was watched.
    search: (query) => {
      source.browse();
      return reader.search(query);
    },
    read: (query) => {
      source.watch(query.runId, query.afterSequence === undefined);
      return reader.read(query);
    },
  };
}
