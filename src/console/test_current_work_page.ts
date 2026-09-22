import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { createConsoleServer, type ConsoleDataSource } from "./server.js";
import { migrate } from "../persistence/migrate.js";
import { seedCurrentWorkDemo } from "./current-work-demo.js";
import { LibsqlCurrentWorkReadPort } from "./current-work-read-port.js";
import {
  REQUIREMENT_WORK_PAGE_PATH,
  TASK_WORK_PAGE_PATH,
  renderCurrentWorkDetailDocument,
  renderRunningOverviewPage,
} from "./current-work-page.js";
import { currentWorkDetailPath } from "./current-work-contracts.js";

/**
 * The running overview and the two detail screens, checked where CODE can
 * observe them: the HTML a server-rendered page puts into the document. The
 * browser layer reads the same markers off the accessibility tree; this file
 * proves the markup that produces them, so the two cannot drift.
 *
 * A test path named `test_*.ts` matches the repository's own discovery
 * convention (vitest include) without colliding with the test paths SPECIFY
 * froze.
 */

const REQUIREMENT_ID = "R-237511dd5162";
const CARD_ID = "S-R237511DT-02";

/** Every client opened here, closed after each test. */
const clients: Client[] = [];

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
});

/** A private store with the declared sample, exactly as the review serves it. */
async function demoStore(): Promise<Client> {
  const client = createClient({ url: ":memory:" });
  clients.push(client);
  await migrate(client);
  await seedCurrentWorkDemo(client, 1_700_000_000_000);
  return client;
}

async function demoPort(): Promise<LibsqlCurrentWorkReadPort> {
  return new LibsqlCurrentWorkReadPort(await demoStore(), () => 1_700_000_000_000);
}

/** The overview document a person opens at `/`. */
async function overviewHtml(): Promise<string> {
  const port = await demoPort();
  const read = await port.readRunningOverview();
  if (read.kind !== "ok") throw new Error(`overview read failed: ${read.message}`);
  return renderRunningOverviewPage(
    { alert: { count: 0, heading: "费用已超限 0", rows: [] } },
    { entries: read.snapshot.entries },
  );
}

async function detailHtml(
  read: (port: LibsqlCurrentWorkReadPort) => ReturnType<LibsqlCurrentWorkReadPort["readRequirementDetail"]>,
): Promise<string> {
  const result = await read(await demoPort());
  if (result.kind !== "ok") throw new Error(`detail read answered ${result.kind}`);
  return renderCurrentWorkDetailDocument(result.detail);
}

function sourceWith(port: LibsqlCurrentWorkReadPort): ConsoleDataSource {
  return {
    nodes: async () => [],
    tasks: async () => [],
    costs: async () => [],
    config: async () => [],
    stats: async () => ({}),
    providers: async () => [],
    queue: async () => ({}),
    overLimitRequirements: async () => [],
    currentWork: port,
  };
}

describe("the running overview reaches both kinds of card", () => {
  it("@scenario S-R237511DT-03-overview 运行中同时列出需求与任务并各带查看详情入口", async () => {
    const html = await overviewHtml();

    expect(html).toContain("<h1>运行总览</h1>");
    expect(html).toContain(">运行中 <");
    expect(html).toContain("Hivemind 的 web 管理后台");
    expect(html).toContain("费用投影核对");
    expect(html).toContain('aria-label="Hivemind 的 web 管理后台 · 需求 · 绘制原型"');
    expect(html).toContain('aria-label="费用投影核对 · 任务 · 编写改动"');
    expect(html).toContain(`href="${currentWorkDetailPath({ kind: "requirement", requirementId: REQUIREMENT_ID })}"`);
    expect(html).toContain(`href="${currentWorkDetailPath({ kind: "task", cardId: CARD_ID, requirementId: REQUIREMENT_ID })}"`);
    expect(html).toContain("查看详情");
  });

  it("@scenario S-R237511DT-03-overview 任务不会被称作需求也不能由内部编号代替标题", async () => {
    const html = await overviewHtml();

    // The task row names itself a task, and the internal id is a route handle
    // rather than the title a person reads.
    expect(html).not.toContain(`>${CARD_ID}<`);
    expect(html).not.toContain(`aria-label="${CARD_ID}`);
    expect(html).toContain('aria-label="费用投影核对 · 任务 · 编写改动"');
  });
});

