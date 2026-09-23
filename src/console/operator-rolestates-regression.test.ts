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

const role = "verifier";
const draftPrompt = "保留这段尚未提交的验证说明";

function draftQuery(state: "error" | "waiting"): URLSearchParams {
  return new URLSearchParams({
    role,
    prompt: draftPrompt,
    provider: "deepseek",
    model: "deepseek-chat",
    state,
  });
}

function visibleText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, "");
}

describe("deployed role configuration states", () => {
  it("@scenario S-R237511MB-02-rolestates retains the unsubmitted role prompt when configuration loading fails", async () => {
    const app = await createConsoleServer(data, { serveUi: false });

    const response = await app.inject({
      method: "GET",
      url: `/operator/roles?${draftQuery("error").toString()}`,
      remoteAddress: "127.0.0.1",
    });

    expect(response.statusCode).toBe(200);
    expect(visibleText(response.body)).toContain("无法读取角色配置");
    expect(response.body).toMatch(/<button[^>]*>重新读取<\/button>/);
    expect(visibleText(response.body)).toContain(draftPrompt);
    await app.close();
  });

  it("@scenario S-R237511MB-02-rolestates retains the same role prompt while save confirmation is pending", async () => {
    const app = await createConsoleServer(data, { serveUi: false });

    const response = await app.inject({
      method: "GET",
      url: `/operator/roles?${draftQuery("waiting").toString()}`,
      remoteAddress: "127.0.0.1",
    });

    expect(response.statusCode).toBe(200);
    expect(visibleText(response.body)).toContain("保存结果尚未确认，确认后将自动刷新");
    expect(response.body).toContain(`<textarea id="role-prompt" name="prompt">${draftPrompt}</textarea>`);
    await app.close();
  });
});
