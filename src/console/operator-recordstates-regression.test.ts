import { describe, expect, it } from "vitest";
import { createConsoleServer, type ConsoleDataSource } from "./server.js";

const data: ConsoleDataSource = {
  nodes: async () => [],
  tasks: async () => [],
  costs: async () => [],
  config: async () => [],
  stats: async () => ({}),
  providers: async () => [],
  queue: async () => ({}),
};

const query = "timeZone=Asia%2FShanghai&start=2026-09-05&end=2026-09-05&role=verifier&keyword=%E9%85%8D%E9%A2%9D";

function visibleText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, "");
}

describe("deployed work-record states", () => {
  it("@scenario S-R237511MB-02-recordstates opens the failed query with its conditions and retry action", async () => {
    const app = await createConsoleServer(data, { serveUi: false });
    const response = await app.inject({
      method: "GET",
      url: `/operator/records?${query}&state=error`,
      remoteAddress: "127.0.0.1",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain("工作记录");
    expect(response.body).toContain("无法读取工作记录");
    expect(response.body).toMatch(/<button[^>]*>重新查询<\/button>/);
    expect(response.body).toContain('value="2026-09-05"');
    expect(response.body).toContain('value="verifier"');
    expect(response.body).toContain('value="配额"');
    await app.close();
  });

  it.each([
    ["empty", "没有匹配记录，请修改时间、角色或关键词"],
    ["waiting", "后续记录尚未产生，产生后将自动刷新"],
  ] as const)("@scenario S-R237511MB-02-recordstates opens the %s state with its next step", async (state, expectedText) => {
    const app = await createConsoleServer(data, { serveUi: false });
    const response = await app.inject({
      method: "GET",
      url: `/operator/records?${query}&state=${state}`,
      remoteAddress: "127.0.0.1",
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(expectedText);
    expect(response.body).toContain('value="verifier"');
    expect(response.body).toContain('value="配额"');
    await app.close();
  });

  it("@scenario S-R237511MB-02-recordstates names every retained condition while loading", async () => {
    const app = await createConsoleServer(data, { serveUi: false });
    const response = await app.inject({
      method: "GET",
      url: `/operator/records?${query}&state=loading`,
      remoteAddress: "127.0.0.1",
    });

    expect(response.statusCode).toBe(200);
    expect(visibleText(response.body)).toContain("正在读取 2026-09-05 至 2026-09-05 的工作记录");
    expect(visibleText(response.body)).toContain("verifier");
    expect(visibleText(response.body)).toContain("配额");
    await app.close();
  });
});
