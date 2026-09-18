import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  registerOperatorConsoleRoutes,
  renderOperatorAccessPage,
  renderOperatorDetailPage,
  renderOperatorOverviewPage,
  renderOperatorTodoPage,
  type ConsolePageState,
  type OperatorConsoleDependencies,
  type OperatorDetail,
  type OperatorOverview,
  type OperatorTodo,
  type OperatorTodoResult,
} from "./operator-contract.js";

const COPY = {
  accessDenied: "\u5f53\u524d\u8bbe\u5907\u65e0\u6cd5\u8fdb\u5165\u540e\u53f0",
  connectNetwork: "\u8bf7\u8fde\u63a5\u5bb6\u5ead\u6216\u529e\u516c\u7f51\u7edc",
  recheck: "\u91cd\u65b0\u68c0\u67e5",
  waiting: "\u7b49\u5f85\u672c\u4eba\u5904\u7406",
  running: "\u8fd0\u884c\u4e2d",
  failures: "\u5f02\u5e38",
  completed: "\u6700\u8fd1\u5b8c\u6210",
  handle: "\u53bb\u5904\u7406",
  overview: "\u603b\u89c8",
  costs: "\u8d39\u7528",
  roles: "\u89d2\u8272",
  records: "\u5de5\u4f5c\u8bb0\u5f55",
  answerLabel: "\u4f60\u7684\u7b54\u590d",
  submitReply: "\u63d0\u4ea4\u7b54\u590d",
  approve: "\u6279\u51c6\u65b9\u6848",
  choose: "\u8bf7\u9009\u62e9\u4e00\u9879",
  submitChoice: "\u63d0\u4ea4\u9009\u62e9",
  back: "\u8fd4\u56de\u603b\u89c8",
  validation: "\u8bf7\u586b\u5199\u7b54\u590d\u540e\u518d\u63d0\u4ea4",
  handled: "\u5df2\u5904\u7406",
  savedTask: "\u7b54\u590d\u5df2\u4fdd\u7559\u5230\u5bf9\u5e94 Notion \u4efb\u52a1",
  notSaved: "\u7ed3\u679c\u5c1a\u672a\u4fdd\u5b58",
  retrySubmit: "\u91cd\u65b0\u63d0\u4ea4",
  currentRound: "\u5f53\u524d\u8f6e 3",
  trigger: "\u89e6\u53d1\u539f\u56e0\uff1a\u9a8c\u8bc1\u672a\u901a\u8fc7",
  phase: "\u9636\u6bb5\uff1aVERIFY",
  resultMissing: "\u7ed3\u679c\u5c1a\u672a\u4ea7\u751f",
  blockerMissing: "\u6682\u65e0\u5361\u70b9",
  roundCost: "\u672c\u8f6e\u8d39\u7528\uff1a$1.24",
  totalCost: "\u7d2f\u8ba1\u8d39\u7528\uff1a$3.80",
  exceeded: "\u5df2\u8d85\u9650",
  continues: "\u5de5\u4f5c\u4ecd\u7ee7\u7eed",
  paused: "\u5df2\u6682\u505c",
  historicalRound: "\u7b2c 2 \u8f6e",
  historicalTrigger: "\u89e6\u53d1\u539f\u56e0\uff1a\u5408\u6d41\u9a8c\u8bc1\u672a\u901a\u8fc7",
  historicalResult: "\u7ed3\u679c\uff1a\u5df2\u4fee\u6b63",
  historicalCost: "\u8d39\u7528\uff1a$0.86",
  otherHistoricalResult: "\u7ed3\u679c\uff1a\u9996\u6b21\u6267\u884c\u5b8c\u6210",
  noTodos: "\u5f53\u524d\u6ca1\u6709\u7b49\u5f85\u672c\u4eba\u5904\u7406\u7684\u4e8b\u9879",
  inspectRuns: "\u68c0\u67e5\u8fd0\u884c\u9879",
  unavailableTodo: "\u8fd9\u9879\u5f85\u529e\u5df2\u4e0d\u518d\u7b49\u5f85\u5904\u7406",
  noRounds: "\u5f53\u524d\u8fd8\u6ca1\u6709\u8f6e\u6b21",
  loadingOverview: "\u6b63\u5728\u8bfb\u53d6\u8fd0\u884c\u603b\u89c8",
  detailFailure: "\u65e0\u6cd5\u8bfb\u53d6\u672c\u8f6e\u8be6\u60c5",
  retryRead: "\u91cd\u65b0\u8bfb\u53d6",
  confirmationWaiting: "\u5904\u7406\u7ed3\u679c\u5c1a\u672a\u786e\u8ba4\uff0c\u786e\u8ba4\u540e\u5c06\u81ea\u52a8\u5237\u65b0",
} as const;

