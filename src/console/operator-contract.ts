import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import copy from "./operator-copy.json" with { type: "json" };

export type OperatorSubjectKind = "requirement" | "epic" | "story";
export type OperatorTodoKind = "reply" | "approval" | "choice";
export type OverviewItemState = "running" | "failed" | "completed";

export interface OperatorSubjectRef {
  kind: OperatorSubjectKind;
  id: string;
  title: string;
  notionPageId: string;
}

export interface TodoOption {
  id: string;
  label: string;
  description?: string;
}

interface TodoBase {
  id: string;
  /** Changes whenever the source action changes or stops waiting. */
  revision: string;
  subject: OperatorSubjectRef;
  question: string;
  context: string;
  sourceLabel: string;
  waitingSince: number;
}

export interface ReplyTodo extends TodoBase {
  kind: "reply";
  answerLabel: string;
}

export interface ApprovalTodo extends TodoBase {
  kind: "approval";
  options: readonly [TodoOption, ...TodoOption[]];
  noteLabel: string;
  noteRequired: boolean;
}

export interface ChoiceTodo extends TodoBase {
  kind: "choice";
  options: readonly [TodoOption, ...TodoOption[]];
}

export type OperatorTodo = ReplyTodo | ApprovalTodo | ChoiceTodo;

export interface TodoSummary {
  id: string;
  revision: string;
  kind: OperatorTodoKind;
  subject: Pick<OperatorSubjectRef, "kind" | "id" | "title">;
  sourceLabel: string;
  waitingSince: number;
}

export interface OverviewItem {
  subject: Pick<OperatorSubjectRef, "kind" | "id" | "title">;
  state: OverviewItemState;
  phase: string | null;
  updatedAt: number;
  currentRound: number | null;
  costUsd: number;
}

export interface OperatorOverview {
  generatedAt: number;
  waitingForOperator: readonly TodoSummary[];
  running: readonly OverviewItem[];
  failures: readonly OverviewItem[];
  recentlyCompleted: readonly OverviewItem[];
}

export type CostLimitState =
  | { kind: "within_limit" }
  | { kind: "exceeded"; workContinues: true };

export interface OperatorRound {
  number: number;
  trigger: string;
  phase: string;
  result: string | null;
  blocker: string | null;
  costUsd: number;
  startedAt: number;
  endedAt: number | null;
}

export interface OperatorDetail {
  subject: Pick<OperatorSubjectRef, "kind" | "id" | "title">;
  stateLabel: string;
  currentRound: OperatorRound;
  /** Newest first. The current round is never repeated here. */
  history: readonly OperatorRound[];
  totalCostUsd: number;
  costLimit: CostLimitState;
}

export type OperatorDetailResult =
  | { kind: "available"; detail: OperatorDetail }
  | { kind: "no_rounds"; subject: Pick<OperatorSubjectRef, "kind" | "id" | "title"> };

export type OperatorTodoResult =
  | { kind: "pending"; todo: OperatorTodo }
  | { kind: "unavailable" };

export interface OperatorConsoleReadPort {
  overview(): Promise<OperatorOverview>;
  todo(todoId: string): Promise<OperatorTodoResult>;
  detail(subject: Pick<OperatorSubjectRef, "kind" | "id">): Promise<OperatorDetailResult>;
}

interface TodoSubmissionBase {
  todoId: string;
  expectedRevision: string;
  /** Reused by retries so an uncertain Notion response cannot create two actions. */
  idempotencyKey: string;
}

export type TodoSubmission =
  | (TodoSubmissionBase & { kind: "reply"; text: string })
  | (TodoSubmissionBase & { kind: "approval"; optionId: string; note: string })
  | (TodoSubmissionBase & { kind: "choice"; optionId: string });

export interface SavedTodoResult {
  kind: "saved";
  todoId: string;
  savedAt: number;
  destination: Pick<OperatorSubjectRef, "kind" | "id" | "title">;
}

export type TodoSubmissionResult =
  | SavedTodoResult
  | { kind: "validation_failed"; field: "text" | "option" | "note" }
  | { kind: "submitting"; retryAfterMs: number }
  | { kind: "not_saved"; reason: "notion_rejected" | "confirmation_timeout"; retryable: true }
  | { kind: "unavailable" };

