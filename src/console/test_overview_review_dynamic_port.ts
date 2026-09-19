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
});
