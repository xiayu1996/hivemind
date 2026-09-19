import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AppUnderReview } from "../verify/app-under-review.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const TSX = fileURLToPath(new URL("../../node_modules/tsx/dist/cli.mjs", import.meta.url));
const ENTRY = fileURLToPath(new URL("../../scripts/serve-console.ts", import.meta.url));

function section(document: string, startMarker: string, endMarker: string): string {
  const start = document.indexOf(startMarker);
  const end = document.indexOf(endMarker, start + 1);
  return document.slice(start, end < 0 ? undefined : end);
}

// The application a verification round starts: the repository's own command,
// with {port} where the port goes. Without the substitution the application
// exits before it answers, which is exactly what the red commits recorded.
async function inspectOverview(inspect: (html: string) => void, path = "/"): Promise<void> {
  const app = new AppUnderReview();
  const started = await app.start({
    cwd: ROOT,
    command: [process.execPath, TSX, ENTRY, "--port", "{port}"],
    readyUrl: "http://127.0.0.1:{port}/",
    timeoutMs: 20_000,
  });

  try {
    expect(started.started, started.started ? undefined : started.reason).toBe(true);
    if (!started.started) return;
    expect(started.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/u);
    expect(started.url).not.toContain("{port}");
    const response = await fetch(new URL(path, started.url));
    expect(response.status).toBe(200);
    inspect(await response.text());
  } finally {
    await app.stop();
  }
}

