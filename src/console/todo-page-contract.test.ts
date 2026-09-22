import { describe, expect, it } from "vitest";
import {
  TODO_COPY,
  createTodoHttpPort,
  emptySubmission,
  formatNotionTargetLine,
  formatProcessedLine,
  formatSavedConfirmation,
  formatWaiting,
  initialTodoView,
  reduceTodoView,
  sectionHeading,
  todoDetailApiPath,
  validationMessage,
  type TodoDetailDto,
  type TodoSubmissionDto,
  type TodoViewState,
} from "../../console-ui/src/pages/todo/contracts.js";

const storyTarget = {
  kind: "story" as const,
  id: "S-EPIC1-01",
  title: "回答一件事",
  pageId: "page-story",
  pageUrl: "https://notion.so/page-story",
};

const answerDetail: TodoDetailDto = {
  todoId: "answer:S-EPIC1-01:q1",
  kind: "answer",
  title: "要不要先发提醒？",
  subject: { ...storyTarget, requirementId: null, requirementTitle: null },
  waitingSince: 1_500,
  decision: null,
  sections: [],
  questions: [{ index: 1, question: "要不要先发提醒？", context: null, suggestion: "先不发", options: [] }],
  conclusions: [],
  notionTarget: storyTarget,
};

const approveDetail: TodoDetailDto = {
  todoId: "approve:requirement:R-1:prd",
  kind: "approve",
  title: "控制台",
  subject: {
    kind: "requirement",
    id: "R-1",
    title: "控制台",
    pageId: "page-req",
    pageUrl: "https://notion.so/page-req",
    requirementId: "R-1",
    requirementTitle: "控制台",
  },
  waitingSince: 2_000,
  decision: null,
  sections: [{ id: "prd_goal", text: "值班的人随时知道卡在哪" }],
  questions: [],
  conclusions: [
    { id: "approve", label: "", recommended: false },
    { id: "rework", label: "", recommended: false },
  ],
  notionTarget: {
    kind: "requirement",
    id: "R-1",
    title: "控制台",
    pageId: "page-req",
    pageUrl: "https://notion.so/page-req",
  },
};

const chooseDetail: TodoDetailDto = {
  todoId: "choose:R-1:1",
  kind: "choose",
  title: "手机优先吗？",
  subject: {
    kind: "requirement",
    id: "R-1",
    title: "控制台",
    pageId: "page-req",
    pageUrl: "https://notion.so/page-req",
    requirementId: "R-1",
    requirementTitle: "控制台",
  },
  waitingSince: 4_000,
  decision: null,
  sections: [],
  questions: [{
    index: 1,
    question: "手机优先吗？",
    context: null,
    suggestion: null,
    options: [
      { id: "A", label: "先做手机端", recommended: false },
      { id: "B", label: "先做桌面端", recommended: true },
    ],
  }],
  conclusions: [],
  notionTarget: {
    kind: "requirement",
    id: "R-1",
    title: "控制台",
    pageId: "page-req",
    pageUrl: "https://notion.so/page-req",
  },
};

