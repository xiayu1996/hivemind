import type { OverviewTodoItem, OverviewTodoKind } from "./overview-contract.js";
import nav from "./overview-copy.json" with { type: "json" };
import copy from "./todo-copy.json" with { type: "json" };
import { formatWaiting } from "./overview-page.js";

/**
 * The page behind the overview's waiting rail.
 *
 * Choosing to handle a waiting item lands here: the item's own question, the
 * requirement it belongs to and how long it has waited, with the handling
 * controls the interface contract declares. The console itself stays
 * read-only -- answering, approving or choosing happens against the
 * requirement's own record -- so this page presents the item rather than
 * claiming to keep it.
 *
 * The page is read by a person and by the accessibility tree, so the heading,
 * the status label and the labelled controls are the contract.
 */

export type TodoPageState = "ready" | "empty" | "error";

export interface TodoPageInput {
  state: TodoPageState;
  item: OverviewTodoItem | null;
  requirementId: string | null;
  nowMs: number;
}

export interface ConsoleTodoPage {
  renderDocument(input: TodoPageInput): string;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function kindLabel(kind: OverviewTodoKind): string {
  if (kind === "reply") return copy.kindReply;
  if (kind === "choice") return copy.kindChoice;
  return copy.kindApproval;
}

function primaryLabel(kind: OverviewTodoKind): string {
  if (kind === "reply") return copy.actionReply;
  if (kind === "choice") return copy.actionChoice;
  return copy.actionApproval;
}

function renderNavigation(): string {
  return `<div class="shell"><aside class="sidebar">`
    + `<div class="brand">Hivemind<small>${nav.navLabel}</small></div>`
    + `<nav class="nav" aria-label="${nav.navLabel}">`
    + `<a class="nav-link" href="/">${nav.navOverview}</a>`
    + `<a class="nav-link" href="/costs">${nav.navCosts}</a>`
    + `<a class="nav-link" href="/roles">${nav.navRoles}</a>`
    + `<a class="nav-link" href="/records">${nav.navRecords}</a>`
    + `</nav></aside><main>`;
}

function renderMobileNavigation(): string {
  return `<nav class="mobile-nav" aria-label="${nav.mobileNavLabel}">`
    + `<a class="mobile-link" href="/">${nav.mobileOverview}</a>`
    + `<a class="mobile-link" href="/costs">${nav.mobileCosts}</a>`
    + `<a class="mobile-link" href="/roles">${nav.mobileRoles}</a>`
    + `<a class="mobile-link" href="/records">${nav.mobileRecords}</a>`
    + `</nav>`;
}

function retainHelp(prefix: string, requirementId: string): string {
  return `${prefix}${escapeHtml(requirementId)}${copy.retainSuffix}`;
}

/** The controls the item's kind needs: free text for a reply, offered labels
 * for a choice, and the two outcomes for an approval. */
function renderControls(item: OverviewTodoItem): string {
  if (item.kind === "reply") {
    return `<label for="todo-answer">${copy.answerLabel}</label>`
      + `<textarea id="todo-answer" name="answer" aria-describedby="todo-answer-help"></textarea>`
      + `<p class="field-help" id="todo-answer-help">${retainHelp(copy.answerHelpPrefix, item.requirement.id)}</p>`;
  }
  const options = item.kind === "choice" && item.options.length > 0
    ? item.options.map((label) => ({ label, meta: "" }))
    : [
      { label: copy.optionApprove, meta: copy.optionApproveMeta },
      { label: copy.optionRework, meta: copy.optionReworkMeta },
    ];
  const choices = options.map((option, index) => `<label class="choice">`
    + `<input type="radio" name="decision" value="${escapeHtml(option.label)}"${index === 0 ? " checked" : ""}>`
    + `<span><strong>${escapeHtml(option.label)}</strong>`
    + (option.meta === "" ? "" : `<br><span class="meta">${escapeHtml(option.meta)}</span>`)
    + `</span></label>`).join("");
  return `<fieldset><legend>${copy.resultLegend}</legend>${choices}</fieldset>`
    + `<div class="section"><label for="todo-note">${copy.noteLabel}</label>`
    + `<textarea id="todo-note" name="note" aria-describedby="todo-note-help"></textarea>`
    + `<p class="field-help" id="todo-note-help">${retainHelp(copy.noteHelpPrefix, item.requirement.id)}</p></div>`;
}

function renderSummary(item: OverviewTodoItem, waiting: string): string {
  return `<aside class="stack" aria-label="${copy.summaryHeading}">`
    + `<section class="panel"><h2>${copy.summaryHeading}</h2>`
    + `<div class="row"><span>${copy.summaryKind}</span><strong>${kindLabel(item.kind)}</strong></div>`
    + `<div class="row"><span>${copy.summaryRequirement}</span><strong>${escapeHtml(item.requirement.title)}</strong></div>`
    + `<div class="row"><span>${copy.summaryRequirementId}</span><strong class="number">${escapeHtml(item.requirement.id)}</strong></div>`
    + `<div class="row"><span>${copy.summaryWaiting}</span><strong>${waiting}</strong></div>`
    + `</section></aside>`;
}

function renderReady(item: OverviewTodoItem, nowMs: number): string {
  const kind = kindLabel(item.kind);
  const waiting = formatWaiting(item.waitingSinceMs, nowMs);
  const question = item.question === "" ? copy.defaultQuestion : item.question;
  return `<a class="back-link" href="/">${copy.backLink}</a>`
    + `<header class="page-head"><div><h1>${escapeHtml(item.requirement.title)}</h1>`
    + `<p>${kind} · ${copy.requirementLabel} ${escapeHtml(item.requirement.id)} · ${waiting}</p></div>`
    + `<span class="status attention">${kind}</span></header>`
    + `<div class="split"><div>`
    + `<div class="notice attention"><h2>${copy.decideTitle}</h2><p>${escapeHtml(question)}</p></div>`
    + `<form class="panel section" id="todo-form" method="get" action="/todo">`
    + `<input type="hidden" name="requirement" value="${escapeHtml(item.requirement.id)}">`
    + renderControls(item)
    + `<div class="actions section"><button type="submit">${primaryLabel(item.kind)}</button>`
    + `<a class="button secondary" href="/">${copy.backLink}</a></div>`
    + `</form></div>`
    + renderSummary(item, waiting)
    + `</div>`;
}

function renderStateCard(state: TodoPageState, requirementId: string | null): string {
  if (state === "error") {
    const retry = requirementId === null
      ? "/todo"
      : `/todo?requirement=${encodeURIComponent(requirementId)}`;
    return `<div class="state-page"><div class="state-card">`
      + `<h2>${copy.stateErrorTitle}</h2><p>${copy.stateErrorBody}</p>`
      + `<a role="button" class="button secondary" href="${escapeHtml(retry)}">${copy.reloadLabel}</a>`
      + `</div></div>`;
  }
  return `<div class="state-page"><div class="state-card">`
    + `<h2>${copy.stateEmptyTitle}</h2><p>${copy.stateEmptyBody}</p>`
    + `<a class="button secondary" href="/">${copy.backLink}</a>`
    + `</div></div>`;
}

export function renderTodoDocument(input: TodoPageInput): string {
  const body = input.state === "ready" && input.item !== null
    ? renderReady(input.item, input.nowMs)
    : renderStateCard(input.state, input.requirementId);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>${copy.documentTitle}</title>`
    + `<meta name="description" content="${copy.documentDescription}">`
    + `<link rel="stylesheet" href="/assets/overview.css">`
    + `</head><body>`
    + renderNavigation()
    + body
    + `</main></div>`
    + renderMobileNavigation()
    + `</body></html>`;
}

export function createTodoPage(): ConsoleTodoPage {
  return { renderDocument: renderTodoDocument };
}