describe("the overview started by a verification round with its dynamic port", () => {
  it("@scenario S-R237511OV-01-todo shows every open item once with its wait and action after allocating the review port", async () => {
    await inspectOverview((html) => {
      const todos = section(html, 'id="todos-title"', 'id="active-title"');
      expect(todos).toContain("等待本人处理 <span class=\"heading-count\">3 项");
      expect(todos).toContain("需要答复");
      expect(todos).toContain("需要选择");
      expect(todos).toContain("需要批准");
      expect(todos).toContain("已等待");
      expect(todos).toContain("/todo?requirement=R-PAY");
      expect(todos).toContain("/todo?requirement=R-TZ");
      expect(todos).toContain("/todo?requirement=R-PRD");
    });
  });
  it("@scenario S-R237511OV-01-active shows the declared running requirement and tasks after allocating the review port", async () => {
    await inspectOverview((html) => {
      const active = section(html, 'id="active-title"', 'id="failures-title"');
      expect(active).toContain("运行中 <span class=\"heading-count\">3 项");
      expect(active).toContain('aria-label="重试退避 任务 CODE 运行中"');
      expect(active).toContain('aria-label="重试策略收敛 需求 SOLUTION 运行中"');
      expect(active).toContain('aria-label="异常归类 任务 VERIFY 运行中"');
      expect(active.indexOf("重试退避")).toBeLessThan(active.indexOf("重试策略收敛"));
      expect(active.indexOf("重试策略收敛")).toBeLessThan(active.indexOf("异常归类"));
    });
  });
  it("@scenario S-R237511OV-01-failures shows both current failures in newest-first order after allocating the review port", async () => {
    await inspectOverview((html) => {
      const failures = section(html, 'id="failures-title"', 'id="completed-title"');
      expect(failures).toContain("失败 <span class=\"heading-count\">2 项");
      expect(failures).toContain('aria-label="账单导出 任务 VERIFY 失败 验收未通过 ');
      expect(failures).toContain('aria-label="账单导出规则 需求 SOLUTION 失败 方案无法形成 ');
      expect(failures.indexOf("账单导出")).toBeLessThan(failures.indexOf("账单导出规则"));
    });
  });
  it("@scenario S-R237511OV-01-recent7d shows in-range completions in newest-first order after allocating the review port", async () => {
    await inspectOverview((html) => {
      const completed = section(html, 'id="completed-title"', '<aside class="stack"');
      expect(completed).toContain("最近完成 <span class=\"heading-count\">2 项");
      expect(completed).toContain("状态投影核对");
      expect(completed).toContain("候选词表更新");
      expect(completed).toContain("已完成");
      expect(completed.indexOf("状态投影核对")).toBeLessThan(completed.indexOf("候选词表更新"));
    });
  });
  it("@scenario S-R237511OV-01-refresh exposes automatic refresh and the current stage after allocating the review port", async () => {
    await inspectOverview((html) => {
      const active = section(html, 'id="active-title"', 'id="failures-title"');
      expect(html).toContain("/assets/overview.js");
      expect(html).toContain('id="refreshed-at"');
      expect(html).toContain("每 30 秒自动刷新");
      expect(active).toContain('aria-label="重试退避 任务 CODE 运行中"');
    });
  });
  it("@scenario S-R237511OV-01-costs shows the seven-day dollar summary and continuing overrun after allocating the review port", async () => {
    await inspectOverview((html) => {
      const summary = section(html, '<aside class="stack"', "</aside>");
      expect(summary).toContain("USD $20.00");
      expect(summary).toContain("统计范围");
      expect(summary).toContain("Asia/Shanghai");
      expect(summary).toContain("已花 USD $20.00 / 上限 USD $15.00");
      expect(summary).toContain("已超限");
      expect(summary).toContain("工作仍继续");
    });
  });
  it("@scenario S-R237511OV-01-responsive renders both navigations and the fixed section order on the started page", async () => {
    await inspectOverview((html) => {
      expect(html).toContain('aria-label="主要导航"');
      expect(html).toContain('aria-label="手机导航"');
      const positions = ["id=\"todos-title\"", "id=\"active-title\"", "id=\"failures-title\"", "id=\"completed-title\""]
        .map((marker) => html.indexOf(marker));
      expect(positions.every((position) => position >= 0)).toBe(true);
      for (let index = 1; index < positions.length; index += 1) {
        expect(positions[index - 1]).toBeLessThan(positions[index]);
      }
      expect(html).toContain('aria-label="总览摘要"');
    });
  });
  it("@scenario S-R237511OV-01-states shows the empty state rather than a blank page", async () => {
    await inspectOverview((html) => {
      const body = section(html, 'id="overview-body"', "</main>");
      expect(body).toContain("当前没有运行事项");
      expect(body).toContain("查看工作记录");
    }, "/?state=empty");
  });
  it("@scenario S-R237511OV-01-states shows the error state rather than a blank page", async () => {
    await inspectOverview((html) => {
      const body = section(html, 'id="overview-body"', "</main>");
      expect(body).toContain("无法读取运行总览");
      expect(body).toContain("重新读取");
    }, "/?state=error");
  });
  it("@scenario S-R237511OV-01-states shows the loading state rather than a blank page", async () => {
    await inspectOverview((html) => {
      const body = section(html, 'id="overview-body"', "</main>");
      expect(body).toContain("正在读取运行情况");
      expect(body).toContain("正在读取等待本人处理、运行中、失败和最近完成");
    }, "/?state=loading");
  });
  it("@scenario S-R237511OV-01-states shows the waiting state rather than a blank page", async () => {
    await inspectOverview((html) => {
      const body = section(html, 'id="overview-body"', "</main>");
      expect(body).toContain("运行结果尚未产生");
      expect(body).toContain("在 1 分钟内自动刷新");
    }, "/?state=waiting");
  });
  it("@scenario S-R237511OV-01-todo leaves a handled item out of the waiting rail", async () => {
    await inspectOverview((html) => {
      const todos = section(html, 'id="todos-title"', 'id="active-title"');
      expect(todos).not.toContain("已经处理的需求");
      expect(todos).not.toContain("R-HANDLED");
    });
  });
  it("@scenario S-R237511OV-01-active does not mix waiting, failed, or completed work into the running section", async () => {
    await inspectOverview((html) => {
      const active = section(html, 'id="active-title"', 'id="failures-title"');
      expect(active).not.toContain("支付重试规则");
      expect(active).not.toContain("账单导出");
      expect(active).not.toContain("状态投影核对");
    });
  });
  it("@scenario S-R237511OV-01-failures leaves a recovered historical failure out of the current failure section", async () => {
    await inspectOverview((html) => {
      const failures = section(html, 'id="failures-title"', 'id="completed-title"');
      expect(failures).not.toContain("已经恢复的导出");
      expect(failures).not.toContain("旧失败");
    });
  });
  it("@scenario S-R237511OV-01-recent7d leaves old completions and running work out of the completed section", async () => {
    await inspectOverview((html) => {
      const completed = section(html, 'id="completed-title"', '<aside class="stack"');
      expect(completed).not.toContain("旧任务");
      expect(completed).not.toContain("旧需求归档");
      expect(completed).not.toContain("重试退避");
    });
  });
  it("@scenario S-R237511OV-01-refresh does not show the same task at an unobserved later stage", async () => {
    await inspectOverview((html) => {
      const active = section(html, 'id="active-title"', 'id="failures-title"');
      expect(active).not.toContain('aria-label="重试退避 任务 VERIFY 运行中"');
      // The name appears in both the row's accessible label and its name cell,
      // so a raw-name count of two would count one row twice. Count the row.
      expect(active.match(/aria-label="重试退避 任务 CODE 运行中"/gu)).toHaveLength(1);
    });
  });
});