function ready(todo: TodoDetailDto): TodoViewState {
  const loading = reduceTodoView(initialTodoView(todo.todoId), { type: "load", todoId: todo.todoId });
  return reduceTodoView(loading, { type: "loaded", requestId: loading.requestId, result: { kind: "pending", todo } });
}

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe("the page state machine", () => {
  it("reads a todo in three steps and holds the content it got", () => {
    const idle = initialTodoView(answerDetail.todoId);
    const loading = reduceTodoView(idle, { type: "load", todoId: answerDetail.todoId });
    expect(loading.status).toBe("loading");
    expect(loading.requestId).toBeGreaterThan(idle.requestId);

    const loaded = reduceTodoView(loading, {
      type: "loaded",
      requestId: loading.requestId,
      result: { kind: "pending", todo: answerDetail },
    });

    expect(loaded.status).toBe("ready");
    expect(loaded.todo?.todoId).toBe("answer:S-EPIC1-01:q1");
    expect(loaded.decision).toBeNull();
  });

  it("does not let an old read answer the newest one", () => {
    const loading = reduceTodoView(initialTodoView(answerDetail.todoId), { type: "load", todoId: answerDetail.todoId });

    const stale = reduceTodoView(loading, { type: "loaded", requestId: 0, result: { kind: "failed" } });

    expect(stale.status).toBe("loading");
  });

  it("@scenario S-R237511TD-01-error shows a failed read as a failure and never as nothing waiting", () => {
    const state = reduceTodoView(initialTodoView(answerDetail.todoId), {
      type: "loaded",
      requestId: 1,
      result: { kind: "failed" },
    });

    expect(state.status).toBe("error");
    expect(state.todo).toBeNull();
    expect(state.decision).toBeNull();
  });

  it("shows an empty ledger as nothing waiting", () => {
    const state = reduceTodoView(initialTodoView(null), { type: "loaded", requestId: 1, result: { kind: "none" } });

    expect(state.status).toBe("none");
    expect(state.todo).toBeNull();
  });

  it("holds the submission while it is in flight", () => {
    const submission: TodoSubmissionDto = { kind: "answer", answer: "先不发", submittedBy: "本人" };

    const submitting = reduceTodoView(ready(answerDetail), { type: "submit", requestId: 2, submission });

    expect(submitting.status).toBe("submitting");
    expect(submitting.submission).toEqual(submission);
    expect(submitting.issues).toEqual([]);
  });

  it("comes back to the form with the issues when the server refused it", () => {
    const state = reduceTodoView(ready(answerDetail), {
      type: "submitted",
      requestId: 2,
      result: { kind: "invalid", issues: ["empty_answer"] },
    });

    expect(state.status).toBe("ready");
    expect(state.issues).toEqual(["empty_answer"]);
    expect(state.todo?.todoId).toBe("answer:S-EPIC1-01:q1");
  });

  it("@scenario S-R237511TD-01-savefail keeps the todo unhandled while Notion has not confirmed", () => {
    const state = reduceTodoView(ready(answerDetail), {
      type: "submitted",
      requestId: 2,
      result: { kind: "recorded", state: { status: "awaiting_notion", submittedAt: 9_000 } },
    });

    expect(state.status).toBe("awaiting_notion");
    expect(state.decision).toMatchObject({ status: "awaiting_notion" });
  });

  it("@scenario S-R237511TD-01-answer marks the todo handled only once the result is confirmed kept", () => {
    const state = reduceTodoView(ready(answerDetail), {
      type: "submitted",
      requestId: 2,
      result: { kind: "recorded", state: { status: "processed", submittedAt: 9_000, recordedAt: 9_500 } },
    });

    expect(state.status).toBe("processed");
    expect(state.decision).toMatchObject({ status: "processed", recordedAt: 9_500 });
  });
});

describe("the words the page shows", () => {
  it("names the four page states the requirement froze", () => {
    expect(TODO_COPY.loading).toBe("正在读取待办内容");
    expect(TODO_COPY.failed).toBe("无法读取这件待办");
    expect(TODO_COPY.retry).toBe("重新读取");
    expect(TODO_COPY.none).toBe("目前没有待办");
    expect(TODO_COPY.awaitingHeading).toBe("正在等待 Notion 确认保存");
    expect(TODO_COPY.checkSave).toBe("检查保存结果");
    expect(TODO_COPY.statusUnhandled).toBe("未处理");
    expect(TODO_COPY.statusProcessed).toBe("已处理");
  });

  it("@scenario S-R237511TD-02-answer names the confirmed answer save for the acceptance check", () => {
    expect(TODO_COPY.conclusionLabels).toEqual({ approve: "批准并继续", rework: "要求返工" });
    expect(TODO_COPY.decisionHeading).toBe("需要你决定");

    expect(formatProcessedLine(approveDetail)).toBe("批准结果已保留到对应的 Notion 需求“控制台”。");
    expect(formatProcessedLine(answerDetail)).toBe("答复已保留到对应的 Notion 任务“回答一件事”。");
    expect(formatSavedConfirmation(answerDetail)).toBe("答复已保留到对应 Notion 任务。");
  });

  it("@scenario S-R237511TD-01-open says where the result will be kept before it is submitted", () => {
    const line = formatNotionTargetLine(approveDetail);
    expect(line).toContain("Notion 需求");
    expect(line).toContain("保留");
  });

  it("heads each block of ledger text and shows no heading for an unknown one", () => {
    expect(sectionHeading("prd_goal")).toBe("这份需求要解决什么");
    expect(sectionHeading("plan_stories")).toBe("拆解出的任务");
    expect(sectionHeading("something_new")).toBe("");
  });

  it("@scenario S-R237511TD-01-open says how long a todo waited", () => {
    expect(formatWaiting(1_000, 1_000 + 18 * 60_000)).toBe("等待 18 分钟");
  });

  it("turns each validation issue into how to fix it", () => {
    expect(validationMessage("empty_answer")).toBe("请填写答复后再提交");
    expect(validationMessage("unknown_conclusion")).toBe("请选择“批准并继续”或“要求返工”后再提交");
  });
});

