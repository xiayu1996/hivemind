/**
 * Representative data for the operator console's overview, todo and detail
 * screens.
 *
 * The screens under review need data on them, and the console on this branch
 * is a set of ports with no adapter to the central store yet: the verification
 * round starts it with no database and no seed command, so the app itself
 * supplies the sample. The values are the ones the frozen contract test uses
 * (round 3 at $1.24 with $3.80 recorded, round 2 at $0.86), so what a reviewer
 * sees on the screen is what the contract proves.
 *
 * Submitting is answered in memory, and it is answered the way the real
 * command port would: a saved todo leaves the waiting area, and one todo
 * represents a Notion write that is never confirmed, which is the only way the
 * not-saved screen can be looked at.
 */
import type {
  OperatorNetworkAccessDecision,
  OperatorConsoleDependencies,
  OperatorDetail,
  OperatorDetailResult,
  OperatorOverview,
  OperatorSubjectRef,
  OperatorTodo,
  OperatorTodoResult,
  SavedTodoResult,
  TodoSubmissionResult,
} from "./operator-contract.js";
import copy from "./operator-todo-sample.json" with { type: "json" };

/** The todo whose Notion write is never confirmed. */
export const NOTION_UNCONFIRMED_TODO_ID = "todo-notion-down";

/** The one subject that has rounds; every other subject shows the empty state. */
export const DETAIL_SUBJECT_ID = "req-console";

const DETAIL_SUBJECT: Pick<OperatorSubjectRef, "kind" | "id" | "title"> = {
  kind: "requirement",
  id: DETAIL_SUBJECT_ID,
  title: copy.subjects.console,
};

const SUBJECT_TITLES: Readonly<Record<string, string>> = {
  [DETAIL_SUBJECT_ID]: copy.subjects.console,
  "story-purchase-sync": copy.subjects.purchaseSync,
  "story-billing": copy.subjects.billing,
};

const LOOPBACK = /^(?:::ffff:)?127\.\d{1,3}\.\d{1,3}\.\d{1,3}$|^::1$|^localhost$/i;

function subjectOf(kind: OperatorSubjectRef["kind"], id: string, title: string): OperatorSubjectRef {
  return { kind, id, title, notionPageId: `notion-${id}` };
}

/** Waiting times are measured from the read instant so the overview keeps
 * showing the duration the definition of done names (12 minutes). */
function sampleTodos(now: number): readonly OperatorTodo[] {
  return [
    {
      id: "todo-reply",
      revision: "sample-rev-1",
      kind: "reply",
      subject: subjectOf("story", "story-household", copy.subjects.household),
      question: copy.todos.reply.question,
      context: copy.todos.reply.context,
      sourceLabel: copy.todos.reply.sourceLabel,
      waitingSince: now - 12 * 60_000,
      answerLabel: copy.todos.reply.answerLabel,
    },
    {
      id: "todo-approval",
      revision: "sample-rev-2",
      kind: "approval",
      subject: subjectOf("requirement", "req-console", copy.subjects.console),
      question: copy.todos.approval.question,
      context: copy.todos.approval.context,
      sourceLabel: copy.todos.approval.sourceLabel,
      waitingSince: now - 4 * 60_000,
      options: [{ id: "approve", label: copy.todos.approval.option }],
      noteLabel: copy.todos.approval.noteLabel,
      noteRequired: false,
    },
    {
      id: "todo-choice",
      revision: "sample-rev-3",
      kind: "choice",
      subject: subjectOf("requirement", "req-cost-report", copy.subjects.costReport),
      question: copy.todos.choice.question,
      context: copy.todos.choice.context,
      sourceLabel: copy.todos.choice.sourceLabel,
      waitingSince: now - 2 * 60_000,
      options: [
        { id: "shanghai", label: copy.todos.choice.shanghai },
        { id: "utc", label: copy.todos.choice.utc },
      ],
    },
    {
      id: NOTION_UNCONFIRMED_TODO_ID,
      revision: "sample-rev-4",
      kind: "reply",
      subject: subjectOf("story", "story-ledger-sync", copy.subjects.ledgerSync),
      question: copy.todos.notionDown.question,
      context: copy.todos.notionDown.context,
      sourceLabel: copy.todos.notionDown.sourceLabel,
      waitingSince: now - 1 * 60_000,
      answerLabel: copy.todos.notionDown.answerLabel,
    },
  ];
}

