import type { Client } from "@libsql/client";
import { z } from "zod";
import type { EpicIntake } from "../orchestrator/decompose-runner.js";
import type { NotionGateway } from "./gateway.js";
import schema from "./notion-schema.json" with { type: "json" };

const listSchema = z.object({
  results: z.array(z.record(z.string(), z.unknown())),
  has_more: z.boolean().optional(),
  next_cursor: z.string().nullable().optional(),
});

function titleText(value: unknown): string {
  const parsed = z.object({ title: z.array(z.object({ plain_text: z.string() }).passthrough()) }).safeParse(value);
  return parsed.success ? parsed.data.title.map((item) => item.plain_text).join("").trim() : "";
}

function blockText(block: Record<string, unknown>): string {
  for (const key of ["paragraph", "heading_1", "heading_2", "heading_3", "bulleted_list_item", "numbered_list_item"]) {
    const parsed = z.object({ rich_text: z.array(z.object({ plain_text: z.string() }).passthrough()) })
      .safeParse(block[key]);
    if (parsed.success) return parsed.data.rich_text.map((item) => item.plain_text).join("").trim();
  }
  return "";
}

/** The board already writes the Epic id as the first token of the title
 * ("M2 并行与回归"), and Story ids are built from it, so that is the id. */
function epicIdFrom(title: string): string {
  const token = title.split(/\s+/)[0] ?? "";
  if (!/^[A-Za-z0-9._-]+$/.test(token) || !/[A-Za-z0-9]/.test(token)) {
    throw new Error(`cannot read an Epic id from the title: ${title}`);
  }
  return token;
}

/**
 * Brings Epics waiting to be split into the central database. Nothing else
 * creates an Epic row, so without this the decomposition never has an input.
 */
export async function ingestEpicsForDecomposition(
  client: Client,
  gateway: NotionGateway,
  epicsDataSourceId: string,
  now: () => number = Date.now,
): Promise<EpicIntake[]> {
  const response = await gateway.request({
    method: "POST",
    path: `/v1/data_sources/${encodeURIComponent(epicsDataSourceId)}/query`,
    priority: "projection",
    body: {
      filter: { property: schema.propertyNames.epicStatus, select: { equals: schema.options.epicStatus[0] } },
      page_size: 100,
    },
  });
  const pages = listSchema.parse(response.data).results;
  const ingested: EpicIntake[] = [];

  for (const page of pages) {
    const pageId = String(page.id ?? "");
    const properties = (page.properties ?? {}) as Record<string, unknown>;
    const title = titleText(properties[schema.propertyNames.title]);
    if (!pageId || !title) continue;
    const requirement = await readRequirement(gateway, pageId);
    // An Epic with an empty body has nothing to decompose; leaving it alone is
    // better than sending the model a title and letting it invent the rest.
    if (!requirement) continue;
    const id = epicIdFrom(title);
    const time = now();
    await client.execute({
      sql: `INSERT INTO epics (id, notion_page_id, title, state, created_at, updated_at)
            VALUES (?, ?, ?, 'INTAKE', ?, ?)
            ON CONFLICT(id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at`,
      args: [id, pageId, title, time, time],
    });
    ingested.push({ id, notionPageId: pageId, title, requirement });
  }
  return ingested;
}

async function readRequirement(gateway: NotionGateway, pageId: string): Promise<string> {
  const lines: string[] = [];
  let cursor: string | undefined;
  do {
    const suffix = cursor ? `?page_size=100&start_cursor=${encodeURIComponent(cursor)}` : "?page_size=100";
    const response = await gateway.request({
      method: "GET",
      path: `/v1/blocks/${encodeURIComponent(pageId)}/children${suffix}`,
      priority: "projection",
    });
    const page = listSchema.parse(response.data);
    for (const block of page.results) {
      const text = blockText(block);
      if (text) lines.push(text);
    }
    cursor = page.has_more ? page.next_cursor ?? undefined : undefined;
  } while (cursor);
  return lines.join("\n");
}
