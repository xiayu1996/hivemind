import { describe, expect, it } from "vitest";
import { createConsoleServer, type ConsoleDataSource } from "./server.js";
import {
  renderCostsPage,
  renderOperatorAccessPage,
  renderRecordsPage,
  renderRolesPage,
  type CostsPageView,
  type RecordsPageView,
  type RolesPageView,
} from "./operator-screens.js";
import {
  buildCostSnapshot,
  createRoleConfigurationPort,
  readWorkRecord,
  searchWorkRecords,
  type ConsoleNetworkRange,
  type CostLedgerEntry,
  type RoleConfigurationVersion,
  type WorkRecordEntry,
} from "./operator-contract.js";
import { createMobileConsoleSample, SAMPLE_NETWORKS } from "./operator-sample.js";

const TIME_ZONE = "Asia/Shanghai";
const GENERATED_AT = "2026-09-07T16:01:00.000Z";

function heading(html: string, text: string): boolean {
  return new RegExp(`<h[1-6][^>]*>${text}</h[1-6]>`).test(html);
}

function button(html: string, text: string): boolean {
  return new RegExp(`<button[^>]*>${text}</button>`).test(html);
}

/** The page's own words, with markup removed: what a reader sees, which is
 * what the accessibility tree merges into one text node. */
function visibleText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"');
}

function costEntries(): CostLedgerEntry[] {
  return [
    { id: "start", occurredAt: "2026-08-31T16:00:00.000Z", requirementId: "R-1", requirementTitle: "Investigate delivery", provider: "deepseek", modelId: "deepseek-chat", billing: "metered", costUsd: "7.00" },
    { id: "end", occurredAt: "2026-09-07T15:59:59.999Z", requirementId: "R-2", requirementTitle: "Verify release", provider: "openai-codex", modelId: "gpt-5.6-sol", billing: "metered", costUsd: "5.40" },
    { id: "subscription", occurredAt: "2026-09-03T04:00:00.000Z", requirementId: "R-2", requirementTitle: "Verify release", provider: "openai-codex", modelId: "gpt-5.6-sol", billing: "subscription", costUsd: "9.99" },
  ];
}

function recordEntries(): WorkRecordEntry[] {
  return [
    { recordId: "previous", workId: "work-1", sequence: 1, occurredAt: "2026-09-05T06:19:00.000Z", role: "coder", content: "Earlier context." },
    { recordId: "current", workId: "work-1", sequence: 2, occurredAt: "2026-09-05T06:20:00.000Z", role: "verifier", content: "配额不足，无法继续。" },
    { recordId: "next", workId: "work-1", sequence: 3, occurredAt: "2026-09-05T06:21:00.000Z", role: "coder", content: "Later context." },
  ];
}

const costQuery = { timeZone: TIME_ZONE, startDateInclusive: "2026-09-01", endDateInclusive: "2026-09-07" } as const;

function costsView(overrides: Partial<CostsPageView> = {}): CostsPageView {
  return { state: "ready", query: costQuery, ...overrides };
}

function recordsView(overrides: Partial<RecordsPageView> = {}): RecordsPageView {
  return {
    state: "ready",
    query: { timeZone: TIME_ZONE, startDateInclusive: "2026-09-05", endDateInclusive: "2026-09-05", role: "verifier", keyword: "配额" },
    ...overrides,
  };
}

const roleSeed = {
  versions: [
    { version: 10, configuration: { role: "verifier", prompt: "Review work.", provider: "openai-codex", modelId: "gpt-5.6-sol" }, createdAt: "2026-09-01T00:00:00.000Z", createdBy: "owner" },
    { version: 11, configuration: { role: "verifier", prompt: "Check evidence.", provider: "deepseek", modelId: "deepseek-chat" }, createdAt: "2026-09-02T00:00:00.000Z", createdBy: "owner" },
  ] satisfies RoleConfigurationVersion[],
  availableProviders: [
    { provider: "deepseek", modelIds: ["deepseek-chat"] },
    { provider: "openai-codex", modelIds: ["gpt-5.6-sol"] },
  ],
  now: () => GENERATED_AT,
};