describe("the form opens empty", () => {
  it("opens an answer box with nothing written", () => {
    expect(emptySubmission(answerDetail, "本人")).toEqual({ kind: "answer", answer: "", submittedBy: "本人" });
  });

  it("@scenario S-R237511TD-01-choose opens one choice per question with nothing chosen, not even the recommended one", () => {
    const submission = emptySubmission(chooseDetail, "本人");
    expect(submission.kind).toBe("choose");
    if (submission.kind !== "choose") throw new Error("expected a choice form");
    expect(submission.answers).toEqual([{ questionIndex: 1, optionLetter: null, text: "" }]);
  });
});

describe("the HTTP port", () => {
  it("reads the todo the page named", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(String(url));
      return response(answerDetail);
    }) as unknown as typeof fetch;

    const result = await createTodoHttpPort(fetchImpl).read(answerDetail.todoId);

    expect(result).toEqual({ kind: "pending", todo: answerDetail });
    expect(urls).toEqual([todoDetailApiPath(answerDetail.todoId)]);
  });

  it("opens the oldest waiting todo when the page named none", async () => {
    const fetchImpl = (async (url: string) => {
      if (String(url) === "/api/todos") return response({ todos: [answerDetail], openTodoId: answerDetail.todoId });
      return response(answerDetail);
    }) as unknown as typeof fetch;

    await expect(createTodoHttpPort(fetchImpl).read(null)).resolves.toEqual({ kind: "pending", todo: answerDetail });
  });

  it("says nothing is waiting when the ledger is empty", async () => {
    const fetchImpl = (async () => response({ todos: [], openTodoId: null })) as unknown as typeof fetch;

    await expect(createTodoHttpPort(fetchImpl).read(null)).resolves.toEqual({ kind: "none" });
  });

  it("@scenario S-R237511TD-01-error reports a read that never arrived as a failure", async () => {
    const fetchImpl = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    await expect(createTodoHttpPort(fetchImpl).read(answerDetail.todoId)).resolves.toEqual({ kind: "failed" });
  });

  it("@scenario S-R237511TD-01-answer posts the submission and reports the state the server answered", async () => {
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url: String(url), init });
      return response({ ok: true, state: { status: "processed", submittedAt: 9_000, recordedAt: 9_500 } });
    }) as unknown as typeof fetch;
    const submission: TodoSubmissionDto = { kind: "answer", answer: "先不发", submittedBy: "本人" };

    const result = await createTodoHttpPort(fetchImpl).submit(answerDetail.todoId, submission);

    expect(result).toEqual({ kind: "recorded", state: { status: "processed", submittedAt: 9_000, recordedAt: 9_500 } });
    expect(seen[0]?.url).toBe("/api/todos/answer%3AS-EPIC1-01%3Aq1/decision");
    expect(seen[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(seen[0]?.init?.body))).toEqual(submission);
  });

  it("reports validation issues and a todo that is gone", async () => {
    const invalid = (async () => response({ ok: false, reason: "invalid", issues: ["empty_answer"] }, 422)) as unknown as typeof fetch;
    await expect(createTodoHttpPort(invalid).submit(answerDetail.todoId, {
      kind: "answer",
      answer: "",
      submittedBy: "本人",
    })).resolves.toEqual({ kind: "invalid", issues: ["empty_answer"] });

    const gone = (async () => response({ ok: false, reason: "gone" }, 404)) as unknown as typeof fetch;
    await expect(createTodoHttpPort(gone).submit(answerDetail.todoId, {
      kind: "answer",
      answer: "先不发",
      submittedBy: "本人",
    })).resolves.toEqual({ kind: "gone" });
  });

  it("re-checks the save through the save-check route", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => {
      seen.push(String(url));
      return response({ ok: true, state: { status: "processed", submittedAt: 9_000, recordedAt: 9_500 } });
    }) as unknown as typeof fetch;

    const result = await createTodoHttpPort(fetchImpl).checkSave(answerDetail.todoId);

    expect(result).toEqual({ kind: "recorded", state: { status: "processed", submittedAt: 9_000, recordedAt: 9_500 } });
    expect(seen).toEqual(["/api/todos/answer%3AS-EPIC1-01%3Aq1/save-check"]);
  });
});