export interface TodoSubmissionLease {
  todoId: string;
  expectedRevision: string;
  idempotencyKey: string;
  /** Monotonic CAS token; an older submitter cannot finish a newer attempt. */
  fence: number;
}

export type TodoSubmissionClaim =
  | { kind: "acquired"; lease: TodoSubmissionLease }
  | { kind: "submitting"; retryAfterMs: number }
  | SavedTodoResult
  | { kind: "unavailable" };

/** Central-store ownership and exclusion for submissions from multiple hosts. */
export interface OperatorTodoSubmissionStore {
  claim(input: TodoSubmission, claimedAt: number): Promise<TodoSubmissionClaim>;
  confirm(lease: TodoSubmissionLease, result: SavedTodoResult): Promise<boolean>;
  fail(
    lease: TodoSubmissionLease,
    reason: "notion_rejected" | "confirmation_timeout",
    failedAt: number,
  ): Promise<boolean>;
}

export type NotionTodoWriteResult =
  | { kind: "confirmed"; confirmedAt: number }
  | { kind: "rejected" }
  | { kind: "confirmation_timeout" };

/** Orchestrator-owned adapter that sends the action through NotionGateway. */
export interface OperatorNotionActionPort {
  saveAndConfirm(input: TodoSubmission, lease: TodoSubmissionLease): Promise<NotionTodoWriteResult>;
}

/**
 * The orchestrator owns this port. Its implementation is the only console path
 * allowed to reach Notion, and must do so through NotionGateway. Completion is
 * published only after the Notion write is confirmed and the central store is
 * updated with the same idempotency key.
 */
export interface OperatorTodoCommandPort {
  submit(input: TodoSubmission): Promise<TodoSubmissionResult>;
}

export type ConsoleAccessDecision =
  | { kind: "allowed" }
  | { kind: "denied" };

/** Fail closed. The address must be the socket peer unless a trusted proxy has
 * already resolved and validated the original client address. */
export interface ConsoleNetworkAccessPort {
  decide(clientAddress: string): ConsoleAccessDecision;
}

export type ConsolePageState<T> =
  | { kind: "loading"; previous?: T }
  | { kind: "ready"; value: T; refreshing: boolean }
  | { kind: "failed"; previous?: T }
  | { kind: "waiting"; value: T; waitingFor: "round_result" | "notion_confirmation"; refreshAfterMs: number };

export interface OperatorConsoleDependencies {
  access: ConsoleNetworkAccessPort;
  reads: OperatorConsoleReadPort;
  commands: OperatorTodoCommandPort;
}

type NavKey = "overview" | "costs" | "roles" | "records";

const NAV_ITEMS: readonly { key: NavKey; href: string }[] = [
  { key: "overview", href: "/operator/overview" },
  { key: "costs", href: "/operator/costs" },
  { key: "roles", href: "/operator/roles" },
  { key: "records", href: "/operator/records" },
];

const NAV_LONG: Record<NavKey, string> = {
  overview: copy.nav.overview,
  costs: copy.nav.costs,
  roles: copy.nav.roles,
  records: copy.nav.records,
};

const NAV_SHORT: Record<NavKey, string> = {
  overview: copy.nav.overviewShort,
  costs: copy.nav.costsShort,
  roles: copy.nav.rolesShort,
  records: copy.nav.recordsShort,
};

/** Every colour, size and spacing below is a value from the interface
 * contract's token table, because the contract layer measures the delivered
 * screens against it. Properties the table does not name (height, min-height,
 * top/bottom, grid tracks) are free: the table has no tokens for them. */
