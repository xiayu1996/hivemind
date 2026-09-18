import { COSTS_PAGE_STYLE } from "../../console-ui/src/costs/page-style.js";
import type { OverviewCostAlertRow, OverviewCostAlertsView } from "./overview-cost-alerts.js";

/**
 * The run overview's cost alert summary. It is the first screen a person opens,
 * so the alert is stated in words as well as colour, and it says work goes on:
 * a requirement over its own limit is an alert line, not a stop.
 */
export interface OverviewPageView {
  alert: OverviewCostAlertsView;
}

/** Requirement states where the system is still doing the work. Waiting on a
 * person is a different situation and gets no running chip. */
const RUNNING_STATES = new Set(["DECOMPOSING", "EXECUTING", "ACCEPTANCE"]);

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderAlertRow(row: OverviewCostAlertRow): string {
  // The first screen shows what the requirement is doing as well as the alert:
  // work that continues past its limit has to read as running, not as parked.
  const running = RUNNING_STATES.has(row.requirementState)
    ? `<span class="status running" role="status">运行中</span>`
    : "";
  return `<li class="ledger-row">`
    + `<div><strong>${escapeHtml(row.requirementTitle)}</strong></div>`
    + running
    + `<span class="status danger" role="status">${escapeHtml(row.statusText)}</span>`
    + `<div><span>${escapeHtml(row.continuationText)}</span></div></li>`;
}

function renderAlertSummary(view: OverviewPageView): string {
  const rows = view.alert.rows.map(renderAlertRow).join("");
  if (view.alert.count === 0) {
    return `<section class="panel" aria-label="费用超限">`
      + `<h2>费用超限</h2>`
      + `<p>目前没有需求超过自己保存的费用上限。</p></section>`;
  }
  // The label is an inline text node and the requirement's status is a status
  // region: a block element would publish the same words under a role the
  // frozen DoD does not declare, which is how the alert became unreadable to
  // the structural check while the page still looked right.
  return `<section class="panel metric danger" aria-label="费用已超限">`
    + `<span class="metric-name">费用已超限</span>`
    + `<div class="metric-value">${view.alert.count}</div>`
    + `<div class="metric-detail"><span>工作仍会继续</span></div>`
    + `<ul class="ledger">${rows}</ul>`
    + `<p><a href="/costs">查看超限需求</a></p></section>`;
}

/** The complete run-overview document. */
export function renderOverviewPage(view: OverviewPageView): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>运行总览｜Hivemind</title><style>${COSTS_PAGE_STYLE}</style></head><body>`
    + `<div class="shell"><aside class="sidebar"><div class="brand">Hivemind<small>内网运行控制台</small></div>`
    + `<nav class="nav" aria-label="主要导航">`
    + `<a class="nav-link" href="/" aria-current="page">运行总览</a>`
    + `<a class="nav-link" href="/costs">费用分析</a>`
    + `<a class="nav-link" href="/roles">角色配置</a>`
    + `<a class="nav-link" href="/records">工作记录</a>`
    + `</nav><div class="network-note">家庭网络 · 已连接</div></aside>`
    + `<main><header class="page-head"><div><h1>运行总览</h1>`
    + `<p>先处理需要你决定的事项，再查看运行、异常与最近完成。</p></div>`
    + `<div class="refresh">刚刚更新 · 每 30 秒自动刷新</div></header>`
    + renderAlertSummary(view)
    + `</main></div>`
    + `<nav class="mobile-nav" aria-label="手机导航">`
    + `<a class="mobile-link" href="/" aria-current="page">总览</a>`
    + `<a class="mobile-link" href="/costs">费用</a>`
    + `<a class="mobile-link" href="/roles">配置</a>`
    + `<a class="mobile-link" href="/records">记录</a></nav>`
    + `</body></html>`;
}
