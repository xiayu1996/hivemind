import { createClient, type Client } from "@libsql/client";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { migrate } from "../persistence/migrate.js";
import { createLibsqlOverviewReader, type OverviewSnapshot } from "./overview-contract.js";
import { seedOverviewDemo } from "./overview-demo.js";
import {
  formatUsd,
  formatWaiting,
  renderOverviewBody,
  renderOverviewDocument,
  renderRefreshedAt,
  type OverviewPageInput,
} from "./overview-page.js";

const NOW = 1_800_000_000_000;
const TIME_ZONE = "Asia/Shanghai";
const clients: Client[] = [];
const directories: string[] = [];

async function demoClient(): Promise<Client> {
  const directory = await mkdtemp(join(tmpdir(), "overview-ui-"));
  directories.push(directory);
  const client = createClient({ url: `file:${join(directory, "demo.db")}` });
  clients.push(client);
  await migrate(client);
  await seedOverviewDemo(client, NOW);
  return client;
}

async function demoSnapshot(client: Client, nowMs = NOW): Promise<OverviewSnapshot> {
  return createLibsqlOverviewReader(client).readOverview({ nowMs, timeZone: TIME_ZONE });
}

function page(snapshot: OverviewSnapshot | null, state: OverviewPageInput["state"] = "ready", nowMs = NOW): string {
  return renderOverviewDocument({ state, snapshot, timeZone: TIME_ZONE, nowMs });
}

function body(snapshot: OverviewSnapshot, nowMs = NOW): string {
  return renderOverviewBody({ state: "ready", snapshot, timeZone: TIME_ZONE, nowMs });
}

/** The markup between two section anchors, so a claim about one section cannot
 * be satisfied by content belonging to another. */
function slice(html: string, startMarker: string, endMarker: string): string {
  const start = html.indexOf(startMarker);
  const end = html.indexOf(endMarker, start + 1);
  return html.slice(start, end < 0 ? undefined : end);
}