const STYLES = [
  ":root{--color-page:#f4f7fa;--color-surface:#ffffff;--color-text:#172b3a;--color-text-muted:#526477;--color-border:#cbd5df;--color-action:#173f63;--color-attention:#a75b00;--color-danger:#b42318;--color-success:#18794e;--color-focus:#0b6bcb;--color-surface-attention:#fff4df;--color-surface-danger:#fff0ef;--color-surface-success:#eaf7f0;--color-surface-selected:#e9f1f8",
  "--space-inline-tight:4px;--space-control-gap:8px;--space-content-gap:12px;--space-section-gap:20px;--space-page-gutter:28px;--space-page-gutter-mobile:16px",
  "--font-interface:\"IBM Plex Sans\",\"Segoe UI\",sans-serif;--font-numeric:\"IBM Plex Mono\",\"SFMono-Regular\",monospace",
  "--font-caption:12px;--font-body:14px;--font-body-large:16px;--font-heading-small:18px;--font-heading-page:26px;--font-metric:30px",
  "--weight-regular:400;--weight-medium:550;--weight-strong:700;--radius-control:6px;--radius-panel:10px;--radius-pill:999px;--shadow-raised:0 2px 8px #172b3a14;--layer-sticky:10;--layer-navigation:20}",
  "*,*::before,*::after{box-sizing:border-box}",
  "*{margin:0;padding:0}",
  "html{background-color:var(--color-page);color:var(--color-text);font-family:var(--font-interface);font-size:var(--font-body);line-height:1.5}",
  "body{min-width:320px}",
  "a{color:var(--color-action)}",
  "a[href]{display:inline-flex;align-items:center;min-width:44px;min-height:44px}",
  "button,input,select,textarea{font:inherit;color:inherit}",
  "button,.button,.nav-link,.mobile-link,.back-link{min-height:44px;min-width:44px}",
  "button,.button{border:1px solid var(--color-action);border-radius:var(--radius-control);background-color:var(--color-action);color:var(--color-surface);font-weight:var(--weight-medium);padding:12px 20px;display:inline-flex;align-items:center;justify-content:center;gap:var(--space-control-gap);text-decoration:none}",
  "button.secondary,.button.secondary{background-color:var(--color-surface);color:var(--color-action);border-color:var(--color-border)}",
  "button:disabled{cursor:not-allowed;opacity:.65}",
  ":focus-visible{outline:3px solid var(--color-focus);outline-offset:2px}",
  "input,textarea{width:100%;min-height:44px;border:1px solid var(--color-border);border-radius:var(--radius-control);background-color:var(--color-surface);padding:12px}",
  "input[aria-invalid=\"true\"],textarea[aria-invalid=\"true\"]{border-color:var(--color-danger);background-color:var(--color-surface-danger)}",
  "textarea{min-height:160px;line-height:1.55}",
  "label,.field-label{display:block;font-weight:var(--weight-medium);margin-bottom:var(--space-inline-tight)}",
  "fieldset{border:1px solid var(--color-border);border-radius:var(--radius-control);padding:var(--space-content-gap)}",
  "legend{font-weight:var(--weight-medium);padding:0 var(--space-inline-tight)}",
  "input[type=\"radio\"]{appearance:none;-webkit-appearance:none;width:44px;min-width:44px;height:44px;min-height:44px;border:0;border-radius:var(--radius-pill);background-image:radial-gradient(circle,var(--color-surface) 0 6px,var(--color-border) 7px 8px,transparent 9px);cursor:pointer}",
  "input[type=\"radio\"]:checked{background-image:radial-gradient(circle,var(--color-action) 0 5px,var(--color-surface) 6px 7px,var(--color-action) 8px 9px,transparent 10px)}",
  ".choice{display:flex;align-items:flex-start;gap:var(--space-control-gap);min-height:44px;padding:12px 0;font-weight:var(--weight-regular);cursor:pointer}",
  ".shell{display:grid;grid-template-columns:224px minmax(0,1fr);min-height:100vh}",
  ".sidebar{position:sticky;top:0;height:100vh;background-color:var(--color-surface);border-right:1px solid var(--color-border);padding:20px 16px;z-index:var(--layer-sticky)}",
  ".brand{font-size:var(--font-heading-small);font-weight:var(--weight-strong);padding:0 12px 16px}",
  ".brand small{display:block;color:var(--color-text-muted);font-size:var(--font-caption);font-weight:var(--weight-regular);margin-top:4px}",
  ".nav{display:grid;gap:var(--space-inline-tight)}",
  ".nav-link{display:flex;align-items:center;padding:12px;border-radius:var(--radius-control);text-decoration:none;color:var(--color-text);font-weight:var(--weight-medium)}",
  ".nav-link[aria-current=\"page\"]{background-color:var(--color-surface-selected);color:var(--color-action)}",
  "main{min-width:0;padding:20px var(--space-page-gutter) 28px;max-width:1440px;width:100%;margin:0 auto}",
  ".page-head{display:flex;justify-content:space-between;align-items:flex-start;gap:var(--space-section-gap);margin-bottom:20px}",
  ".page-head h1{font-size:var(--font-heading-page);line-height:1.2;margin-bottom:4px}",
  ".page-head p{color:var(--color-text-muted)}",
  ".refresh{font-size:var(--font-caption);color:var(--color-text-muted);white-space:nowrap}",
  ".back-link{display:inline-flex;align-items:center;margin-bottom:8px}",
  "h1,h2,h3{margin:0}",
  "h2{font-size:var(--font-heading-small)}",
  "h3{font-size:var(--font-body-large)}",
  ".section{margin-top:var(--space-section-gap)}",
  ".section-head{display:flex;align-items:center;justify-content:space-between;gap:var(--space-content-gap);margin-bottom:8px}",
  ".section-head p{color:var(--color-text-muted)}",
  ".panel{background-color:var(--color-surface);border:1px solid var(--color-border);border-radius:var(--radius-panel);padding:20px}",
  ".panel.flush{padding:0;overflow:hidden}",
  ".panel + .panel{margin-top:var(--space-content-gap)}",
  ".split{display:grid;grid-template-columns:minmax(0,2fr) minmax(270px,1fr);gap:var(--space-section-gap);align-items:start}",
  ".status{display:inline-flex;align-items:center;min-height:26px;border-radius:var(--radius-pill);padding:4px 8px;font-size:var(--font-caption);font-weight:var(--weight-strong);white-space:nowrap;background-color:var(--color-surface-selected);color:var(--color-action)}",
  ".status.attention{background-color:var(--color-surface-attention);color:var(--color-attention)}",
  ".status.danger{background-color:var(--color-surface-danger);color:var(--color-danger)}",
  ".status.success{background-color:var(--color-surface-success);color:var(--color-success)}",
  ".ledger{list-style:none}",
  ".ledger li{display:grid;grid-template-columns:minmax(0,1.7fr) minmax(120px,.8fr) minmax(100px,.65fr) auto;gap:var(--space-content-gap);align-items:center;min-height:64px;padding:12px 16px;border-top:1px solid var(--color-border)}",
  ".ledger li:first-child{border-top:0}",
  ".ledger strong{display:block}",
  ".meta{color:var(--color-text-muted);font-size:var(--font-caption)}",
  ".attention-rail{border-left:5px solid var(--color-attention)}",
  ".metric{padding:16px;background-color:var(--color-surface);border:1px solid var(--color-border);border-radius:var(--radius-panel)}",
  ".metric-name{color:var(--color-text-muted);font-size:var(--font-caption)}",
  ".metric-value{font-family:var(--font-numeric);font-size:var(--font-metric);font-weight:var(--weight-strong);line-height:1.2;margin-top:4px}",
  ".metric-detail{font-size:var(--font-caption);margin-top:4px}",
  ".money,.number{font-family:var(--font-numeric);font-variant-numeric:tabular-nums}",
  ".row{display:flex;gap:var(--space-content-gap);align-items:center;justify-content:space-between}",
  ".stack{display:grid;gap:var(--space-content-gap);list-style:none}",
  ".actions{display:flex;gap:var(--space-control-gap);flex-wrap:wrap;align-items:center}",
  ".divider{border:0;border-top:1px solid var(--color-border);margin:16px 0}",
  ".tabs{display:flex;gap:var(--space-control-gap);overflow:auto;padding-bottom:4px}",
  ".tab{min-height:44px;padding:12px;border:1px solid var(--color-border);border-radius:var(--radius-control);background-color:var(--color-surface);color:var(--color-text);white-space:nowrap}",
  ".tab[aria-current=\"true\"]{background-color:var(--color-surface-selected);border-color:var(--color-action);color:var(--color-action);font-weight:var(--weight-strong)}",
  ".notice{border:1px solid var(--color-border);border-left:4px solid var(--color-action);border-radius:var(--radius-control);padding:12px 16px;background-color:var(--color-surface)}",
  ".notice.attention{border-left-color:var(--color-attention);background-color:var(--color-surface-attention)}",
  ".notice.danger{border-left-color:var(--color-danger);background-color:var(--color-surface-danger)}",
  ".notice.success{border-left-color:var(--color-success);background-color:var(--color-surface-success)}",
  ".notice p{margin-top:4px}",
  ".field-help{font-size:var(--font-caption);color:var(--color-text-muted);margin-top:4px}",
  ".validation{font-size:var(--font-caption);color:var(--color-danger);margin-top:4px}",
  ".state-page{min-height:58vh;display:flex;align-items:center;justify-content:center}",
  ".state-card{width:min(560px,100%);padding:28px;background-color:var(--color-surface);border:1px solid var(--color-border);border-radius:var(--radius-panel)}",
  ".state-card h2{font-size:var(--font-heading-page);margin-bottom:8px}",
  ".state-card p{color:var(--color-text-muted);font-size:var(--font-body-large)}",
  ".state-card .actions{margin-top:16px}",
  ".mobile-nav{display:none}",
  ".reserve{display:none}",
  "@media (max-width:760px){",
  ".shell{display:block}",
  ".sidebar{display:none}",
  "main{padding:20px var(--space-page-gutter-mobile) 28px}",
  ".split{grid-template-columns:1fr}",
  ".ledger li{grid-template-columns:1fr auto}",
  ".ledger li>*:nth-child(2),.ledger li>*:nth-child(3){grid-column:1}",
  ".mobile-nav{position:fixed;display:grid;grid-template-columns:repeat(4,1fr);bottom:0;left:0;right:0;background-color:var(--color-surface);border-top:1px solid var(--color-border);box-shadow:var(--shadow-raised);z-index:var(--layer-navigation);padding-bottom:max(4px,env(safe-area-inset-bottom))}",
  ".mobile-link{display:flex;align-items:center;justify-content:center;text-align:center;padding:8px 4px;color:var(--color-text);font-size:var(--font-caption);text-decoration:none}",
  ".mobile-link[aria-current=\"page\"]{color:var(--color-action);font-weight:var(--weight-strong);background-color:var(--color-surface-selected)}",
  ".primary-action{position:fixed;left:var(--space-page-gutter-mobile);right:var(--space-page-gutter-mobile);bottom:74px;z-index:var(--layer-navigation);box-shadow:var(--shadow-raised);width:auto}",
  ".reserve{display:block;height:120px}",
  "}",
  "@media (max-width:420px){.actions{display:grid}.actions>*{width:100%}}",
].join("");

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function documentHtml(options: { title: string; body: string }): string {
  return [
    "<!doctype html>",
    '<html lang="zh-CN"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${escapeHtml(options.title)}</title>`,
    `<style>${STYLES}</style>`,
    `</head><body>${options.body}</body></html>`,
  ].join("");
}

