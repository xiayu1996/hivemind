import type { RequirementCostSnapshot } from "../persistence/requirement-cost-ledger.js";
import {
  presentRequirementCost,
  type RequirementCostView,
  type RequirementCostViewOptions,
} from "./requirement-costs.js";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * The cumulative figure and the metered-only ceiling, as one panel. A complete
 * history shows the frozen total; an incomplete one shows the known subtotal
 * under a heading that says so, so the figure is never read as the whole.
 */
function renderSummary(view: RequirementCostView): string {
  const summary = view.summary;
  const figure = summary.state === "complete"
    ? `<div class="metric-value">${escapeHtml(summary.total)}</div>`
    : `<div class="metric-value">已知小计 ${escapeHtml(summary.knownSubtotal)}</div>`;
  const note = summary.state === "complete"
    ? `${escapeHtml(summary.pricingBasis)} · ${escapeHtml(summary.subscriptionNotice)}`
    : escapeHtml(summary.missingPriceNotice);
  return `<section class="panel" aria-labelledby="requirement-cost-title">`
    + `<h2 id="requirement-cost-title">${escapeHtml(summary.heading)}</h2>`
    + figure
    + `<div class="metric-detail">${note}</div>`
    + `<hr class="divider">`
    + `<div class="row"><span>${escapeHtml(view.ceilingJudgment.label)}</span>`
    + `<strong class="money">${escapeHtml(view.ceilingJudgment.amount)}</strong></div>`
    + `<div class="metric-detail">${escapeHtml(view.ceilingJudgment.explanation)}</div>`
    + `<p><a href="/costs?requirement=${encodeURIComponent(view.requirementId)}">查看费用明细</a></p>`
    + `</section>`;
}

/**
 * Every recorded usage as its own row. The four pricing categories stay apart,
 * each showing the price that applied where it happened; an entry with no
 * applicable price keeps an empty unit price and amount rather than a zero.
 */
function renderDetailTable(view: RequirementCostView): string {
  const rows = view.details.map((row) => {
    const unitPrice = row.historicalUnitPrice === null ? "—" : escapeHtml(row.historicalUnitPrice);
    const amount = row.amount === null ? "—" : escapeHtml(row.amount);
    return `<tr data-entry-id="${escapeHtml(row.entryId)}" data-pricing-status="${escapeHtml(row.pricingStatus)}">`
      + `<td><span class="cell-label">发生时间</span>${escapeHtml(row.occurredAt)}</td>`
      + `<td><span class="cell-label">供应商</span>${escapeHtml(row.provider)}</td>`
      + `<td><span class="cell-label">模型</span>${escapeHtml(row.model)}</td>`
      + `<td><span class="cell-label">付费方式</span>${escapeHtml(row.billingModeLabel)}</td>`
      + `<td><span class="cell-label">计价分类</span>${escapeHtml(row.categoryLabel)}</td>`
      + `<td class="money"><span class="cell-label">用量</span>${escapeHtml(row.usage)}</td>`
      + `<td class="money"><span class="cell-label">当时单价</span>${unitPrice}</td>`
      + `<td class="money"><span class="cell-label">金额</span>${amount}</td></tr>`;
  }).join("");
  return `<section class="panel" aria-labelledby="requirement-detail-title">`
    + `<h2 id="requirement-detail-title">${escapeHtml(view.detailHeading)}</h2>`
    + `<table><thead><tr><th scope="col">发生时间</th><th scope="col">供应商</th><th scope="col">模型</th>`
    + `<th scope="col">付费方式</th><th scope="col">计价分类</th><th scope="col">用量</th>`
    + `<th scope="col">当时单价</th><th scope="col">金额</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}

/**
 * The whole requirement-cost section: the frozen cumulative figure with its
 * separate ceiling amount, then one row per recorded usage. It is a fragment a
 * page embeds, so the detail page and the requirement-scoped costs view show
 * the same numbers from the same read.
 */
export function renderRequirementCostSection(
  snapshot: RequirementCostSnapshot,
  options: RequirementCostViewOptions,
): string {
  const view = presentRequirementCost(snapshot, options);
  return `<div class="stack">${renderSummary(view)}${renderDetailTable(view)}</div>`;
}
