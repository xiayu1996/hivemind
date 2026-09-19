import type { RequirementCostSnapshot } from "../persistence/requirement-cost-ledger.js";
import type { RequirementCostViewOptions } from "./requirement-costs.js";
import { renderRequirementCostSection } from "./requirement-cost-view.js";
import { COSTS_PAGE_STYLE } from "../../console-ui/src/costs/page-style.js";

/** One requirement row as the list page shows it. */
export interface RequirementSummaryRow {
  id: string;
  title: string;
  state: string;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

interface NavigationLink {
  label: string;
  href: string;
}

/**
 * The console's destinations. The detail page is reached from the overview, so
 * it marks that one current rather than pretending to be the costs page.
 */
const DESKTOP_NAV: readonly NavigationLink[] = [
  { label: "运行总览", href: "/" },
  { label: "费用分析", href: "/costs" },
  { label: "角色配置", href: "/roles" },
  { label: "工作记录", href: "/records" },
];

const MOBILE_NAV: readonly NavigationLink[] = [
  { label: "总览", href: "/" },
  { label: "费用", href: "/costs" },
  { label: "配置", href: "/roles" },
  { label: "记录", href: "/records" },
];

function renderNavigation(links: readonly NavigationLink[], className: string, label: string, currentHref: string): string {
  return `<nav class="${className}" aria-label="${escapeHtml(label)}">`
    + links.map((link) => `<a class="${className === "nav" ? "nav-link" : "mobile-link"}" href="${escapeHtml(link.href)}"`
      + `${link.href === currentHref ? ' aria-current="page"' : ""}>${escapeHtml(link.label)}</a>`).join("")
    + `</nav>`;
}

function renderSidebar(currentHref: string): string {
  return `<aside class="sidebar"><div class="brand">Hivemind<small>内网运行控制台</small></div>`
    + renderNavigation(DESKTOP_NAV, "nav", "主要导航", currentHref)
    + `<div class="network-note">家庭网络 · 已连接</div></aside>`;
}

/** The complete document for one requirement page. Only the current state is in the tree. */
function renderDocument(title: string, body: string, currentHref: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>${escapeHtml(title)}｜Hivemind</title><style>${COSTS_PAGE_STYLE}</style></head><body>`
    + `<div class="shell">${renderSidebar(currentHref)}<main>${body}</main></div>`
    + renderNavigation(MOBILE_NAV, "mobile-nav", "手机导航", currentHref)
    + `</body></html>`;
}

/**
 * A requirement's detail page. The cumulative figure covers the requirement
 * and every descendant work item across every round, so nothing here is scoped
 * to the round a person happens to be looking at.
 */
export function renderRequirementDetailPage(
  requirementId: string,
  title: string | null,
  snapshot: RequirementCostSnapshot,
  options: RequirementCostViewOptions,
): string {
  const heading = title === null || title.trim() === "" ? requirementId : title;
  const body = `<div class="page-head"><div><h1>${escapeHtml(heading)}</h1>`
    + `<p>需求 ${escapeHtml(requirementId)} · 全部工作轮次</p></div>`
    + `<div class="refresh">刚刚更新</div></div>`
    + renderRequirementCostSection(snapshot, options);
  return renderDocument("需求与任务详情", body, "/");
}

/** The page a person reaches when the requirement id is not in the store. */
export function renderRequirementNotFoundPage(requirementId: string): string {
  const body = `<header class="page-head"><div><h1>需求与任务详情</h1></div></header>`
    + `<div class="state-page"><div class="state-card"><h2>没有找到这个需求</h2>`
    + `<p>${escapeHtml(requirementId)} 不在当前运行记录里。返回总览选择一项正在进行的需求。</p>`
    + `<div class="actions"><a class="button" href="/">返回运行总览</a></div></div></div>`;
  return renderDocument("需求与任务详情", body, "/");
}

/** The list of requirements, each linking to its own cumulative cost page. */
export function renderRequirementListPage(rows: readonly RequirementSummaryRow[]): string {
  const body = rows.length === 0
    ? `<header class="page-head"><div><h1>需求与任务</h1></div></header>`
      + `<div class="state-page"><div class="state-card"><h2>还没有需求</h2>`
      + `<p>需求进入运行后，这里会按需求列出累计费用与工作轮次。</p></div></div>`
    : `<header class="page-head"><div><h1>需求与任务</h1><p>每项需求的全部工作轮次累计费用。</p></div></header>`
      + `<section class="panel"><table><thead><tr><th scope="col">需求</th><th scope="col">标题</th>`
      + `<th scope="col">状态</th><th scope="col">累计费用</th></tr></thead><tbody>`
      + rows.map((row) => `<tr><td><a href="/requirements/${encodeURIComponent(row.id)}">${escapeHtml(row.id)}</a></td>`
        + `<td>${escapeHtml(row.title)}</td><td>${escapeHtml(row.state)}</td>`
        + `<td><a href="/costs?requirement=${encodeURIComponent(row.id)}">查看费用明细</a></td></tr>`).join("")
      + `</tbody></table></section>`;
  return renderDocument("需求与任务", body, "/");
}