function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}

/** Fills the `{name}` slots a copy template declares. */
function fill(template: string, values: Record<string, string>): string {
  let line = template;
  for (const [name, value] of Object.entries(values)) line = line.replaceAll(`{${name}}`, value);
  return line;
}

function sidebar(current: NavKey): string {
  const links = NAV_ITEMS.map((item) =>
    `<a class="nav-link" href="${item.href}"${item.key === current ? ' aria-current="page"' : ""}>${NAV_LONG[item.key]}</a>`
  ).join("");
  return `<aside class="sidebar"><div class="brand">${copy.brand.name}<small>${copy.brand.tagline}</small></div>`
    + `<nav class="nav" aria-label="${copy.nav.landmark}">${links}</nav></aside>`;
}

function mobileNav(current: NavKey): string {
  const links = NAV_ITEMS.map((item) =>
    `<a class="mobile-link" href="${item.href}"${item.key === current ? ' aria-current="page"' : ""}>${NAV_SHORT[item.key]}</a>`
  ).join("");
  return `<nav class="mobile-nav" aria-label="${copy.nav.landmark}">${links}</nav>`;
}

function shell(options: { title: string; current: NavKey; body: string }): string {
  return documentHtml({
    title: options.title,
    body: `<div class="shell">${sidebar(options.current)}<main>${options.body}`
      + '<div class="reserve" aria-hidden="true"></div></main></div>'
      + mobileNav(options.current),
  });
}

