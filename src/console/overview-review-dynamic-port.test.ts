import { createClient } from "@libsql/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../persistence/migrate.js";
import { AppUnderReview } from "../verify/app-under-review.js";
import { seedOverviewDemo } from "./overview-demo.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const TSX = fileURLToPath(new URL("../../node_modules/tsx/dist/cli.mjs", import.meta.url));
const ENTRY = fileURLToPath(new URL("../../scripts/serve-console.ts", import.meta.url));

// The dataset these scenarios describe is the test's own, named to the console
// on the command line. The entry otherwise serves a snapshot of the central
// store, which is the right screen for a round to judge and the wrong one for
// a scenario that states how many items are waiting.
let directory: string;
let app: AppUnderReview;
let started: Awaited<ReturnType<AppUnderReview["start"]>>;

// Starting the console builds its shell, so the application is started once for
// the whole file rather than once per scenario; every scenario reads the same
// screen, which is what a round does too.
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "hivemind-overview-review-"));
  const databaseUrl = `file:${join(directory, "console.db")}`;
  const client = createClient({ url: databaseUrl });
  try {
    await migrate(client);
    await seedOverviewDemo(client, Date.now());
  } finally {
    client.close();
  }
  app = new AppUnderReview();
  started = await app.start({
    cwd: ROOT,
    command: [process.execPath, TSX, ENTRY, "--port", "{port}", "--db", databaseUrl],
    readyUrl: "http://127.0.0.1:{port}/",
    timeoutMs: 120_000,
  });
}, 180_000);

afterAll(async () => {
  if (app) await app.stop();
  if (directory) await rm(directory, { recursive: true, force: true });
});

function section(document: string, startMarker: string, endMarker: string): string {
  const start = document.indexOf(startMarker);
  const end = document.indexOf(endMarker, start + 1);
  return document.slice(start, end < 0 ? undefined : end);
}

async function inspectOverview(inspect: (html: string) => void): Promise<void> {
  expect(started.started, started.started ? undefined : started.reason).toBe(true);
  if (!started.started) return;
  expect(started.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/u);
  expect(started.url).not.toContain("{port}");
  const response = await fetch(started.url);
  expect(response.status).toBe(200);
  inspect(await response.text());
}

