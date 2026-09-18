/**
 * Brings the mobile console screens up with sample data and checks, on a real
 * headless browser, that each scenario's declared roles and words are on the
 * page. It is the structural layer (design 08 section 6) run against the
 * delivered screens before a verification round does the same.
 *
 *   npx tsx scripts/smoke-mobile-console.ts
 *
 * Exits non-zero on the first check that fails. Requires this installation's
 * Playwright browser, not the target repository's.
 */
import { chromium } from "playwright";
import { createConsoleServer, listenConsole, type ConsoleDataSource } from "../src/console/server.js";
import { createMobileConsoleSample, SAMPLE_NETWORKS } from "../src/console/operator-sample.js";
import { missingFromSnapshot, type VisibleRequirement } from "../src/verify/aria-snapshot.js";

const data: ConsoleDataSource = {
  nodes: async () => [],
  tasks: async () => [],
  costs: async () => [],
  config: async () => [],
  stats: async () => ({}),
  providers: async () => [],
  queue: async () => ({ waiting: [], running: [], providerSlots: [] }),
};

const RANGE = "timeZone=Asia%2FShanghai&start=2026-09-01&end=2026-09-07";
const RECORD_RANGE = "timeZone=Asia%2FShanghai&start=2026-09-05&end=2026-09-05&role=verifier&keyword=%E9%85%8D%E9%A2%9D";

interface Case {
  scenario: string;
  url: (base: string) => string;
  visible: readonly VisibleRequirement[];
  absent?: readonly string[];
}

const CASES: readonly Case[] = [
  {
    scenario: "S-R237511MB-02-access",
    url: (base) => `${base}/access`,
    visible: [{ role: "heading", text: "当前设备无法进入后台" }, { role: "button", text: "重新检查" }],
    absent: ["运行总览", "费用分析", "角色配置", "工作记录"],
  },
  {
    scenario: "S-R237511MB-02-costscope",
    url: (base) => `${base}/operator/costs?${RANGE}`,
    visible: [
      { role: "heading", text: "费用分析" },
      { role: "text", text: "累计费用 $12.40" },
      { role: "text", text: "2026-09-01 至 2026-09-07" },
    ],
  },
  {
    scenario: "S-R237511MB-02-costbreakdown",
    url: (base) => `${base}/operator/costs?${RANGE}&provider=deepseek`,
    visible: [
      { role: "heading", text: "供应商与模型明细" },
      { role: "text", text: "deepseek-chat" },
      { role: "text", text: "$7.00" },
    ],
  },
  {
    scenario: "S-R237511MB-02-coststates",
    url: (base) => `${base}/operator/costs?${RANGE}&state=error`,
    visible: [{ role: "text", text: "无法读取费用" }, { role: "button", text: "重新读取" }],
  },
  {
    scenario: "S-R237511MB-02-recordsearch",
    url: (base) => `${base}/operator/records?${RECORD_RANGE}`,
    visible: [
      { role: "heading", text: "工作记录" },
      { role: "text", text: "【配额】不足" },
      { role: "text", text: "上一条" },
      { role: "text", text: "下一条" },
    ],
  },
  {
    scenario: "S-R237511MB-02-recordstates",
    url: (base) => `${base}/operator/records?${RECORD_RANGE}&state=error`,
    visible: [{ role: "text", text: "无法读取工作记录" }, { role: "button", text: "重新查询" }],
  },
  {
    scenario: "S-R237511MB-02-rolesave",
    url: (base) => `${base}/operator/roles?role=verifier&action=save&prompt=Verify+behavior+and+evidence.&provider=openai-codex&model=gpt-5.6-sol`,
    visible: [
      { role: "heading", text: "保存验证者配置" },
      { role: "text", text: "只影响之后新开始的验证者" },
      { role: "button", text: "确认保存" },
      { role: "button", text: "取消" },
    ],
  },
  {
    scenario: "S-R237511MB-02-rolerestore",
    url: (base) => `${base}/operator/roles?role=verifier`,
    visible: [
      { role: "heading", text: "当前版" },
      { role: "heading", text: "上一版" },
      { role: "button", text: "恢复上一版" },
    ],
  },
  {
    scenario: "S-R237511MB-02-rolestates",
    url: (base) => `${base}/operator/roles?role=verifier&state=error`,
    visible: [{ role: "text", text: "无法读取角色配置" }, { role: "button", text: "重新读取" }],
  },
];

async function start(allowed: boolean): Promise<{ base: string; close: () => Promise<void> }> {
  const networks = allowed ? SAMPLE_NETWORKS : SAMPLE_NETWORKS.filter((network) => network.id !== "loopback");
  const app = await createConsoleServer(data, {
    serveUi: false,
    screens: createMobileConsoleSample({ networks }),
  });
  const address = await listenConsole(app, { host: "127.0.0.1", port: 0 });
  return { base: address.replace(/\/$/, ""), close: () => app.close() };
}

async function main(): Promise<void> {
  const allowed = await start(true);
  const denied = await start(false);
  const browser = await chromium.launch();
  // The screen this requirement is about: a phone, not a desktop.
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  let failed = 0;
  try {
    for (const item of CASES) {
      const base = item.scenario === "S-R237511MB-02-access" ? denied.base : allowed.base;
      await page.goto(item.url(base), { waitUntil: "load" });
      const snapshot = await page.locator("body").ariaSnapshot();
      const missing = missingFromSnapshot(snapshot, item.visible);
      const leaked = (item.absent ?? []).filter((word) => snapshot.includes(word));
      const overflow = await page.evaluate("document.documentElement.scrollWidth > window.innerWidth + 1");
      const passed = missing.length === 0 && leaked.length === 0 && !overflow;
      if (!passed) failed += 1;
      console.log(`${passed ? "PASS" : "FAIL"} ${item.scenario} ${item.url(base)}`
        + (missing.length > 0 ? ` missing=${missing.map((entry) => `${entry.role}=${entry.text}`).join(",")}` : "")
        + (leaked.length > 0 ? ` leaked=${leaked.join(",")}` : "")
        + (overflow ? " overflows the phone width" : ""));
    }
    // The read APIs carry the same rows the screens do, so a denied peer has to
    // be turned away from them directly and not only from the pages built on top.
    const deniedData = ["/api/costs", "/api/config", "/api/nodes", "/api/queue"];
    for (const route of deniedData) {
      const response = await page.goto(denied.base + route, { waitUntil: "load" });
      const snapshot = await page.locator("body").ariaSnapshot();
      const deniedHeaded = missingFromSnapshot(snapshot, [{ role: "heading", text: "当前设备无法进入后台" }]).length === 0;
      const passed = response?.status() === 403 && deniedHeaded && !snapshot.includes("运行总览");
      if (!passed) failed += 1;
      console.log(`${passed ? "PASS" : "FAIL"} S-R237511MB-02-access ${denied.base}${route}`
        + (passed ? "" : ` status=${response?.status()} deniedPage=${deniedHeaded}`));
    }
  } finally {
    await browser.close();
    await allowed.close();
    await denied.close();
  }
  if (failed > 0) {
    console.error(`${failed} check(s) failed`);
    process.exitCode = 1;
    return;
  }
  console.log(`OK: ${CASES.length} screens match their declared roles and words at a phone width`);
  console.log("OK: the read APIs refuse a peer outside the allowed networks");
  console.log("sample reading range: Asia/Shanghai · 2026-09-01 至 2026-09-07");
}

main().catch((error: unknown) => {
  console.error("FAILED:", error);
  process.exit(1);
});