function pageHead(heading: string, intro: string, trailing: string): string {
  return `<header class="page-head"><div><h1>${escapeHtml(heading)}</h1><p>${escapeHtml(intro)}</p></div>${trailing}</header>`;
}

function subjectKindWord(kind: OperatorSubjectKind): string {
  return copy.subjectKinds[kind];
}

function todoKindWord(kind: OperatorTodoKind): string {
  return copy.todoKinds[kind];
}

function backLink(): string {
  return `<a class="back-link" href="/operator/overview">${copy.overview.back}</a>`;
}

function waitingMinutes(waitingSince: number, now: number): number {
  return Math.max(0, Math.floor((now - waitingSince) / 60_000));
}

function emptyPanel(heading: string, body: string, action: string): string {
  return `<div class="panel"><h2>${escapeHtml(heading)}</h2>`
    + (body ? `<p>${escapeHtml(body)}</p>` : "")
    + action
    + "</div>";
}

function overviewSection(id: string, heading: string, panel: string): string {
  return `<section class="section" aria-labelledby="${id}"><div class="section-head"><h2 id="${id}">${heading}</h2></div>${panel}</section>`;
}

function overviewRows(items: readonly OverviewItem[]): string {
  return items.map((item) => [
    "<li>",
    `<div><strong>${escapeHtml(item.subject.title)}</strong>`,
    `<span class="meta">${subjectKindWord(item.subject.kind)}${item.phase ? ` · ${escapeHtml(item.phase)}` : ""}</span></div>`,
    `<span class="status ${item.state === "running" ? "" : item.state === "failed" ? "danger" : "success"}">${copy.overview.itemState[item.state]}</span>`,
    `<span class="meta money">${usd(item.costUsd)}</span>`,
    `<a href="/operator/subjects/${item.subject.kind}/${encodeURIComponent(item.subject.id)}">${copy.overview.detailLink}</a>`,
    "</li>",
  ].join("")).join("");
}

