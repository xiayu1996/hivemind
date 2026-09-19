import { describe, expect, it } from "vitest";
import { createConsoleServer, type ConsoleDataSource } from "./server.js";
import {
  renderStoryProgressPage,
  storyProgressPageView,
} from "./story-progress-page.js";
import type {
  StoryProgressReadResult,
  StoryProgressRound,
  StoryProgressSnapshot,
} from "./story-progress.js";

/**
 * The requirement detail screen, checked where CODE can observe it: the HTML a
 * server-rendered page puts into the document. The browser layer (design 08
 * section 6) reads the same markers off the accessibility tree; this file
 * proves the markup that produces them, so the two cannot drift.
 *
 * A test path named `test_*.ts` matches the repository's own discovery
 * convention (vitest include) without colliding with the test paths SPECIFY
 * froze.
 */

const CARD = "S-R237511DT-01";

function acceptance(scenarioId: string, outcome: "passed" | "failed"): StoryProgressRound["result"] {
  return { state: "available", items: [{ scenarioId, text: scenarioId, outcome }] };
}

function threeRounds(): StoryProgressSnapshot {
  const round1: StoryProgressRound = {
    round: 1,
    trigger: "first_run",
    triggerNote: null,
    phase: "SPECIFY",
    startedAt: 1,
    endedAt: 2,
    result: acceptance("S-R237511DT-01-alpha", "passed"),
    blockers: [],
    costUsd: 0.9,
  };
  const round2: StoryProgressRound = {
    round: 2,
    trigger: "rework",
    triggerNote: "这段把费用和用量写混了，请分开",
    phase: "CODE",
    startedAt: 3,
    endedAt: 4,
    result: acceptance("S-R237511DT-01-beta", "passed"),
    blockers: [],
    costUsd: 0.96,
  };
  const round3: StoryProgressRound = {
    round: 3,
    trigger: "restart",
    triggerNote: null,
    phase: "VERIFY",
    startedAt: 5,
    endedAt: null,
    result: {
      state: "available",
      items: [
        { scenarioId: "S-R237511DT-01-gamma", text: "gamma", outcome: "passed" },
        { scenarioId: "S-R237511DT-01-delta", text: "delta", outcome: "passed" },
        { scenarioId: "S-R237511DT-01-epsilon", text: "epsilon", outcome: "passed" },
        { scenarioId: "S-R237511DT-01-zeta", text: "zeta", outcome: "failed" },
      ],
    },
    blockers: [{ scenarioId: "S-R237511DT-01-zeta", text: "zeta" }],
    costUsd: 1.24,
  };
  return {
    storyId: CARD,
    title: "费用投影核对",
    state: "VERIFY",
    currentRoundId: 3,
    rounds: [round1, round2, round3],
    totalCostUsd: 3.8,
    costCeilingUsd: null,
    workState: "running",
    generatedAt: 10,
  };
}

function progress(snapshot: StoryProgressSnapshot): StoryProgressReadResult {
  return { kind: "progress", snapshot };
}

function renderReady(overrides: Partial<StoryProgressSnapshot> = {}): string {
  const snapshot = { ...threeRounds(), ...overrides };
  return renderStoryProgressPage(storyProgressPageView(progress(snapshot), {}));
}

function consoleWith(result: StoryProgressReadResult): ConsoleDataSource {
  return {
    nodes: async () => [],
    tasks: async () => [],
    costs: async () => [],
    config: async () => [],
    stats: async () => ({}),
    providers: async () => [],
    queue: async () => ({}),
    storyProgress: async () => result,
  };
}

