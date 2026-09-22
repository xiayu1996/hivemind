import type { FastifyInstance } from "fastify";
import { COSTS_PAGE_STYLE } from "../../console-ui/src/costs/page-style.js";
import {
  currentWorkDetailPath,
  type CurrentWorkDetail,
  type CurrentWorkReadPort,
  type RequirementCurrentWorkDetail,
  type RunningOverviewEntry,
  type TaskCurrentWorkDetail,
} from "./current-work-contracts.js";
import { renderOverviewAlertPanel, type OverviewCostAlertPageView } from "./overview-cost-alert-page.js";

/**
 * The screens the running overview and the two detail routes render.
 *
 * Server-rendered rather than a browser bundle, for the same reason the costs
 * and progress screens are: the console is mounted by whatever process holds
 * the central store, and a screen that only exists after somebody ran a build
 * is missing on the machine that needs it. The page writes nothing and reads
 * one snapshot; every word comes from `current-work-read-port.ts`, so the
 * document and the JSON API cannot name the same thing differently.
 *
 * A row carries its own accessible name (`aria-label`) because the row is what
 * the scenario declares a person sees: the title, its identity and its phase in
 * one item. The visible text stays inside the row, so the label and the reading
 * agree.
 */

/** The person-visible routes. They are what `currentWorkDetailPath` builds, so
 * the link a person follows and the route that answers it are one path. */