async function asset(name: string): Promise<string> {
  return readFile(fileURLToPath(new URL(`../../console-ui/assets/${name}`, import.meta.url)), "utf8");
}

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("overview first screen", () => {
  it("@scenario S-R237511OV-01-todo lists each open reply, approval and choice once, before anything else, with a way into each", async () => {
    const snapshot = await demoSnapshot(await demoClient());
    const html = page(snapshot);

    expect(snapshot.sections.todos).toHaveLength(3);
    expect(html).toContain(`<h2 id="todos-title">\u7b49\u5f85\u672c\u4eba\u5904\u7406 <span class="heading-count">3 \u9879`);
    // The waiting rail comes first: nothing else may sit above it.
    expect(html.indexOf('id="todos-title"')).toBeLessThan(html.indexOf('id="active-title"'));
    const actions = [...html.matchAll(/<a role="button" class="button" href="([^"]+)">\u5904\u7406<\/a>/g)].map((match) => match[1]);
    expect(actions).toEqual([
      "/todo?requirement=R-PAY",
      "/todo?requirement=R-TZ",
      "/todo?requirement=R-PRD",
    ]);
    // Every kind is shown with the requirement it belongs to and how long it waited.
    expect(html).toContain("\u9700\u8981\u7b54\u590d");
    expect(html).toContain("\u9700\u8981\u9009\u62e9");
    expect(html).toContain("\u9700\u8981\u6279\u51c6");
    expect(html).toContain("\u652f\u4ed8\u91cd\u8bd5\u89c4\u5219");
    expect(html).toContain("\u5df2\u7b49\u5f85 2 \u5c0f\u65f6");
    // An item a person already handled is gone, and each open item appears once.
    expect(html).not.toContain("\u5df2\u7ecf\u5904\u7406\u7684\u9700\u6c42");
    expect(new Set(actions).size).toBe(3);
  });

  it("@scenario S-R237511OV-01-active shows every running item with its stage and status, newest first, and nothing else", async () => {
    const snapshot = await demoSnapshot(await demoClient());
    const html = page(snapshot);

    expect(snapshot.summary.runningCount).toBe(3);
    expect(html).toContain(`<h2 id="active-title">\u8fd0\u884c\u4e2d <span class="heading-count">3 \u9879`);
    const active = slice(html, 'id="active-title"', 'id="failures-title"');
    expect(active).toContain('aria-label="\u91cd\u8bd5\u9000\u907f \u4efb\u52a1 CODE \u8fd0\u884c\u4e2d"');
    expect(active).toContain('aria-label="\u91cd\u8bd5\u7b56\u7565\u6536\u655b \u9700\u6c42 SOLUTION \u8fd0\u884c\u4e2d"');
    expect(active).toContain('aria-label="\u5f02\u5e38\u5f52\u7c7b \u4efb\u52a1 VERIFY \u8fd0\u884c\u4e2d"');
    // Newest change first: CODE (20 min ago), SOLUTION (30 min), VERIFY (40 min).
    expect(active.indexOf("\u91cd\u8bd5\u9000\u907f")).toBeLessThan(active.indexOf("\u91cd\u8bd5\u7b56\u7565\u6536\u655b"));
    expect(active.indexOf("\u91cd\u8bd5\u7b56\u7565\u6536\u655b")).toBeLessThan(active.indexOf("\u5f02\u5e38\u5f52\u7c7b"));
    // Waiting, failed and completed items never leak into the running section.
    expect(active).not.toContain("\u5931\u8d25");
    expect(active).not.toContain("\u5df2\u5b8c\u6210");
    expect(active).not.toContain("\u7b49\u5f85\u672c\u4eba\u5904\u7406");
  });

  it("@scenario S-R237511OV-01-failures shows live failures with stage, reason and time, and hides the recovered one", async () => {
    const snapshot = await demoSnapshot(await demoClient());
    const html = page(snapshot);

    expect(snapshot.summary.failureCount).toBe(2);
    expect(html).toContain(`<h2 id="failures-title">\u5931\u8d25 <span class="heading-count">2 \u9879`);
    const failures = slice(html, 'id="failures-title"', 'id="completed-title"');
    expect(failures).toContain('aria-label="\u8d26\u5355\u5bfc\u51fa \u4efb\u52a1 VERIFY \u5931\u8d25 \u9a8c\u6536\u672a\u901a\u8fc7 ');
    expect(failures).toContain('aria-label="\u8d26\u5355\u5bfc\u51fa\u89c4\u5219 \u9700\u6c42 SOLUTION \u5931\u8d25 \u65b9\u6848\u65e0\u6cd5\u5f62\u6210 ');
    expect(failures).toContain("\u9a8c\u6536\u672a\u901a\u8fc7");
    expect(failures).toContain("\u65b9\u6848\u65e0\u6cd5\u5f62\u6210");
    // The recovered item's failure history is still in the store, but not here.
    expect(failures).not.toContain("\u5df2\u7ecf\u6062\u590d");
  });

  it("@scenario S-R237511OV-01-recent7d includes both sides of the seven-day boundary and drops everything outside it", async () => {
    const snapshot = await demoSnapshot(await demoClient());
    const html = page(snapshot);

    expect(snapshot.summary.completedCount).toBe(2);
    expect(html).toContain(`<h2 id="completed-title">\u6700\u8fd1\u5b8c\u6210 <span class="heading-count">2 \u9879`);
    const completed = slice(html, 'id="completed-title"', '<aside class="stack"');
    expect(completed).toContain('aria-label="\u72b6\u6001\u6295\u5f71\u6838\u5bf9 \u4efb\u52a1 \u5df2\u5b8c\u6210 ');
    expect(completed).toContain('aria-label="\u5019\u9009\u8bcd\u8868\u66f4\u65b0 \u9700\u6c42 \u5df2\u5b8c\u6210 ');
    // Later completions sort ahead of earlier ones.
    expect(completed.indexOf("\u72b6\u6001\u6295\u5f71\u6838\u5bf9")).toBeLessThan(completed.indexOf("\u5019\u9009\u8bcd\u8868\u66f4\u65b0"));
    // Older than seven days and still running are both absent.
    expect(html).not.toContain("\u65e7\u4efb\u52a1");
    expect(html).not.toContain("\u65e7\u9700\u6c42\u5f52\u6863");
    expect(html).not.toContain("\u5df2\u7ecf\u6062\u590d\u7684\u5bfc\u51fa");
  });

  it("@scenario S-R237511OV-01-refresh re-renders the changed stage and a new refresh time after a later read", async () => {
    const client = await demoClient();
    const before = await demoSnapshot(client, NOW);
    const first = body(before);
    expect(first).toContain('aria-label="\u91cd\u8bd5\u9000\u907f \u4efb\u52a1 CODE \u8fd0\u884c\u4e2d"');

    // The task moves to VERIFY; the next read at the next tick must present it.
    await client.execute({
      sql: "UPDATE stories SET state = 'VERIFY', phase = 'VERIFY', updated_at = ? WHERE id = 'S-CODE'",
      args: [NOW + 30_000],
    });
    const after = await demoSnapshot(client, NOW + 30_000);
    const second = body(after, NOW + 30_000);
    expect(second).toContain('aria-label="\u91cd\u8bd5\u9000\u907f \u4efb\u52a1 VERIFY \u8fd0\u884c\u4e2d"');
    expect(second).not.toContain('aria-label="\u91cd\u8bd5\u9000\u907f \u4efb\u52a1 CODE \u8fd0\u884c\u4e2d"');
    expect(second.match(/\u91cd\u8bd5\u9000\u907f/g)).toHaveLength(2);

    const refreshedBefore = renderRefreshedAt(NOW, TIME_ZONE);
    const refreshedAfter = renderRefreshedAt(NOW + 60_000, TIME_ZONE);
    expect(refreshedBefore).toContain("\u6700\u8fd1\u5237\u65b0");
    expect(refreshedBefore).not.toBe(refreshedAfter);

    // The open page refreshes itself within the minute: the shell loads a
    // script that asks for the same block every 30 seconds and on return.
    const html = page(before);
    expect(html).toContain('<script src="/assets/overview.js" defer>');
    expect(html).toContain('id="refreshed-at"');
    const script = await asset("overview.js");
    expect(script).toContain("30000");
    expect(script).toContain("/overview/sections");
    expect(script).toContain("visibilitychange");
  });

  it("@scenario S-R237511OV-01-responsive lays out the same sections for both viewports with a marked current page", async () => {
    const html = page(await demoSnapshot(await demoClient()));

    expect(html).toContain('class="sidebar"');
    expect(html).toContain('aria-label="\u4e3b\u8981\u5bfc\u822a"');
    expect(html).toContain('class="mobile-nav"');
    expect(html).toContain('aria-label="\u624b\u673a\u5bfc\u822a"');
    // One current page, marked in both navigations.
    expect(html.match(/aria-current="page"/g)).toHaveLength(2);
    expect(html).toContain("\u5f53\u524d");
    // Fixed reading order, and every section present without switching pages.
    const order = ["todos-title", "active-title", "failures-title", "completed-title", "\u4e03\u65e5\u4e0e\u8d39\u7528\u6458\u8981"]
      .map((marker) => html.indexOf(marker));
    expect(order).toEqual([...order].toSorted((left, right) => left - right));
    for (const marker of order) expect(marker).toBeGreaterThan(-1);

    const css = await asset("overview.css");
    expect(css).toContain("@media (max-width:760px)");
    expect(css).toContain(".mobile-nav{position:fixed");
    expect(css).toMatch(/min-height:44px/);
  });

  it("@scenario S-R237511OV-01-states draws a named state instead of a blank page, and always offers a re-read", async () => {
    const loading = page(await demoSnapshot(await demoClient()), "loading");
    expect(loading).toContain("\u6b63\u5728\u8bfb\u53d6");
    expect(loading).toContain("\u7b49\u5f85\u672c\u4eba\u5904\u7406");
    expect(loading).toContain("\u8fd0\u884c\u4e2d");
    expect(loading).toContain("\u5931\u8d25");
    expect(loading).toContain("\u6700\u8fd1\u5b8c\u6210");

    const empty = page(await demoSnapshot(await demoClient()), "empty");
    expect(empty).toContain("\u5f53\u524d\u6ca1\u6709\u8fd0\u884c\u4e8b\u9879");
    expect(empty).toContain("Notion");

    const error = page(null, "error");
    expect(error).toContain("\u65e0\u6cd5\u8bfb\u53d6\u8fd0\u884c\u603b\u89c8");
    expect(error).toContain("\u91cd\u65b0\u8bfb\u53d6");

    const waiting = page(null, "waiting");
    expect(waiting).toContain("\u8fd0\u884c\u7ed3\u679c\u5c1a\u672a\u4ea7\u751f");
    expect(waiting).toContain("1 \u5206\u949f");

    for (const state of [loading, empty, error, waiting]) {
      expect(state).toContain("<h1>\u8fd0\u884c\u603b\u89c8</h1>");
      expect(state).toContain('role="button" class="button secondary" id="reload"');
      expect(state).not.toContain("\u6682\u65e0\u6570\u636e");
    }
  });

  it("@scenario S-R237511OV-01-costs writes the seven-day window, the time zone and a continuing overrun without a pause", async () => {
    const snapshot = await demoSnapshot(await demoClient());
    const html = page(snapshot);

    expect(snapshot.summary.costUsd).toBe(20);
    expect(snapshot.summary.overruns).toHaveLength(1);
    expect(html).toContain("<h2>\u4e03\u65e5\u4e0e\u8d39\u7528\u6458\u8981</h2>");
    expect(html).toContain("\u6700\u8fd1 7 \u5929\u5b8c\u6210");
    expect(html).toContain("USD $20.00");
    expect(html).toContain("\u7edf\u8ba1\u8303\u56f4");
    expect(html).toContain(TIME_ZONE);
    expect(html).toContain("\u5df2\u8d85\u9650");
    expect(html).toContain("\u5de5\u4f5c\u4ecd\u7ee7\u7eed");
    expect(html).toContain("USD $15.00");
    expect(html).not.toContain("\u5df2\u6682\u505c");
    expect(html).not.toContain("paused");
  });

  it("formats durations and money for a person rather than for a machine", () => {
    expect(formatWaiting(NOW - 30_000, NOW)).toBe("\u5df2\u7b49\u5f85 0 \u5206\u949f");
    expect(formatWaiting(NOW - 2 * 3_600_000, NOW)).toBe("\u5df2\u7b49\u5f85 2 \u5c0f\u65f6");
    expect(formatWaiting(NOW - 3 * 86_400_000, NOW)).toBe("\u5df2\u7b49\u5f85 3 \u5929");
    expect(formatUsd(20)).toBe("USD $20.00");
    expect(formatUsd(7.6)).toBe("USD $7.60");
  });
});