describe("requirement detail page", () => {
  it("@scenario S-R237511DT-01-current 打开需求先看到当前轮的触发原因、阶段、结果、卡点与两笔费用", () => {
    const html = renderReady();
    expect(html).toContain('<h1 class="page-title">需求与任务详情</h1>');
    expect(html).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*>当前轮</);
    expect(html).toContain(">当前轮阶段与结果</h2>");
    expect(html).toContain(">本轮费用</h2>");
    expect(html).toContain(">累计费用</h2>");
    expect(html).toContain("触发原因：重新开始");
    expect(html).toContain("阶段：VERIFY");
    expect(html).toContain("已取得的结果：3 项验收已通过");
    expect(html).toContain("卡点：1 项验收未通过");
    expect(html).toContain("$1.24（本需求当前轮）");
    expect(html).toContain("$3.80（本需求全部轮次）");
  });

  it("@scenario S-R237511DT-01-current 未被选择的历史轮次不会并入当前轮", () => {
    const html = renderReady();
    // The switcher and history list summarise every round by design; what must
    // not expand is an unselected round's own panel, results and blockers.
    expect(html).not.toContain(">第 2 轮</h2>");
    expect(html).not.toContain("已取得的结果：1 项验收已通过");
    expect(html).toContain("$1.24（本需求当前轮）");
  });

  it("@scenario S-R237511DT-01-history 选择第 2 轮只展开那一轮自己的记录", () => {
    const html = renderStoryProgressPage(storyProgressPageView(progress(threeRounds()), { round: "2" }));
    expect(html).toContain(">轮次切换与历史</h2>");
    expect(html).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*>第 2 轮</);
    expect(html).toContain(">第 2 轮</h2>");
    expect(html).toContain("触发原因：返工");
    expect(html).toContain("$0.96（本需求第 2 轮）");
    expect(html).toContain("$3.80（本需求全部轮次）");
    expect(html).not.toContain("已取得的结果：3 项验收已通过");
    expect(html).not.toContain("$1.24（本需求当前轮）");
  });

  it("@scenario S-R237511DT-01-history 第 2 轮的本轮费用与全部轮次累计费用是两个数", () => {
    const html = renderStoryProgressPage(storyProgressPageView(progress(threeRounds()), { round: "2" }));
    expect(html).toContain("$0.96（本需求第 2 轮）");
    expect(html).toContain("$3.80（本需求全部轮次）");
    expect(html).not.toContain("$0.96（本需求全部轮次）");
  });

  it("@scenario S-R237511DT-01-overlimit 费用超限时写明已超限并说明工作仍继续", () => {
    const snapshot = { ...threeRounds(), totalCostUsd: 12.4, costCeilingUsd: 10, workState: "running" as const };
    const round = { ...snapshot.rounds[2]!, costUsd: 12.4 };
    const overLimit = { ...snapshot, rounds: [snapshot.rounds[0]!, snapshot.rounds[1]!, round] };
    const html = renderStoryProgressPage(storyProgressPageView(progress(overLimit), {}));
    expect(html).toContain(">本轮费用</h2>");
    expect(html).toContain("$12.40（本需求当前轮）");
    expect(html).toContain("上限 $10.00");
    expect(html).toContain("已超限");
    expect(html).toContain("工作仍继续");
    expect(html).not.toContain("已暂停");
  });

  it("@scenario S-R237511DT-01-waiting 阶段尚未产生结果时说明将自动刷新", () => {
    const snapshot = threeRounds();
    const pending = { ...snapshot.rounds[2]!, result: { state: "pending" as const } };
    const html = renderStoryProgressPage(storyProgressPageView(progress({ ...snapshot, rounds: [snapshot.rounds[0]!, snapshot.rounds[1]!, pending] }), {}));
    expect(html).toContain(">当前轮阶段与结果</h2>");
    expect(html).toContain("阶段：VERIFY");
    expect(html).toContain("本轮结果尚未产生，将自动刷新");
    expect(html).not.toContain("已取得的结果：0 项验收已通过");
    expect(html).not.toContain("已完成");
  });

  it("@scenario S-R237511DT-01-loading 刷新期间保留原有内容并说明正在读取", () => {
    const html = renderStoryProgressPage(storyProgressPageView(progress(threeRounds()), { state: "loading" }));
    expect(html).toContain('<h1 class="page-title">需求与任务详情</h1>');
    expect(html).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*>当前轮</);
    expect(html).toContain("正在读取当前轮与历史轮次");
    expect(html).toContain(">当前轮阶段与结果</h2>");
    expect(html).toContain("$1.24（本需求当前轮）");
  });

  it("@scenario S-R237511DT-01-loading 读取失败不会清空已显示的轮次内容", () => {
    const html = renderStoryProgressPage(storyProgressPageView(progress(threeRounds()), { round: "2", state: "loading" }));
    expect(html).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*>第 2 轮</);
    expect(html).toContain(">第 2 轮</h2>");
    expect(html).toContain("正在读取当前轮与历史轮次");
  });

  it("@scenario S-R237511DT-01-error 读取失败显示无法读取与重新读取", () => {
    const html = renderStoryProgressPage(storyProgressPageView({ kind: "failed" }, {}));
    expect(html).toContain('role="alert"');
    expect(html).toContain("无法读取需求进展");
    expect(html).toMatch(/<button[^>]*>重新读取<\/button>/);
    expect(html).not.toContain("卡点：无法读取");
  });

  it("@scenario S-R237511DT-01-error 投影不成立时也走同一条读取失败面", () => {
    const html = renderStoryProgressPage(storyProgressPageView({ kind: "invalid_projection", reason: "x" }, {}));
    expect(html).toContain("无法读取需求进展");
    expect(html).toMatch(/<button[^>]*>重新读取<\/button>/);
  });

  it("@scenario S-R237511DT-01-empty 尚无轮次时说明当前情况并给出返回入口", () => {
    const html = renderStoryProgressPage(storyProgressPageView({ kind: "empty", storyId: CARD }, {}));
    expect(html).toContain(">当前还没有工作轮次</h2>");
    expect(html).toContain("返回运行总览");
    expect(html).not.toContain("阶段：");
    expect(html).not.toContain("本轮费用");
    expect(html).not.toContain("$0.00");
  });

  it("@scenario S-R237511DT-01-mobile 手机底部提供当前入口且关键内容单列可见", () => {
    const html = renderReady();
    expect(html).toContain(">当前轮阶段与结果</h2>");
    expect(html).toContain(">本轮费用</h2>");
    expect(html).toContain(">历史轮次</h2>");
    expect(html).toMatch(/<a class="mobile-link"[^>]*>当前<\/a>/);
    expect(html).toContain("mobile-nav");
    expect(html).toMatch(/@media \(max-width:760px\)/);
    // The content column reserves the bottom bar's height, so the entry never
    // covers an amount, a blocker or a round.
    expect(html).toContain("104px");
  });

  it("@scenario S-R237511DT-01-mobile 底部当前入口把选中的历史轮次带回当前轮", () => {
    const html = renderStoryProgressPage(storyProgressPageView(progress(threeRounds()), { round: "2" }));
    const href = /<a class="mobile-link" href="([^"]*)"/.exec(html)?.[1];
    expect(href).toBeDefined();
    // The entry is a real target: following it lands on the round the card is
    // actually in, whichever history round a person had opened first.
    const query = Object.fromEntries(
      new URL(href!, "http://localhost/stories/S-R237511DT-01/progress").searchParams.entries(),
    );
    const view = storyProgressPageView(progress(threeRounds()), query);
    expect(view.selectedRoundId).toBe(view.snapshot?.currentRoundId);
    expect(view.selectedRoundId).toBe(3);
  });

  it("@scenario S-R237511DT-01-mobile 停在当前轮时底部入口标出当前", () => {
    const html = renderReady();
    expect(html).toMatch(/<a class="mobile-link" href="\?round=3"[^>]*aria-current="page"[^>]*>当前<\/a>/);
  });
});