function renderOverviewBody(value: OperatorOverview, now: number): string {
  const waiting = value.waitingForOperator.length > 0
    ? `<div class="panel flush attention-rail"><ul class="ledger">`
      + value.waitingForOperator.map((todo) => [
        "<li>",
        `<div><strong>${escapeHtml(todo.subject.title)}</strong>`,
        `<span class="meta">${todoKindWord(todo.kind)} · ${fill(copy.overview.waitingDuration, { minutes: String(waitingMinutes(todo.waitingSince, now)) })}</span></div>`,
        `<span class="status attention">${todoKindWord(todo.kind)}</span>`,
        `<span class="meta">${escapeHtml(todo.sourceLabel)}</span>`,
        `<a class="button" href="/operator/todos/${encodeURIComponent(todo.id)}">${copy.overview.handle}</a>`,
        "</li>",
      ].join("")).join("")
      + "</ul></div>"
    : emptyPanel(
      copy.overview.waitingEmptyHeading,
      copy.overview.waitingEmptyBody,
      `<div class="actions"><a class="button secondary" href="#running-title">${copy.overview.inspectRuns}</a></div>`,
    );

  const running = value.running.length > 0
    ? `<div class="panel flush"><ul class="ledger">${overviewRows(value.running)}</ul></div>`
    : emptyPanel(copy.overview.runningEmpty, "", "");
  const failures = value.failures.length > 0
    ? `<div class="panel flush"><ul class="ledger">${overviewRows(value.failures)}</ul></div>`
    : emptyPanel(copy.overview.failuresEmpty, "", "");
  const completed = value.recentlyCompleted.length > 0
    ? `<div class="panel flush"><ul class="ledger">${overviewRows(value.recentlyCompleted)}</ul></div>`
    : emptyPanel(copy.overview.completedEmpty, "", "");

  const completedCount = value.recentlyCompleted.length;
  const completedCost = value.recentlyCompleted.reduce((total, item) => total + item.costUsd, 0);
  const summary = `<aside class="stack" aria-label="${copy.overview.summaryLabel}">`
    + `<div class="metric"><div class="metric-name">${copy.overview.summaryCompleted}</div>`
    + `<div class="metric-value">${completedCount}</div><div class="metric-detail">${copy.overview.summaryScope}</div></div>`
    + `<div class="metric"><div class="metric-name">${copy.overview.summaryCost}</div>`
    + `<div class="metric-value">${usd(completedCost)}</div><div class="metric-detail">${copy.overview.summaryScope}</div></div>`
    + "</aside>";

  return `<div class="split"><div>`
    + overviewSection("attention-title", copy.overview.waiting, waiting)
    + overviewSection("running-title", copy.overview.running, running)
    + overviewSection("failed-title", copy.overview.failures, failures)
    + overviewSection("done-title", copy.overview.completed, completed)
    + `</div>${summary}</div>`;
}