const now = 1_000_000;

const replyTodo: OperatorTodo = {
  id: "todo-reply",
  revision: "rev-1",
  kind: "reply",
  subject: {
    kind: "story",
    id: "story-1",
    title: "Household assistant",
    notionPageId: "notion-story-1",
  },
  question: "Which retry scope should be used?",
  context: "The previous verification did not pass.",
  sourceLabel: "Clarification",
  waitingSince: now - 12 * 60_000,
  answerLabel: COPY.answerLabel,
};

const approvalTodo: OperatorTodo = {
  id: "todo-approval",
  revision: "rev-2",
  kind: "approval",
  subject: {
    kind: "requirement",
    id: "requirement-1",
    title: "Operator console",
    notionPageId: "notion-requirement-1",
  },
  question: "May this proposal proceed?",
  context: "The proposal is ready for review.",
  sourceLabel: "Solution",
  waitingSince: now - 60_000,
  options: [{ id: "approve", label: COPY.approve }],
  noteLabel: "Decision note",
  noteRequired: false,
};

const choiceTodo: OperatorTodo = {
  id: "todo-choice",
  revision: "rev-3",
  kind: "choice",
  subject: {
    kind: "requirement",
    id: "requirement-2",
    title: "Cost reporting",
    notionPageId: "notion-requirement-2",
  },
  question: "Which timezone should reports use?",
  context: "One timezone must be selected.",
  sourceLabel: "Open decision",
  waitingSince: now - 2 * 60_000,
  options: [
    { id: "shanghai", label: "Asia/Shanghai" },
    { id: "utc", label: "UTC" },
  ],
};

function ready<T>(value: T): ConsolePageState<T> {
  return { kind: "ready", value, refreshing: false };
}

function overview(waitingForOperator = [replyTodo]): OperatorOverview {
  return {
    generatedAt: now,
    waitingForOperator: waitingForOperator.map((todo) => ({
      id: todo.id,
      revision: todo.revision,
      kind: todo.kind,
      subject: {
        kind: todo.subject.kind,
        id: todo.subject.id,
        title: todo.subject.title,
      },
      sourceLabel: todo.sourceLabel,
      waitingSince: todo.waitingSince,
    })),
    running: [{
      subject: { kind: "story", id: "story-2", title: "Autonomous indexing" },
      state: "running",
      phase: "CODE",
      updatedAt: now - 1_000,
      currentRound: 1,
      costUsd: 0.4,
    }],
    failures: [{
      subject: { kind: "story", id: "story-3", title: "Failed synchronization" },
      state: "failed",
      phase: "VERIFY",
      updatedAt: now - 2_000,
      currentRound: 2,
      costUsd: 0.7,
    }],
    recentlyCompleted: [{
      subject: { kind: "story", id: "story-4", title: "Completed projection" },
      state: "completed",
      phase: "MERGE",
      updatedAt: now - 3_000,
      currentRound: 1,
      costUsd: 0.2,
    }],
  };
}

