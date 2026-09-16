import type { Client, InStatement } from "@libsql/client";
import { createHash } from "node:crypto";
import { payloadHash } from "../notion/outbox.js";
import text from "./epic-page-text.json" with { type: "json" };
import {
  epicSectionTitle,
  quietText,
  waitingText,
  type EpicPageSection,
} from "../notion/display-text.js";
import {
  bullet,
  code,
  mermaid,
  paragraph,
  runs,
  t,
  toggle,
  plainText,
  type Block,
  type RichTextRun,
} from "../notion/rich-text.js";
import { BOARD_STATUS_FOR_STATE, type EpicBoardStatus } from "./epic-status-projection.js";
import type { EpicState } from "./state-machine.js";

export const SYNC_EPIC_PAGE = "sync_epic_page";

export interface EpicPageStory {
  id: string;
  title: string;
  /** Set once the Story page exists, which is when the plan line can mention it. */
  pageId: string | null;
  dependsOn: string[];
}

/**
 * What the Epic page shows, which is only what the Epic itself owns: the batch
 * it answers for and how to review it. Where each Story stands is the board's
 * job (the by-Epic view and the progress rollup), and a page that repeated it
 * would age the moment a Story moved.
 */
export interface EpicPagePayload {
  epicId: string;
  state: EpicState;
  status: EpicBoardStatus;
  mrUrl: string | null;
  targetBranch: string;
  integrationBranch: string | null;
  businessGoal: string | null;
  prdScenarios: Array<{ id: string; text: string }>;
  stories: EpicPageStory[];
}

export async function epicPagePayload(client: Client, epicId: string, targetBranch = "main"): Promise<EpicPagePayload | null> {
  const epic = (await client.execute({
    sql: "SELECT state, mr_url, integration_branch, business_goal, requirement_id FROM epics WHERE id = ?",
    args: [epicId],
  })).rows[0];
  if (!epic) return null;
  const state = String(epic.state) as EpicState;
  const status = BOARD_STATUS_FOR_STATE[state];
  if (!status) return null;
  const stories = (await client.execute({
    sql: `SELECT id, title, notion_page_id, depends_on FROM stories
          WHERE epic_id = ? ORDER BY created_at, id`,
    args: [epicId],
  })).rows.map((row) => ({
    id: String(row.id),
    title: String(row.title),
    // The gate inserts a Story with a synthetic page id before Notion has a
    // page; a mention of that id would render as a broken link.
    pageId: /^[0-9a-f-]{32,}$/i.test(String(row.notion_page_id)) ? String(row.notion_page_id) : null,
    dependsOn: JSON.parse(String(row.depends_on)) as string[],
  }));
  return {
    epicId,
    state,
    status,
    mrUrl: epic.mr_url === null ? null : String(epic.mr_url),
    targetBranch,
    integrationBranch: epic.integration_branch === null ? null : String(epic.integration_branch),
    businessGoal: epic.business_goal === null ? null : String(epic.business_goal),
    prdScenarios: epic.requirement_id === null ? [] : await prdScenarios(client, String(epic.requirement_id), epicId),
    stories,
  };
}

/** The PRD scenarios this batch answers for, in the words the PRD used. */
async function prdScenarios(
  client: Client,
  requirementId: string,
  epicId: string,
): Promise<Array<{ id: string; text: string }>> {
  const carried = (await client.execute({
    sql: `SELECT prd_scenario_id FROM epic_prd_scenarios
          WHERE requirement_id = ? AND epic_id = ? ORDER BY prd_scenario_id`,
    args: [requirementId, epicId],
  })).rows.map((row) => String(row.prd_scenario_id));
  if (carried.length === 0) return [];
  const prd = (await client.execute({
    sql: `SELECT body FROM requirement_prds
          WHERE requirement_id = ? AND status = 'confirmed' ORDER BY revision DESC LIMIT 1`,
    args: [requirementId],
  })).rows[0];
  if (!prd) return [];
  const scenarios = (JSON.parse(String(prd.body)) as {
    scenarios?: Array<{ id: string; given: string; when: string; then: string }>;
  }).scenarios ?? [];
  const byId = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
  return carried.flatMap((id) => {
    const scenario = byId.get(id);
    return scenario ? [{ id, text: `${scenario.given}，${scenario.when}，${scenario.then}` }] : [];
  });
}

/** The target every Epic page row is queued under. */
export function epicPageTarget(epicId: string): string {
  return `epic-page:${epicId}`;
}

/** What the outbox dedupes an Epic page by: the facts, plus how they read. */
export function epicPageHash(payload: EpicPagePayload): { json: string; hash: string } {
  const encoded = payloadHash(payload);
  // What the page shows is the rendering, not the payload: a change in wording
  // has to reproject the page even when every fact behind it is unchanged.
  const hash = createHash("sha256")
    .update([encoded.hash, ...renderEpicPage(payload).lines].join("\n"), "utf8")
    .digest("hex");
  return { json: encoded.json, hash };
}