function sampleDetail(now: number): OperatorDetail {
  return {
    subject: DETAIL_SUBJECT,
    stateLabel: copy.detail.stateLabel,
    currentRound: {
      number: 3,
      trigger: copy.detail.currentTrigger,
      phase: "VERIFY",
      result: null,
      blocker: null,
      costUsd: 1.24,
      startedAt: now - 2 * 60_000,
      endedAt: null,
    },
    history: [
      {
        number: 2,
        trigger: copy.detail.secondTrigger,
        phase: "CODE",
        result: copy.detail.secondResult,
        blocker: null,
        costUsd: 0.86,
        startedAt: now - 4 * 60_000,
        endedAt: now - 3 * 60_000,
      },
      {
        number: 1,
        trigger: copy.detail.firstTrigger,
        phase: "SHAPE",
        result: copy.detail.firstResult,
        blocker: null,
        costUsd: 1.7,
        startedAt: now - 6 * 60_000,
        endedAt: now - 5 * 60_000,
      },
    ],
    totalCostUsd: 3.8,
    costLimit: { kind: "exceeded", workContinues: true },
  };
}

export interface SampleConsoleOptions {
  /** Read instant, so a smoke run can pin the waiting durations. */
  now?: () => number;
}

/**
 * Ports over the sample data, ready to hand to
 * {@link registerOperatorConsoleRoutes}. Only loopback is admitted: the app is
 * started on the machine that opens it, and a browser driven from that same
 * machine cannot arrive from outside the allowed network, which is what the
 * access screen is a separate address for.
 */
export function createSampleOperatorConsole(options: SampleConsoleOptions = {}): OperatorConsoleDependencies {
  const now = options.now ?? ((): number => Date.now());
  const saved = new Map<string, SavedTodoResult>();

  const overview = (at: number): OperatorOverview => ({
    generatedAt: at,
    waitingForOperator: sampleTodos(at)
      .filter((todo) => !saved.has(todo.id))
      .map((todo) => ({
        id: todo.id,
        revision: todo.revision,
        kind: todo.kind,
        subject: { kind: todo.subject.kind, id: todo.subject.id, title: todo.subject.title },
        sourceLabel: todo.sourceLabel,
        waitingSince: todo.waitingSince,
      })),
    running: [{
      subject: DETAIL_SUBJECT,
      state: "running",
      phase: "VERIFY",
      updatedAt: at - 60_000,
      currentRound: 3,
      costUsd: 3.8,
    }],
    failures: [{
      subject: { kind: "story", id: "story-purchase-sync", title: copy.subjects.purchaseSync },
      state: "failed",
      phase: "CODE",
      updatedAt: at - 120_000,
      currentRound: null,
      costUsd: 0.4,
    }],
    recentlyCompleted: [{
      subject: { kind: "story", id: "story-billing", title: copy.subjects.billing },
      state: "completed",
      phase: "MERGE",
      updatedAt: at - 300_000,
      currentRound: 1,
      costUsd: 0.9,
    }],
  });

  return {
    access: {
      decide(clientAddress: string): OperatorNetworkAccessDecision {
        return LOOPBACK.test(clientAddress.trim()) ? { kind: "allowed" } : { kind: "denied" };
      },
    },
    reads: {
      async overview(): Promise<OperatorOverview> {
        return overview(now());
      },
      async todo(todoId: string): Promise<OperatorTodoResult> {
        const found = sampleTodos(now()).find((todo) => todo.id === todoId);
        if (found === undefined || saved.has(todoId)) return { kind: "unavailable" };
        return { kind: "pending", todo: found };
      },
      async detail(subject: Pick<OperatorSubjectRef, "kind" | "id">): Promise<OperatorDetailResult> {
        if (subject.id !== DETAIL_SUBJECT_ID) {
          return {
            kind: "no_rounds",
            subject: { kind: subject.kind, id: subject.id, title: SUBJECT_TITLES[subject.id] ?? subject.id },
          };
        }
        return { kind: "available", detail: sampleDetail(now()) };
      },
    },
    commands: {
      async submit(input): Promise<TodoSubmissionResult> {
        const found = sampleTodos(now()).find((todo) => todo.id === input.todoId);
        if (found === undefined || saved.has(input.todoId) || input.expectedRevision !== found.revision) {
          return { kind: "unavailable" };
        }
        if (input.todoId === NOTION_UNCONFIRMED_TODO_ID) {
          return { kind: "not_saved", reason: "confirmation_timeout", retryable: true };
        }
        const result: SavedTodoResult = {
          kind: "saved",
          todoId: found.id,
          savedAt: now(),
          destination: { kind: found.subject.kind, id: found.subject.id, title: found.subject.title },
        };
        saved.set(found.id, result);
        return result;
      },
    },
  };
}