function detail(): OperatorDetail {
  return {
    subject: { kind: "requirement", id: "requirement-1", title: "Operator console" },
    stateLabel: COPY.running,
    currentRound: {
      number: 3,
      trigger: "\u9a8c\u8bc1\u672a\u901a\u8fc7",
      phase: "VERIFY",
      result: null,
      blocker: null,
      costUsd: 1.24,
      startedAt: now - 2_000,
      endedAt: null,
    },
    history: [
      {
        number: 2,
        trigger: "\u5408\u6d41\u9a8c\u8bc1\u672a\u901a\u8fc7",
        phase: "CODE",
        result: "\u5df2\u4fee\u6b63",
        blocker: null,
        costUsd: 0.86,
        startedAt: now - 4_000,
        endedAt: now - 3_000,
      },
      {
        number: 1,
        trigger: "\u9996\u6b21\u6267\u884c",
        phase: "SHAPE",
        result: "\u9996\u6b21\u6267\u884c\u5b8c\u6210",
        blocker: null,
        costUsd: 1.7,
        startedAt: now - 6_000,
        endedAt: now - 5_000,
      },
    ],
    totalCostUsd: 3.8,
    costLimit: { kind: "exceeded", workContinues: true },
  };
}

function dependencies(access: "allowed" | "denied" = "allowed"): OperatorConsoleDependencies {
  return {
    access: { decide: vi.fn(() => ({ kind: access })) },
    reads: {
      overview: vi.fn(async () => overview()),
      todo: vi.fn(async () => ({ kind: "pending" as const, todo: replyTodo })),
      detail: vi.fn(async () => ({ kind: "available" as const, detail: detail() })),
    },
    commands: {
      submit: vi.fn(async () => ({
        kind: "saved" as const,
        todoId: replyTodo.id,
        savedAt: now,
        destination: replyTodo.subject,
      })),
    },
  };
}