describe("the overview started by a verification round with its dynamic port", () => {
  it("@scenario S-R237511OV-01-todo shows every open item once with its wait and action after allocating the review port", async () => {
    await inspectOverview((html) => {
      const todos = section(html, 'id="todos-title"', 'id="active-title"');
      expect(todos).toContain("\u7b49\u5f85\u672c\u4eba\u5904\u7406 <span class=\"heading-count\">3 \u9879");
      expect(todos).toContain("\u9700\u8981\u7b54\u590d");
      expect(todos).toContain("\u9700\u8981\u9009\u62e9");
      expect(todos).toContain("\u9700\u8981\u6279\u51c6");
      expect(todos).toContain("\u5df2\u7b49\u5f85");
      expect(todos).toContain("/todo?requirement=R-PAY");
      expect(todos).toContain("/todo?requirement=R-TZ");
      expect(todos).toContain("/todo?requirement=R-PRD");
    });
  });

  it("@scenario S-R237511OV-01-todo leaves a handled item out of the waiting rail", async () => {
    await inspectOverview((html) => {
      const todos = section(html, 'id="todos-title"', 'id="active-title"');
      expect(todos).not.toContain("\u5df2\u7ecf\u5904\u7406\u7684\u9700\u6c42");
      expect(todos).not.toContain("R-HANDLED");
    });
  });

  it("@scenario S-R237511OV-01-active shows the declared running requirement and tasks after allocating the review port", async () => {
    await inspectOverview((html) => {
      const active = section(html, 'id="active-title"', 'id="failures-title"');
      expect(active).toContain("\u8fd0\u884c\u4e2d <span class=\"heading-count\">3 \u9879");
      expect(active).toContain('aria-label="\u91cd\u8bd5\u9000\u907f \u4efb\u52a1 CODE \u8fd0\u884c\u4e2d"');
      expect(active).toContain('aria-label="\u91cd\u8bd5\u7b56\u7565\u6536\u655b \u9700\u6c42 SOLUTION \u8fd0\u884c\u4e2d"');
      expect(active).toContain('aria-label="\u5f02\u5e38\u5f52\u7c7b \u4efb\u52a1 VERIFY \u8fd0\u884c\u4e2d"');
      expect(active.indexOf("\u91cd\u8bd5\u9000\u907f")).toBeLessThan(active.indexOf("\u91cd\u8bd5\u7b56\u7565\u6536\u655b"));
      expect(active.indexOf("\u91cd\u8bd5\u7b56\u7565\u6536\u655b")).toBeLessThan(active.indexOf("\u5f02\u5e38\u5f52\u7c7b"));
    });
  });

  it("@scenario S-R237511OV-01-active does not mix waiting, failed, or completed work into the running section", async () => {
    await inspectOverview((html) => {
      const active = section(html, 'id="active-title"', 'id="failures-title"');
      expect(active).not.toContain("\u652f\u4ed8\u91cd\u8bd5\u89c4\u5219");
      expect(active).not.toContain("\u8d26\u5355\u5bfc\u51fa");
      expect(active).not.toContain("\u72b6\u6001\u6295\u5f71\u6838\u5bf9");
    });
  });

  it("@scenario S-R237511OV-01-failures shows both current failures in newest-first order after allocating the review port", async () => {
    await inspectOverview((html) => {
      const failures = section(html, 'id="failures-title"', 'id="completed-title"');
      expect(failures).toContain("\u5931\u8d25 <span class=\"heading-count\">2 \u9879");
      expect(failures).toContain('aria-label="\u8d26\u5355\u5bfc\u51fa \u4efb\u52a1 VERIFY \u5931\u8d25 \u9a8c\u6536\u672a\u901a\u8fc7 ');
      expect(failures).toContain('aria-label="\u8d26\u5355\u5bfc\u51fa\u89c4\u5219 \u9700\u6c42 SOLUTION \u5931\u8d25 \u65b9\u6848\u65e0\u6cd5\u5f62\u6210 ');
      expect(failures.indexOf("\u8d26\u5355\u5bfc\u51fa")).toBeLessThan(failures.indexOf("\u8d26\u5355\u5bfc\u51fa\u89c4\u5219"));
    });
  });

  it("@scenario S-R237511OV-01-failures leaves a recovered historical failure out of the current failure section", async () => {
    await inspectOverview((html) => {
      const failures = section(html, 'id="failures-title"', 'id="completed-title"');
      expect(failures).not.toContain("\u5df2\u7ecf\u6062\u590d\u7684\u5bfc\u51fa");
      expect(failures).not.toContain("\u65e7\u5931\u8d25");
    });
  });

  it("@scenario S-R237511OV-01-recent7d shows in-range completions in newest-first order after allocating the review port", async () => {
    await inspectOverview((html) => {
      const completed = section(html, 'id="completed-title"', '<aside class="stack"');
      expect(completed).toContain("\u6700\u8fd1\u5b8c\u6210 <span class=\"heading-count\">2 \u9879");
      expect(completed).toContain("\u72b6\u6001\u6295\u5f71\u6838\u5bf9");
      expect(completed).toContain("\u5019\u9009\u8bcd\u8868\u66f4\u65b0");
      expect(completed).toContain("\u5df2\u5b8c\u6210");
      expect(completed.indexOf("\u72b6\u6001\u6295\u5f71\u6838\u5bf9")).toBeLessThan(completed.indexOf("\u5019\u9009\u8bcd\u8868\u66f4\u65b0"));
    });
  });

  it("@scenario S-R237511OV-01-recent7d leaves old completions and running work out of the completed section", async () => {
    await inspectOverview((html) => {
      const completed = section(html, 'id="completed-title"', '<aside class="stack"');
      expect(completed).not.toContain("\u65e7\u4efb\u52a1");
      expect(completed).not.toContain("\u65e7\u9700\u6c42\u5f52\u6863");
      expect(completed).not.toContain("\u91cd\u8bd5\u9000\u907f");
    });
  });

  it("@scenario S-R237511OV-01-refresh exposes automatic refresh and the current stage after allocating the review port", async () => {
    await inspectOverview((html) => {
      const active = section(html, 'id="active-title"', 'id="failures-title"');
      expect(html).toContain("/assets/overview.js");
      expect(html).toContain('id="refreshed-at"');
      expect(html).toContain("\u6bcf 30 \u79d2\u81ea\u52a8\u5237\u65b0");
      expect(active).toContain('aria-label="\u91cd\u8bd5\u9000\u907f \u4efb\u52a1 CODE \u8fd0\u884c\u4e2d"');
    });
  });

  it("@scenario S-R237511OV-01-refresh does not show the same task at an unobserved later stage", async () => {
    await inspectOverview((html) => {
      const active = section(html, 'id="active-title"', 'id="failures-title"');
      expect(active).not.toContain('aria-label="\u91cd\u8bd5\u9000\u907f \u4efb\u52a1 VERIFY \u8fd0\u884c\u4e2d"');
      expect(active.match(/\u91cd\u8bd5\u9000\u907f/gu)).toHaveLength(1);
    });
  });

  it("@scenario S-R237511OV-01-costs shows the seven-day dollar summary and continuing overrun after allocating the review port", async () => {
    await inspectOverview((html) => {
      const summary = section(html, '<aside class="stack"', "</aside>");
      expect(summary).toContain("USD $20.00");
      expect(summary).toContain("\u7edf\u8ba1\u8303\u56f4");
      expect(summary).toContain("Asia/Shanghai");
      expect(summary).toContain("\u5df2\u82b1 USD $20.00 / \u4e0a\u9650 USD $15.00");
      expect(summary).toContain("\u5df2\u8d85\u9650");
      expect(summary).toContain("\u5de5\u4f5c\u4ecd\u7ee7\u7eed");
    });
  });

  it("@scenario S-R237511OV-01-costs never describes an overrun as paused", async () => {
    await inspectOverview((html) => {
      const summary = section(html, '<aside class="stack"', "</aside>");
      expect(summary).not.toContain("\u5df2\u6682\u505c");
    });
  });
});