export function epicPageStatement(payload: EpicPagePayload, time: number): InStatement {
  const encoded = epicPageHash(payload);
  const hash = encoded.hash;
  return {
    sql: `INSERT INTO notion_outbox (card_id, priority, operation, target, payload, payload_hash, created_at)
          VALUES (?, 2, ?, ?, ?, ?, ?)
          ON CONFLICT(target, payload_hash) DO NOTHING`,
    args: [payload.epicId, SYNC_EPIC_PAGE, epicPageTarget(payload.epicId), encoded.json, hash, time],
  };
}

/** Queues every live Epic's page; an unchanged page hashes to a row that already exists. */
export async function enqueueEpicPages(client: Client, targetBranch = "main", now: () => number = Date.now): Promise<number> {
  const epics = (await client.execute(
    "SELECT id, notion_status_shadow FROM epics WHERE state <> 'FAILED' ORDER BY id",
  )).rows;
  let queued = 0;
  for (const row of epics) {
    const payload = await epicPagePayload(client, String(row.id), targetBranch);
    if (!payload) continue;
    const result = await client.execute(epicPageStatement(payload, now()));
    if (result.rowsAffected === 1) {
      queued++;
      continue;
    }
    // The board shows the last status we wrote, and the hash above collapses a
    // page identical to one already sent. Those two together silently drop a
    // page that returns to an earlier state: an Epic that blocked and then
    // unblocked produces exactly the payload it had before it blocked, so the
    // board keeps reading blocked while the Epic runs. That is not only a lie
    // on the board -- decomposition ingests Epics by that same column, so one
    // such Epic starves every other one behind it. When the shadow disagrees
    // with the status the state now calls for, the sent row goes out again.
    const shadow = row.notion_status_shadow === null ? null : String(row.notion_status_shadow);
    if (shadow === null || shadow === payload.status) continue;
    const resent = await client.execute({
      sql: `UPDATE notion_outbox
            SET state = 'pending', attempts = 0, last_error = NULL, sent_at = NULL, created_at = ?
            WHERE target = ? AND payload_hash = ? AND state = 'sent'`,
      args: [now(), epicPageTarget(payload.epicId), epicPageHash(payload).hash],
    });
    queued += resent.rowsAffected;
  }
  return queued;
}

function fill(template: string, values: Record<string, string>): string {
  return template.replaceAll(/\{(\w+)\}/g, (_, key: string) => values[key] ?? "");
}

/** The sections the projection owns, rebuilt whole; the plan above them is a
 * record of what a person approved and is only ever appended to. */
export type OwnedEpicSection = Exclude<EpicPageSection, "plan">;

export interface RenderedEpicPage {
  callout: { content: string; icon: string; color: string };
  sections: Array<{ section: OwnedEpicSection; blocks: Block[] }>;
  /** Everything a person reads, for the hash that decides on a rewrite. */
  lines: string[];
}

/** The line a Story gets in the dependency graph, short enough to read. */
function graphNode(story: EpicPageStory): string {
  return `  ${story.id.replaceAll("-", "_")}["${story.title}"]`;
}

export function renderEpicPage(payload: EpicPagePayload): RenderedEpicPage {
  const waiting = waitingText("epic", payload.state);
  const callout = waiting
    ? { content: waiting.action, icon: waiting.icon, color: waiting.color }
    : { content: quietText().action, icon: quietText().icon, color: quietText().color };

  const goal: Block[] = [];
  if (payload.businessGoal) goal.push(paragraph(t(payload.businessGoal)));
  if (payload.prdScenarios.length > 0) {
    goal.push(paragraph(t(text.carriedScenarios)));
    for (const scenario of payload.prdScenarios) {
      goal.push(bullet(runs(t(`${scenario.text} `), code(scenario.id))));
    }
  }

  const edges = payload.stories.flatMap((story) => story.dependsOn
    .filter((upstream) => payload.stories.some((candidate) => candidate.id === upstream))
    .map((upstream) => `  ${upstream.replaceAll("-", "_")} --> ${story.id.replaceAll("-", "_")}`));
  const dependencies: Block[] = edges.length === 0
    ? []
    : [mermaid(["graph TD", ...payload.stories.map(graphNode), ...edges].join("\n"))];

  const technicalLines = [
    ...(payload.integrationBranch ? [fill(text.integrationBranch, { branch: payload.integrationBranch })] : []),
    ...(payload.mrUrl ? [fill(text.reviewRequest, { url: payload.mrUrl, target: payload.targetBranch })] : []),
  ];
  const technical: Block[] = technicalLines.length === 0
    ? []
    : [toggle(t(text.technicalFold), technicalLines.map((line) => paragraph(t(line))))];

  const sections: RenderedEpicPage["sections"] = [
    { section: "goal", blocks: goal },
    { section: "dependencies", blocks: dependencies },
    { section: "technical", blocks: technical },
  ];
  const lines = [
    callout.content,
    ...sections.flatMap(({ section, blocks }) => [
      epicSectionTitle(section),
      ...blocks.map((block) => renderedText(block)),
    ]),
  ];
  return { callout, sections, lines };
}

/** What a block says, however it is built, so two renderings compare as text. */
function renderedText(block: Block): string {
  const body = block[String(block.type)] as { rich_text?: RichTextRun[]; children?: Block[] } | undefined;
  const own = body?.rich_text ? plainText(body.rich_text) : "";
  const children = (body?.children ?? []).map((child) => renderedText(child));
  return [own, ...children].join("\n");
}