function renderOptionField(option: TodoOption, input: { name: string; checkedId?: string }): string {
  const checked = input.checkedId === option.id ? " checked" : "";
  const description = option.description ? `<br><span class="meta">${escapeHtml(option.description)}</span>` : "";
  return `<label class="choice"><input type="radio" name="${input.name}" value="${escapeHtml(option.id)}"${checked}>`
    + `<span><strong>${escapeHtml(option.label)}</strong>${description}</span></label>`;
}

function renderTodoSummary(todo: OperatorTodo): string {
  return `<aside class="stack"><section class="panel"><h2>${copy.todo.summaryHeading}</h2><hr class="divider">`
    + `<div class="row"><span>${copy.todo.summaryType}</span><strong>${todoKindWord(todo.kind)}</strong></div>`
    + `<div class="row"><span>${copy.todo.summarySource}</span><strong>${escapeHtml(todo.sourceLabel)}</strong></div>`
    + `<div class="row"><span>${copy.todo.summaryDestination}</span><strong>${copy.todo.destinationValue}</strong></div>`
    + "</section></aside>";
}

function renderTodoFields(todo: OperatorTodo, submittedValue: string): string {
  const submitted = escapeHtml(submittedValue);
  if (todo.kind === "reply") {
    return `<div><label for="todo-reply">${escapeHtml(todo.answerLabel)}</label>`
      + `<textarea id="todo-reply" name="text">${submitted}</textarea>`
      + `<p class="field-help">${copy.todo.replyHelp}</p></div>`
      + `<div class="actions"><button class="primary-action" type="submit">${copy.todo.submitReply}</button></div>`;
  }
  if (todo.kind === "approval") {
    const first = todo.options[0];
    return `<fieldset><legend>${copy.todo.approveLegend}</legend>`
      + todo.options.map((option) => renderOptionField(option, { name: "decision", checkedId: first.id })).join("")
      + "</fieldset>"
      + `<div><label for="todo-note">${escapeHtml(todo.noteLabel)}</label>`
      + `<textarea id="todo-note" name="note">${submitted}</textarea>`
      + `<p class="field-help">${copy.todo.noteHelp}</p></div>`
      + `<div class="actions"><button class="primary-action" type="submit">${copy.todo.submitApproval}</button></div>`;
  }
  return `<fieldset><legend>${copy.todo.choiceLegend}</legend>`
    + todo.options.map((option) => renderOptionField(option, { name: "option" })).join("")
    + "</fieldset>"
    + `<div class="actions"><button class="primary-action" type="submit">${copy.todo.submitChoice}</button></div>`;
}

function renderTodoBody(todo: OperatorTodo, options: { submittedValue?: string }): string {
  const subject = `${escapeHtml(todo.subject.title)} · ${subjectKindWord(todo.subject.kind)} · ${escapeHtml(todo.sourceLabel)}`;
  return backLink()
    + `<header class="page-head"><div><h1>${copy.todo.heading}</h1><p>${subject}</p></div>`
    + `<span class="status attention">${todoKindWord(todo.kind)}</span></header>`
    + `<div class="split"><div>`
    + `<div class="notice attention"><h2>${copy.todo.questionHeading}</h2><p>${escapeHtml(todo.question)}</p></div>`
    + `<section class="panel section"><h2>${copy.todo.contextHeading}</h2><p>${escapeHtml(todo.context)}</p></section>`
    + `<form class="panel section" method="post" action="/operator/todos/${encodeURIComponent(todo.id)}">`
    + `<input type="hidden" name="revision" value="${escapeHtml(todo.revision)}">`
    + renderTodoFields(todo, options.submittedValue ?? "")
    + "</form></div>"
    + renderTodoSummary(todo)
    + "</div>";
}