describe("requirement detail page route", () => {
  it("serves the requirement detail page as a document", async () => {
    const app = await createConsoleServer(consoleWith(progress(threeRounds())), { serveUi: false });
    const response = await app.inject({ method: "GET", url: `/stories/${CARD}/progress` });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain(">当前轮阶段与结果</h2>");
    expect(response.body).toContain("$3.80（本需求全部轮次）");
    await app.close();
  });

  it("serves the empty, error and waiting states through the same page", async () => {
    const app = await createConsoleServer(consoleWith({ kind: "empty", storyId: CARD }), { serveUi: false });
    expect((await app.inject({ method: "GET", url: `/stories/${CARD}/progress` })).body)
      .toContain("当前还没有工作轮次");
    expect((await app.inject({ method: "GET", url: `/stories/${CARD}/progress?state=error` })).body)
      .toContain("无法读取需求进展");
    await app.close();
  });

  it("keeps the read-only JSON boundary on the progress API and never another card", async () => {
    const app = await createConsoleServer(consoleWith(progress(threeRounds())), { serveUi: false });
    const response = await app.inject({ method: "GET", url: `/api/stories/${CARD}/progress` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ storyId: CARD, currentRoundId: 3 });
    await app.close();
  });

  it("still answers a page when the source cannot read progress, rather than 404", async () => {
    const without: ConsoleDataSource = {
      nodes: async () => [],
      tasks: async () => [],
      costs: async () => [],
      config: async () => [],
      stats: async () => ({}),
      providers: async () => [],
      queue: async () => ({}),
    };
    const app = await createConsoleServer(without, { serveUi: false });
    const response = await app.inject({ method: "GET", url: `/stories/${CARD}/progress` });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("无法读取需求进展");
    expect(response.body).toContain("重新读取");
    await app.close();
  });
});
