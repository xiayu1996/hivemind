import { createClient, type Client } from "@libsql/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { migrate } from "../persistence/migrate.js";
import { LibsqlConsoleDataSource } from "./libsql-data-source.js";
import { seedOverviewDemo } from "./overview-demo.js";
import { createOverviewPage } from "./overview-page.js";
import { createConsoleServer } from "./server.js";

const clients: Client[] = [];
const directories: string[] = [];

async function demoServer(): Promise<FastifyInstance> {
  const directory = await mkdtemp(join(tmpdir(), "overview-todo-"));
  directories.push(directory);
  const client = createClient({ url: `file:${join(directory, "demo.db")}` });
  clients.push(client);
  await migrate(client);
  await seedOverviewDemo(client, Date.now());
  return createConsoleServer(new LibsqlConsoleDataSource(client, async () => []), {
    overviewPage: createOverviewPage(),
  });
}

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

/**
 * The waiting rail's action is only useful if it lands on the item it names.
 * Every open todo the overview lists has to resolve to its own page, and a
 * requirement with nothing waiting has to say so rather than 404.
 */
describe("todo handling page", () => {
  it("@scenario S-R237511OV-01-todo opens the waiting item behind each handle action", async () => {
    const app = await demoServer();

    const reply = await app.inject({ method: "GET", url: "/todo?requirement=R-PAY" });
    expect(reply.statusCode).toBe(200);
    expect(reply.body).toContain("<h1>支付重试规则</h1>");
    expect(reply.body).toContain("需要答复");
    expect(reply.body).toContain("已等待 2 小时");
    expect(reply.body).toContain("失败后重试多久？");

    const choice = await app.inject({ method: "GET", url: "/todo?requirement=R-TZ" });
    expect(choice.statusCode).toBe(200);
    expect(choice.body).toContain("<h1>费用统计时区</h1>");
    expect(choice.body).toContain("需要选择");
    expect(choice.body).toContain("使用哪个时区？");
    expect(choice.body).toContain("上海");
    expect(choice.body).toContain("伦敦");

    const approval = await app.inject({ method: "GET", url: "/todo?requirement=R-PRD" });
    expect(approval.statusCode).toBe(200);
    expect(approval.body).toContain("<h1>后台首屏</h1>");
    expect(approval.body).toContain("需要批准");

    await app.close();
  });

  it("@scenario S-R237511OV-01-todo names the state instead of a blank page when nothing is waiting", async () => {
    const app = await demoServer();

    const handled = await app.inject({ method: "GET", url: "/todo?requirement=R-ACTIVE" });
    expect(handled.statusCode).toBe(200);
    expect(handled.body).toContain("没有等待处理的待办");
    expect(handled.body).toContain("返回运行总览");

    const unnamed = await app.inject({ method: "GET", url: "/todo" });
    expect(unnamed.statusCode).toBe(200);
    expect(unnamed.body).toContain("没有等待处理的待办");

    await app.close();
  });
});