describe("mobile console screens", () => {
  it("@scenario S-R237511MB-02-access shows only the denial, the allowed networks and the recheck", () => {
    const html = renderOperatorAccessPage({ allowed: false, allowedNetworkLabels: ["家庭网络", "办公室网络"], recheckPath: "/access" });

    expect(heading(html, "当前设备无法进入后台")).toBe(true);
    expect(button(html, "重新检查")).toBe(true);
    expect(html).toContain("家庭网络");
    expect(html).toContain("办公室网络");
    expect(html).not.toContain('<nav class="nav"');
    expect(html).not.toContain('class="nav-link"');
    expect(html).not.toContain("费用分析");
    expect(html).not.toContain("工作记录");
  });

  it("@scenario S-R237511MB-02-costscope states the total, the inclusive range and the billing basis", () => {
    const snapshot = buildCostSnapshot(costEntries(), costQuery, GENERATED_AT);
    const html = renderCostsPage(costsView({ snapshot }));

    expect(heading(html, "费用分析")).toBe(true);
    expect(visibleText(html)).toContain("累计费用 $12.40");
    expect(visibleText(html)).toContain("2026-09-01 至 2026-09-07");
    expect(html).toContain(TIME_ZONE);
    expect(visibleText(html)).toContain("仅计入按次计费");
    expect(visibleText(html)).toContain("不计入按次合计");
    expect(visibleText(html)).not.toContain("已暂停");
  });

  it("@scenario S-R237511MB-02-costbreakdown lists every visible field and sums to the filtered total", () => {
    const snapshot = buildCostSnapshot(costEntries(), { ...costQuery, provider: "deepseek" }, GENERATED_AT);
    const html = renderCostsPage(costsView({ snapshot }));

    expect(heading(html, "供应商与模型明细")).toBe(true);
    expect(visibleText(html)).toContain("2026-09-01");
    expect(visibleText(html)).toContain("R-1 Investigate delivery");
    expect(visibleText(html)).toContain("deepseek");
    expect(visibleText(html)).toContain("deepseek-chat");
    expect(visibleText(html)).toContain("$7.00");
    expect(visibleText(html)).toContain("累计费用 $7.00");
  });

  it("@scenario S-R237511MB-02-coststates names the range while loading and keeps the conditions on failure", () => {
    const loading = renderCostsPage(costsView({ state: "loading" }));
    expect(visibleText(loading)).toContain("正在读取 2026-09-01 至 2026-09-07 的费用");
    expect(loading).toContain("2026-09-01");

    const failed = renderCostsPage(costsView({
      state: "unavailable",
      failure: { code: "unavailable", detail: "ledger offline", retryable: true },
    }));
    expect(visibleText(failed)).toContain("无法读取费用");
    expect(button(failed, "重新读取")).toBe(true);
    expect(failed).toContain('value="2026-09-01"');
    expect(failed).toContain('value="2026-09-07"');
    expect(failed).toContain(`value="${TIME_ZONE}"`);

    const waiting = renderCostsPage(costsView({ state: "waiting", refreshAfter: GENERATED_AT }));
    expect(visibleText(waiting)).toContain("今日费用仍在产生，有新费用入账时自动刷新");
  });

  it("@scenario S-R237511MB-02-recordsearch shows the marked keyword, the full record and its neighbours", () => {
    const query = recordsView().query;
    const page = searchWorkRecords(recordEntries(), query);
    const detail = readWorkRecord(recordEntries(), "current", { revision: page.revision, workStillRunning: false });
    const html = renderRecordsPage(recordsView({ page, ...(detail === null ? {} : { detail }) }));

    expect(heading(html, "工作记录")).toBe(true);
    expect(visibleText(html)).toContain("【配额】不足");
    expect(visibleText(html)).toContain("上一条");
    expect(visibleText(html)).toContain("下一条");
    expect(visibleText(html)).toContain("Earlier context.");
    expect(visibleText(html)).toContain("Later context.");
    expect(visibleText(html)).toContain("验证者");
  });

  it("@scenario S-R237511MB-02-recordstates keeps the conditions on failure and says when the next record arrives", () => {
    const failed = renderRecordsPage(recordsView({
      state: "unavailable",
      failure: { code: "unavailable", detail: "records offline", retryable: true },
    }));
    expect(visibleText(failed)).toContain("无法读取工作记录");
    expect(button(failed, "重新查询")).toBe(true);
    expect(failed).toContain('value="verifier"');
    expect(failed).toContain('value="配额"');

    const empty = renderRecordsPage(recordsView({ state: "empty" }));
    expect(visibleText(empty)).toContain("没有匹配记录，请修改时间、角色或关键词");

    const waiting = renderRecordsPage(recordsView({ state: "waiting", refreshAfter: GENERATED_AT }));
    expect(visibleText(waiting)).toContain("后续记录尚未产生，产生后将自动刷新");
  });

  it("@scenario S-R237511MB-02-rolesave previews the change and states who the save affects", async () => {
    const port = createRoleConfigurationPort(roleSeed);
    const view = await port.readRole("verifier");
    const draft = { role: "verifier", prompt: "Verify behavior and evidence.", provider: "openai-codex", modelId: "gpt-5.6-sol" };
    const preview = port.previewRoleChange(view!.current, draft, view!.availableProviders);
    const options: RolesPageView = { state: "ready", role: "verifier", view: view!, draft, confirmation: { kind: "save", role: "verifier", preview } };
    const html = renderRolesPage(options);

    expect(heading(html, "保存验证者配置")).toBe(true);
    expect(visibleText(html)).toContain("只影响之后新开始的验证者");
    expect(button(html, "确认保存")).toBe(true);
    expect(button(html, "取消")).toBe(true);

    const invalidPreview = port.previewRoleChange(view!.current, { ...view!.current.configuration, modelId: "gpt-5.6-sol" }, view!.availableProviders);
    const invalid = renderRolesPage({ state: "ready", role: "verifier", view: view!, confirmation: { kind: "save", role: "verifier", preview: invalidPreview } });
    expect(visibleText(invalid)).toContain("所选模型不属于该供应商，请重新选择");
    expect(button(invalid, "确认保存")).toBe(false);
  });

  it("@scenario S-R237511MB-02-rolerestore lays out the current and previous versions and offers the restore", async () => {
    const port = createRoleConfigurationPort(roleSeed);
    const view = await port.readRole("verifier");
    const html = renderRolesPage({ state: "ready", role: "verifier", view: view! });

    expect(heading(html, "当前版")).toBe(true);
    expect(heading(html, "上一版")).toBe(true);
    expect(button(html, "恢复上一版")).toBe(true);
    expect(visibleText(html)).toContain("变更");
    expect(visibleText(html)).toContain("只影响之后新开始的验证者");
  });

  it("@scenario S-R237511MB-02-rolestates says there is no previous version and keeps the retry", async () => {
    const port = createRoleConfigurationPort({ ...roleSeed, versions: [roleSeed.versions[0]!] });
    const view = await port.readRole("verifier");
    const html = renderRolesPage({ state: "ready", role: "verifier", view: view! });

    expect(visibleText(html)).toContain("当前角色还没有上一版，保存一次改动后即可对照");

    const failed = renderRolesPage({ state: "unavailable", role: "verifier", failure: { code: "unavailable", detail: "roles offline", retryable: true } });
    expect(visibleText(failed)).toContain("无法读取角色配置");
    expect(button(failed, "重新读取")).toBe(true);

    const waiting = renderRolesPage({
      state: "waiting",
      role: "verifier",
      view: view!,
      draft: { ...view!.current.configuration, prompt: "Unsaved draft" },
      refreshAfter: GENERATED_AT,
    });
    expect(visibleText(waiting)).toContain("保存结果尚未确认，确认后将自动刷新");
    expect(visibleText(waiting)).toContain("Unsaved draft");
  });
});