describe("a requirement opens on its current round", () => {
  it("@scenario S-R237511DT-03-requirement 需求详情以标题和需求身份打开当前轮", async () => {
    const html = await detailHtml((port) => port.readRequirementDetail(REQUIREMENT_ID));

    expect(html).toContain("<h1>Hivemind 的 web 管理后台</h1>");
    expect(html).toContain("需求 · 运行中");
    expect(html).toContain('role="tab" aria-selected="true">当前轮<');
    expect(html).toContain("当前轮阶段与结果");
    expect(html).toContain("阶段：绘制原型");
    expect(html).toContain("已取得的结果：页面清单与浅色运行控制台方向已批准");
    expect(html).toContain("卡点");
    expect(html).toContain("等待原型出口检查");
    expect(html).toContain("本轮费用");
    expect(html).toContain("$3.84（本需求当前轮）");
  });

  it("@scenario S-R237511DT-03-requirement 历史轮次不自动展开且默认内容不含工作记录", async () => {
    const html = await detailHtml((port) => port.readRequirementDetail(REQUIREMENT_ID));

    expect(html).toContain("<details");
    expect(html).not.toContain("<details open");
    expect(html).not.toContain("10:14:08");
  });
});

describe("a task opens on its current round", () => {
  it("@scenario S-R237511DT-03-task 任务详情以标题和任务身份打开当前轮", async () => {
    const html = await detailHtml((port) => port.readTaskDetail(CARD_ID));

    expect(html).toContain("<h1>费用投影核对</h1>");
    expect(html).toContain("任务 · 运行中");
    expect(html).toContain('role="tab" aria-selected="true">当前轮<');
    expect(html).toContain("阶段：编写改动");
    expect(html).toContain("已取得的结果：2 项验收已通过");
    expect(html).toContain("费用口径仍有 1 项待核对");
    expect(html).toContain("$1.24（本任务当前轮）");
  });

  it("@scenario S-R237511DT-03-task 任务详情不冒充需求且不以内部编号为标题", async () => {
    const html = await detailHtml((port) => port.readTaskDetail(CARD_ID));

    expect(html).not.toContain(`<h1>${CARD_ID}</h1>`);
    expect(html).not.toContain("需求 S-");
    expect(html).not.toContain("<details open");
  });
});

describe("a requirement lists the tasks running under it", () => {
  it("@scenario S-R237511DT-03-taskentry 需求详情给出所属任务的标题、身份与入口", async () => {
    const html = await detailHtml((port) => port.readRequirementDetail(REQUIREMENT_ID));

    expect(html).toContain("所属任务");
    expect(html).toContain('aria-label="费用投影核对 · 任务 · 运行中"');
    expect(html).toContain(`href="/stories/${CARD_ID}/detail"`);
  });

  it("@scenario S-R237511DT-03-taskentry 任务入口指向任务详情而不是需求费用摘要", async () => {
    const port = await demoPort();
    const task = await port.readTaskDetail(CARD_ID);
    if (task.kind !== "ok") throw new Error(`task read answered ${task.kind}`);

    expect(task.detail.kind).toBe("task");
    expect(task.detail.currentRound.costUsd).toBe(1.24);
    expect(TASK_WORK_PAGE_PATH).toBe("/stories/:cardId/detail");
    expect(REQUIREMENT_WORK_PAGE_PATH).toBe("/requirements/:requirementId/detail");
  });
});

describe("the console serves the running overview and both detail routes", () => {
  it("@scenario S-R237511DT-03-overview 打开首屏能一路点进任务详情", async () => {
    const app = await createConsoleServer(sourceWith(await demoPort()), { serveUi: false });
    try {
      const overview = await app.inject({ method: "GET", url: "/" });
      expect(overview.statusCode).toBe(200);
      expect(overview.body).toContain("费用投影核对");
      expect(overview.body).toContain(`/stories/${CARD_ID}/detail`);

      const requirement = await app.inject({ method: "GET", url: `/requirements/${REQUIREMENT_ID}/detail` });
      expect(requirement.statusCode).toBe(200);
      expect(requirement.body).toContain("Hivemind 的 web 管理后台");

      const task = await app.inject({ method: "GET", url: `/stories/${CARD_ID}/detail` });
      expect(task.statusCode).toBe(200);
      expect(task.body).toContain("费用投影核对");

      const missing = await app.inject({ method: "GET", url: "/stories/S-missing/detail" });
      expect(missing.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