export function renderOperatorAccessPage(): string {
  const denied = copy.access;
  return documentHtml({
    title: copy.titles.access,
    body: [
      '<section class="state-view" id="state-default">',
      `<header class="page-head"><div><h1>${denied.heading}</h1><p>${denied.intro}</p></div></header>`,
      '<div class="state-page"><div class="state-card">',
      `<span class="status danger">${denied.deniedStatus}</span>`,
      `<h2>${denied.deniedHeading}</h2>`,
      `<p>${denied.deniedBody}</p>`,
      `<p>${denied.connectNetwork}</p>`,
      `<form class="actions" method="get" action="/operator/overview"><button class="primary-action" type="submit">${denied.recheck}</button></form>`,
      "</div></div></section>",
    ].join(""),
  });
}

export function renderOperatorOverviewPage(
  state: ConsolePageState<OperatorOverview>,
  now: number,
): string {
  const value = state.kind === "ready" || state.kind === "waiting" ? state.value : state.previous;
  return shell({
    title: copy.titles.overview,
    current: "overview",
    body: pageHead(copy.overview.heading, copy.overview.intro, "")
      + (value ? renderOverviewBody(value, now) : ""),
  });
}

export function renderOperatorTodoPage(
  state: ConsolePageState<OperatorTodoResult>,
  options: { submission?: TodoSubmissionResult; submittedValue?: string } = {},
): string {
  const value = state.kind === "ready" || state.kind === "waiting" ? state.value : state.previous;
  const body = value?.kind === "pending" ? renderTodoBody(value.todo, options) : "";
  return shell({
    title: copy.titles.todo,
    current: "overview",
    body,
  });
}

export function renderOperatorDetailPage(
  state: ConsolePageState<OperatorDetailResult>,
  selectedRound?: number,
): string {
  void state;
  void selectedRound;
  return "";
}

/** Registers the console routes behind one read port and one command port. */
function sendHtml(reply: FastifyReply, body: string): FastifyReply {
  return reply.code(200).type("text/html; charset=utf-8").send(body);
}

/** A read that failed is reported as such and never guessed at: the page names
 * what it could not read and offers a retry in place of stale content. */
async function loadPageState<T>(load: () => Promise<T>): Promise<ConsolePageState<T>> {
  try {
    return { kind: "ready", value: await load(), refreshing: false };
  } catch {
    return { kind: "failed" };
  }
}

/**
 * Registers the access gate, overview, todo and detail HTTP surfaces. The gate
 * must run before every data route and before the application shell is sent;
 * denied requests receive only the access screen and never call another port.
 */
export async function registerOperatorConsoleRoutes(
  app: FastifyInstance,
  dependencies: OperatorConsoleDependencies,
): Promise<void> {
  // An HTML form posts urlencoded, and the console may not add a dependency
  // for it: the repository decides what it is built with, not this card.
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_request, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  /** The gate every data route sits behind. A denied request receives the
   * access screen and nothing else: no read port is called, so there is no
   * state to leak even by accident. */
  const allow = async (request: FastifyRequest, reply: FastifyReply): Promise<boolean> => {
    if (dependencies.access.decide(request.ip).kind === "allowed") return true;
    await reply.code(403).type("text/html; charset=utf-8").send(renderOperatorAccessPage());
    return false;
  };

  app.get("/operator/overview", async (request, reply) => {
    if (!(await allow(request, reply))) return reply;
    const state = await loadPageState(() => dependencies.reads.overview());
    return sendHtml(reply, renderOperatorOverviewPage(state, Date.now()));
  });

  app.get("/operator/todos/:todoId", async (request, reply) => {
    if (!(await allow(request, reply))) return reply;
    const { todoId } = request.params as { todoId: string };
    const state = await loadPageState(() => dependencies.reads.todo(todoId));
    return sendHtml(reply, renderOperatorTodoPage(state));
  });
}