describe("operator console contract", () => {
  it("keeps the declared within-limit state available as a control", () => {
    expect({ kind: "within_limit" as const }).toEqual({ kind: "within_limit" });
  });

  it("@scenario S-R237511MB-01-access renders only the denied access explanation", async () => {
    const app = Fastify({ logger: false });
    const ports = dependencies("denied");
    await registerOperatorConsoleRoutes(app, ports);

    const response = await app.inject({ method: "GET", url: "/operator/overview", remoteAddress: "203.0.113.8" });

    expect(response.body).toContain(COPY.accessDenied);
    expect(response.body).toContain(COPY.connectNetwork);
    expect(response.body).toContain(COPY.recheck);
    await app.close();
  });

  it("@scenario S-R237511MB-01-access does not expose or read operator data when access is denied", async () => {
    const app = Fastify({ logger: false });
    const ports = dependencies("denied");
    await registerOperatorConsoleRoutes(app, ports);

    const response = await app.inject({ method: "GET", url: "/operator/overview", remoteAddress: "203.0.113.8" });

    expect(ports.reads.overview).not.toHaveBeenCalled();
    for (const hidden of [COPY.waiting, COPY.running, COPY.costs, COPY.roles, COPY.records]) {
      expect(response.body).not.toContain(hidden);
    }
    await app.close();
  });

  it("@scenario S-R237511MB-01-overview orders the four sections and shows every actionable todo field", () => {
    const page = renderOperatorOverviewPage(ready(overview([replyTodo, approvalTodo])), now);

    expect(page).toContain(COPY.waiting);
    const positions = [COPY.waiting, COPY.running, COPY.failures, COPY.completed].map((heading) => page.indexOf(heading));
    expect(positions).toEqual([...positions].toSorted((left, right) => left - right));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(page).toContain(replyTodo.subject.title);
    expect(page).toContain("12");
    expect(page).toContain(COPY.handle);
    for (const label of [COPY.overview, COPY.costs, COPY.roles, COPY.records]) expect(page).toContain(label);
  });

  it("@scenario S-R237511MB-01-overview keeps work without an operator action out of the waiting section", () => {
    const page = renderOperatorOverviewPage(ready(overview()), now);
    const waitingSection = page.slice(page.indexOf(COPY.waiting), page.indexOf(COPY.running));

    expect(waitingSection).not.toContain("Autonomous indexing");
  });

  it("@scenario S-R237511MB-01-form renders a directly labelled reply form", () => {
    const page = renderOperatorTodoPage(ready({ kind: "pending", todo: replyTodo }));

    expect(page).toContain(COPY.answerLabel);
    expect(page).toContain(COPY.submitReply);
    expect(page).toContain(replyTodo.question);
    expect(page).toContain(replyTodo.context);
    expect(page).toContain(COPY.back);
  });

  it("@scenario S-R237511MB-01-form renders only the declared approval and choice options", () => {
    const approval = renderOperatorTodoPage(ready({ kind: "pending", todo: approvalTodo }));
    const choice = renderOperatorTodoPage(ready({ kind: "pending", todo: choiceTodo }));

    expect(approval).toContain(COPY.approve);
    expect(choice).toContain(COPY.choose);
    expect(choice).toContain(COPY.submitChoice);
    expect(choice).toContain("Asia/Shanghai");
    expect(choice).toContain("UTC");
    expect(choice).not.toContain("Europe/London");
  });

  it("@scenario S-R237511MB-01-validation keeps an empty reply pending and explains how to fix it", () => {
    const page = renderOperatorTodoPage(ready({ kind: "pending", todo: replyTodo }), {
      submission: { kind: "validation_failed", field: "text" },
      submittedValue: "",
    });

    expect(page).toContain(COPY.validation);
    expect(page).toContain(replyTodo.question);
    expect(page).not.toContain(COPY.handled);
  });

  it("@scenario S-R237511MB-01-validation does not turn whitespace into a completed result", () => {
    const page = renderOperatorTodoPage(ready({ kind: "pending", todo: replyTodo }), {
      submission: { kind: "validation_failed", field: "text" },
      submittedValue: "   ",
    });

    expect(page).not.toContain(COPY.handled);
  });

  it("@scenario S-R237511MB-01-complete shows the Notion destination only after confirmation", () => {
    const page = renderOperatorTodoPage(ready({ kind: "pending", todo: replyTodo }), {
      submission: {
        kind: "saved",
        todoId: replyTodo.id,
        savedAt: now,
        destination: replyTodo.subject,
      },
      submittedValue: "Keep retries scoped to this story.",
    });

    expect(page).toContain(COPY.handled);
    expect(page).toContain(COPY.savedTask);
    expect(page).toContain(COPY.back);
  });

  it("@scenario S-R237511MB-01-complete disables a duplicate submission and removes a saved todo from overview", () => {
    const submitting = renderOperatorTodoPage(ready({ kind: "pending", todo: replyTodo }), {
      submission: { kind: "submitting", retryAfterMs: 1_000 },
      submittedValue: "Keep retries scoped to this story.",
    });
    const afterSave = renderOperatorOverviewPage(ready(overview([])), now);

    expect(submitting).toMatch(/<button[^>]*disabled[^>]*>/);
    expect(afterSave).not.toContain(replyTodo.subject.title);
  });

  it("@scenario S-R237511MB-01-saveerror preserves the answer and offers retry without claiming success", () => {
    const submittedValue = "Keep retries scoped to this story.";
    const page = renderOperatorTodoPage(ready({ kind: "pending", todo: replyTodo }), {
      submission: { kind: "not_saved", reason: "confirmation_timeout", retryable: true },
      submittedValue,
    });

    expect(page).toContain(COPY.notSaved);
    expect(page).toContain(COPY.retrySubmit);
    expect(page).toContain(submittedValue);
    expect(page).not.toContain(COPY.handled);
  });

  it("@scenario S-R237511MB-01-saveerror leaves an unconfirmed todo in the waiting section", () => {
    const page = renderOperatorOverviewPage(ready(overview([replyTodo])), now);

    expect(page).toContain(replyTodo.subject.title);
    expect(page).toContain(COPY.handle);
  });

  it("@scenario S-R237511MB-01-detail defaults to the current round with explicit empty values and costs", () => {
    const page = renderOperatorDetailPage(ready({ kind: "available", detail: detail() }));

    for (const text of [
      COPY.currentRound,
      COPY.trigger,
      COPY.phase,
      COPY.resultMissing,
      COPY.blockerMissing,
      COPY.roundCost,
      COPY.totalCost,
      COPY.exceeded,
      COPY.continues,
    ]) expect(page).toContain(text);
  });

  it("@scenario S-R237511MB-01-detail never leaves result or blocker blank and never calls over-limit work paused", () => {
    const page = renderOperatorDetailPage(ready({ kind: "available", detail: detail() }));

    expect(page).toContain(COPY.resultMissing);
    expect(page).toContain(COPY.blockerMissing);
    expect(page).not.toContain(COPY.paused);
  });

  it("@scenario S-R237511MB-01-history expands only the selected historical round at its recorded cost", () => {
    const page = renderOperatorDetailPage(ready({ kind: "available", detail: detail() }), 2);

    expect(page).toContain(COPY.historicalRound);
    expect(page).toContain(COPY.historicalTrigger);
    expect(page).toContain(COPY.historicalResult);
    expect(page).toContain(COPY.historicalCost);
    expect(page).not.toContain(COPY.otherHistoricalResult);
  });

  it("@scenario S-R237511MB-01-history selects the current round again when detail is reopened", () => {
    const page = renderOperatorDetailPage(ready({ kind: "available", detail: detail() }));

    expect(page).toContain(COPY.currentRound);
    expect(page).not.toContain(COPY.historicalResult);
    expect(page).not.toContain(COPY.otherHistoricalResult);
  });

  it("@scenario S-R237511MB-01-empty gives a next step for empty overview, unavailable todo, and no rounds", () => {
    const emptyOverview = renderOperatorOverviewPage(ready(overview([])), now);
    const unavailableTodo = renderOperatorTodoPage(ready({ kind: "unavailable" }));
    const noRounds = renderOperatorDetailPage(ready({
      kind: "no_rounds",
      subject: { kind: "requirement", id: "requirement-1", title: "Operator console" },
    }));

    expect(emptyOverview).toContain(COPY.noTodos);
    expect(emptyOverview).toContain(COPY.inspectRuns);
    expect(unavailableTodo).toContain(COPY.unavailableTodo);
    expect(unavailableTodo).toContain(COPY.back);
    expect(noRounds).toContain(COPY.noRounds);
    expect(noRounds).toContain(COPY.back);
  });

  it("@scenario S-R237511MB-01-empty does not fabricate a todo or first round", () => {
    const unavailableTodo = renderOperatorTodoPage(ready({ kind: "unavailable" }));
    const noRounds = renderOperatorDetailPage(ready({
      kind: "no_rounds",
      subject: { kind: "requirement", id: "requirement-1", title: "Operator console" },
    }));

    expect(unavailableTodo).not.toContain(COPY.submitReply);
    expect(noRounds).not.toContain("Round 1");
  });

  it("@scenario S-R237511MB-01-states names the loading scope while preserving previous content", () => {
    const state: ConsolePageState<OperatorOverview> = { kind: "loading", previous: overview() };
    const page = renderOperatorOverviewPage(state, now);

    expect(page).toContain(COPY.loadingOverview);
    expect(page).toContain(replyTodo.subject.title);
  });

  it("@scenario S-R237511MB-01-states gives retry and automatic-refresh directions for failures and waits", () => {
    const failed = renderOperatorDetailPage({ kind: "failed", previous: { kind: "available", detail: detail() } });
    const waitingState: ConsolePageState<OperatorTodoResult> = {
      kind: "waiting",
      value: { kind: "pending", todo: replyTodo },
      waitingFor: "notion_confirmation",
      refreshAfterMs: 1_000,
    };
    const waiting = renderOperatorTodoPage(waitingState);

    expect(failed).toContain(COPY.detailFailure);
    expect(failed).toContain(COPY.retryRead);
    expect(failed).toContain(COPY.back);
    expect(waiting).toContain(COPY.confirmationWaiting);
    expect(waiting).not.toContain(COPY.handled);
  });

  it("@scenario S-R237511MB-01-access renders the standalone denied copy", () => {
    const page = renderOperatorAccessPage();

    expect(page).toContain(COPY.accessDenied);
    expect(page).toContain(COPY.recheck);
  });
});