export const REQUIREMENT_WORK_PAGE_PATH = "/requirements/:requirementId/detail";
export const TASK_WORK_PAGE_PATH = "/stories/:cardId/detail";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function money(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

/** One running row: title, identity, phase and the way into its own screen. */
function renderRunningRow(entry: RunningOverviewEntry): string {
  const identity = entry.kind === "requirement" ? "需求" : "任务";
  return `<li class="ledger-row" aria-label="${escapeHtml(`${entry.title} · ${identity} · ${entry.phase}`)}">`
    + `<div class="running-row-main"><strong>${escapeHtml(entry.title)}</strong>`
    + `<span class="meta">${escapeHtml(identity)}</span></div>`
    + `<span class="status running" role="status">运行中</span>`
    + `<span class="running-phase">${escapeHtml(entry.phase)}</span>`
    + `<a href="${escapeHtml(currentWorkDetailPath(entry))}">查看详情</a></li>`;
}

export interface RunningOverviewPageView {
  entries: readonly RunningOverviewEntry[];
}

/** The run overview's "运行中" rail. Every entry names its own kind, so a task
 * is never read as a requirement and an internal id never stands in for a
 * title. */
export function renderRunningOverviewSection(view: RunningOverviewPageView): string {
  const rows = view.entries.map(renderRunningRow).join("");
  const body = view.entries.length === 0
    ? `<p>当前没有正在推进的需求或任务。</p>`
    : `<ul class="ledger">${rows}</ul>`;
  return `<section class="section" aria-labelledby="running-title">`
    + `<div class="section-head"><h2 id="running-title">运行中 <span class="status running">${view.entries.length} 项</span></h2></div>`
    + `<div class="panel">${body}</div></section>`;
}

const DESKTOP_NAV: readonly { label: string; href: string }[] = [
  { label: "运行总览", href: "/" },
  { label: "费用分析", href: "/costs" },
  { label: "角色配置", href: "/roles" },
  { label: "工作记录", href: "/records" },
];

const MOBILE_NAV: readonly { label: string; href: string }[] = [
  { label: "总览", href: "/" },
  { label: "费用", href: "/costs" },
  { label: "配置", href: "/roles" },
  { label: "记录", href: "/records" },
];

function renderNavigation(links: readonly { label: string; href: string }[], className: string, label: string, currentHref: string): string {
  return `<nav class="${className}" aria-label="${escapeHtml(label)}">`
    + links.map((link) => `<a class="${className === "nav" ? "nav-link" : "mobile-link"}" href="${escapeHtml(link.href)}"`
      + `${link.href === currentHref ? ' aria-current="page"' : ""}>${escapeHtml(link.label)}</a>`).join("")
    + `</nav>`;
}

function renderSidebar(currentHref: string): string {
  return `<aside class="sidebar"><div class="brand">Hivemind<small>内网运行控制台</small></div>`
    + renderNavigation(DESKTOP_NAV, "nav", "主要导航", currentHref)
    + `</aside>`;
}

function renderDocument(title: string, body: string, currentHref: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>${escapeHtml(title)}｜Hivemind</title><style>${COSTS_PAGE_STYLE}${CURRENT_WORK_PAGE_STYLE}</style></head><body>`
    + `<div class="shell">${renderSidebar(currentHref)}<main>${body}</main></div>`
    + renderNavigation(MOBILE_NAV, "mobile-nav", "手机导航", currentHref)
    + `</body></html>`;
}

/**
 * The run overview: what is running first, then the cost alert that was
 * already there. A person opening the console reaches every running card from
 * here, which is what makes the detail screens reachable at all.
 */
export function renderRunningOverviewPage(
  alert: OverviewCostAlertPageView,
  running: RunningOverviewPageView,
): string {
  const body = `<header class="page-head"><div><h1>运行总览</h1>`
    + `<p>先处理需要你决定的事项，再查看运行、异常与最近完成。</p></div>`
    + `<div class="refresh">刚刚更新 · 每 30 秒自动刷新</div></header>`
    + renderRunningOverviewSection(running)
    + renderOverviewAlertPanel(alert);
  return renderDocument("运行总览", body, "/");
}

/** The round switcher: the current round is selected, and the history a person
 * did not ask for stays closed. */
function renderRoundSwitcher(historyRounds: readonly number[]): string {
  const tabs = [`<span class="tab" role="tab" aria-selected="true">当前轮</span>`]
    .concat(historyRounds.map((round) => `<span class="tab" role="tab" aria-selected="false">第 ${round} 轮</span>`))
    .join("");
  if (historyRounds.length === 0) {
    return `<div class="tabs" role="tablist" aria-label="选择轮次">${tabs}</div>`;
  }
  const history = historyRounds.map((round) => `<li><span>第 ${round} 轮</span></li>`).join("");
  return `<div class="tabs" role="tablist" aria-label="选择轮次">${tabs}</div>`
    + `<details class="history"><summary>历史轮次（${historyRounds.length}）</summary><ul class="ledger">${history}</ul></details>`;
}

function renderCurrentRoundPanel(detail: CurrentWorkDetail, resultLine: string, scope: string): string {
  const round = detail.currentRound;
  const blockerLines = round.blockers.length === 0
    ? `<p class="line">当前没有卡点。</p>`
    : round.blockers.map((blocker) => `<p class="line">${escapeHtml(blocker.text)}</p>`).join("");
  return `<section class="panel section" aria-labelledby="round-stage-title">`
    + `<h2 id="round-stage-title">当前轮阶段与结果</h2>`
    + `<p class="line">阶段：${escapeHtml(round.phase)}</p>`
    + `<p class="line">${escapeHtml(resultLine)}</p>`
    + `</section>`
    + `<section class="panel section" aria-labelledby="round-blocker-title">`
    + `<h2 id="round-blocker-title">卡点</h2>${blockerLines}</section>`
    + `<section class="panel section" aria-labelledby="round-cost-title">`
    + `<h2 id="round-cost-title">本轮费用</h2>`
    + `<p class="line money">${escapeHtml(money(round.costUsd))}（${escapeHtml(scope)}）</p>`
    + `</section>`;
}

function renderTaskEntries(tasks: RequirementCurrentWorkDetail["tasks"]): string {
  if (tasks.length === 0) return `<p class="line">目前没有正在运行的任务。</p>`;
  const rows = tasks.map((task) => `<li class="ledger-row" aria-label="${escapeHtml(`${task.title} · 任务 · 运行中`)}">`
    + `<div class="running-row-main"><strong>${escapeHtml(task.title)}</strong>`
    + `<span class="meta">任务 · 运行中</span></div>`
    + `<a href="${escapeHtml(currentWorkDetailPath(task))}">查看详情</a></li>`).join("");
  return `<ul class="ledger">${rows}</ul>`;
}

function requirementBody(detail: RequirementCurrentWorkDetail): string {
  const results = detail.currentRound.results.map((result) => result.text).join("、");
  const resultLine = results === "" ? "本轮结果尚未产生，将自动刷新" : `已取得的结果：${results}`;
  return `<a class="back-link" href="/">← 返回运行总览</a>`
    + `<header class="page-head"><div><h1>${escapeHtml(detail.title)}</h1>`
    + `<p>需求 · 运行中</p></div>`
    + `<span class="status running" role="status">运行中</span></header>`
    + renderRoundSwitcher(detail.historicalRounds.map((round) => round.round))
    + renderCurrentRoundPanel(detail, resultLine, "本需求当前轮")
    + `<section class="panel section" aria-labelledby="requirement-tasks-title">`
    + `<h2 id="requirement-tasks-title">所属任务</h2>${renderTaskEntries(detail.tasks)}</section>`;
}

function taskBody(detail: TaskCurrentWorkDetail): string {
  const passed = detail.currentRound.results.length;
  const resultLine = passed === 0 ? "本轮结果尚未产生，将自动刷新" : `已取得的结果：${passed} 项验收已通过`;
  const parent = detail.parentRequirement.title.trim() === ""
    ? ""
    : `<p class="meta">所属需求：${escapeHtml(detail.parentRequirement.title)}</p>`;
  return `<a class="back-link" href="/">← 返回运行总览</a>`
    + `<header class="page-head"><div><h1>${escapeHtml(detail.title)}</h1>`
    + `<p>任务 · 运行中</p>${parent}</div>`
    + `<span class="status running" role="status">运行中</span></header>`
    + renderRoundSwitcher(detail.historicalRounds.map((round) => round.round))
    + renderCurrentRoundPanel(detail, resultLine, "本任务当前轮");
}

/** The document for one running card. Its identity decides the words, and it
 * comes from the discriminated union rather than from the route. */
export function renderCurrentWorkDetailDocument(detail: CurrentWorkDetail): string {
  return detail.kind === "requirement"
    ? renderDocument(detail.title, requirementBody(detail), "/")
    : renderDocument(detail.title, taskBody(detail), "/");
}

function renderUnavailablePage(): string {
  return renderDocument(
    "需求与任务详情",
    `<a class="back-link" href="/">← 返回运行总览</a>`
    + `<header class="page-head"><div><h1>需求与任务详情</h1></div></header>`
    + `<div class="notice danger"><p role="alert">无法读取这项工作的进展</p>`
    + `<p>台账没有回答这次读取；已有工作不会因此停止。</p>`
    + `<p><a class="button secondary" href="/">返回运行总览</a></p></div>`,
    "/",
  );
}

function renderNotFoundPage(): string {
  return renderDocument(
    "找不到这项工作",
    `<a class="back-link" href="/">← 返回运行总览</a>`
    + `<header class="page-head"><div><h1>找不到这项工作</h1></div></header>`
    + `<p>它可能已经被移除，或者链接里的编号不属于任何需求或任务。</p>`,
    "/",
  );
}

/** The two person-visible detail routes. They read the same snapshots the JSON
 * routes publish, and a failed read is a page that says so rather than a 404
 * that reads as "no such screen". */
export function registerCurrentWorkPageRoutes(app: FastifyInstance, port: CurrentWorkReadPort): void {
  app.get(REQUIREMENT_WORK_PAGE_PATH, async (request, reply) => {
    const requirementId = String((request.params as { requirementId?: string }).requirementId ?? "");
    const result = await port.readRequirementDetail(requirementId);
    if (result.kind === "not_found") return reply.code(404).type("text/html").send(renderNotFoundPage());
    if (result.kind === "failed") return reply.code(503).type("text/html").send(renderUnavailablePage());
    if (result.detail.kind !== "requirement") {
      return reply.code(502).type("text/html").send(renderUnavailablePage());
    }
    return reply.type("text/html").send(renderCurrentWorkDetailDocument(result.detail));
  });

  app.get(TASK_WORK_PAGE_PATH, async (request, reply) => {
    const cardId = String((request.params as { cardId?: string }).cardId ?? "");
    const result = await port.readTaskDetail(cardId);
    if (result.kind === "not_found") return reply.code(404).type("text/html").send(renderNotFoundPage());
    if (result.kind === "failed") return reply.code(503).type("text/html").send(renderUnavailablePage());
    return reply.type("text/html").send(renderCurrentWorkDetailDocument(result.detail));
  });
}

const CURRENT_WORK_PAGE_STYLE = `
.running-row-main{display:flex;flex-direction:column}
.running-phase{color:var(--color-text-muted);font-size:var(--font-caption)}
.panel .ledger{margin-top:0}
.tabs{display:flex;flex-wrap:wrap;gap:var(--space-control-gap);margin:var(--space-content-gap) 0}
.tab{min-height:44px;display:inline-flex;align-items:center;padding:9px 13px;border:1px solid var(--color-border);border-radius:var(--radius-control);background:var(--color-surface);color:var(--color-text)}
.tab[aria-selected="true"]{background:var(--color-surface-selected);border-color:var(--color-action);color:var(--color-action);font-weight:var(--weight-strong)}
.history{margin-top:var(--space-content-gap);color:var(--color-text-muted);font-size:var(--font-caption)}
.history summary{cursor:pointer;min-height:44px;display:flex;align-items:center}
.notice{border:1px solid var(--color-border);border-left:4px solid var(--color-danger);border-radius:var(--radius-control);padding:12px 14px;background:var(--color-surface-danger)}
@media (max-width:760px){.ledger-row{display:block}.running-phase{display:block;margin-top:var(--space-inline-tight)}}
`;