const data: ConsoleDataSource = {
  nodes: async () => [],
  tasks: async () => [],
  costs: async () => [],
  config: async () => [],
  stats: async () => ({}),
  providers: async () => [],
  queue: async () => ({ waiting: [], running: [], providerSlots: [] }),
};

const HOME: readonly ConsoleNetworkRange[] = [
  { id: "home", label: "家庭网络", cidrs: ["192.168.1.0/24"] },
  { id: "office", label: "办公室网络", cidrs: ["10.0.0.0/8"] },
];

async function consoleWith(allowed: boolean) {
  const networks = allowed ? SAMPLE_NETWORKS : HOME;
  return createConsoleServer(data, {
    serveUi: false,
    screens: createMobileConsoleSample({ networks }),
  });
}

/** An HTML form post, the only write the role screen accepts. */
function roleForm(body: Record<string, string>) {
  return {
    method: "POST" as const,
    url: "/operator/roles",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams(body).toString(),
  };
}

describe("mobile console routes", () => {
  it("@scenario S-R237511MB-02-access refuses every data route from outside the allowed networks", async () => {
    const app = await consoleWith(false);
    for (const route of ["/operator/costs", "/operator/records", "/operator/roles"]) {
      const response = await app.inject({ method: "GET", url: route });
      expect(response.statusCode).toBe(403);
      expect(response.body).toContain("当前设备无法进入后台");
      expect(response.body).toContain("重新检查");
      expect(response.body).not.toContain('class="nav-link"');
    }
    await app.close();
  });

  it("@scenario S-R237511MB-02-costscope serves the accumulated cost over the selected range", async () => {
    const app = await consoleWith(true);
    const response = await app.inject({ method: "GET", url: "/operator/costs?timeZone=Asia%2FShanghai&start=2026-09-01&end=2026-09-07" });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("累计费用 $12.40");
    expect(response.body).toContain("2026-09-01 至 2026-09-07");
    await app.close();
  });

  it("@scenario S-R237511MB-02-recordsearch serves the matched record with its neighbours", async () => {
    const app = await consoleWith(true);
    const response = await app.inject({ method: "GET", url: "/operator/records?start=2026-09-05&end=2026-09-05&role=verifier&keyword=%E9%85%8D%E9%A2%9D" });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("工作记录");
    expect(visibleText(response.body)).toContain("【配额】不足");
    expect(visibleText(response.body)).toContain("上一条");
    expect(visibleText(response.body)).toContain("下一条");
    await app.close();
  });

  it("@scenario S-R237511MB-02-rolesave saves a confirmed change as a new version and creates none without confirmation", async () => {
    const app = await consoleWith(true);
    const changed = { role: "verifier", action: "save", prompt: "Verify behavior and evidence.", provider: "openai-codex", model: "gpt-5.6-sol" };

    const preview = await app.inject(roleForm(changed));
    expect(preview.statusCode).toBe(200);
    expect(preview.body).toContain("只影响之后新开始的验证者");
    expect(preview.body).toContain("确认保存");

    const cancelled = await app.inject(roleForm({ ...changed, cancel: "1" }));
    expect(cancelled.body).not.toContain("已保存为第 12 版");

    const saved = await app.inject(roleForm({ ...changed, confirm: "1" }));
    expect(saved.body).toContain("已保存为第 12 版");

    const incompatible = await app.inject(roleForm({ role: "verifier", action: "save", provider: "deepseek", model: "gpt-5.6-sol", confirm: "1" }));
    expect(visibleText(incompatible.body)).toContain("所选模型不属于该供应商，请重新选择");
    expect(incompatible.body).not.toContain("已保存为第");
    await app.close();
  });

  it("@scenario S-R237511MB-02-rolerestore restores the previous version without deleting history", async () => {
    const app = await consoleWith(true);

    const restore = await app.inject(roleForm({ role: "verifier", action: "restore", sourceVersion: "10", confirm: "1" }));
    expect(restore.body).toContain("已恢复上一版并保存为第 12 版");

    const browse = await app.inject({ method: "GET", url: "/operator/roles?role=verifier" });
    expect(browse.body).toContain("当前版");
    expect(browse.body).toContain("上一版");
    await app.close();
  });
});
