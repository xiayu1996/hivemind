import { createHash } from "node:crypto";
import { z } from "zod";
import type { RequirementIntake, RequirementStore } from "../orchestrator/requirement-store.js";
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

/**
 * A requirement card carries no id token: a person writes it in their own
 * words. The page id is the only stable identifier the board offers, so the
 * requirement id is derived from it and survives every retitling.
 */
export function requirementIdFor(notionPageId: string): string {
  return `R-${createHash("sha256").update(notionPageId).digest("hex").slice(0, 12)}`;
}

function selectName(value: unknown): string | null {
  const parsed = z.object({ select: z.object({ name: z.string() }).nullable() }).safeParse(value);
  return parsed.success ? parsed.data.select?.name ?? null : null;
}

export type RequirementRepositoryResolution =
  | { kind: "repository"; slug: string }
  | { kind: "skip"; reason: string };

/**
 * Which registered repository a requirement card is for.
 *
 * A card whose repository cannot be resolved is left on the board rather than
 * taken in with a guess: a requirement that went to the wrong repository is
 * decomposed, branched and reviewed there before anyone notices, while a card
 * that waits costs a person one property.
 */
export function resolveRequirementRepository(
  selected: string | null,
  registered: readonly string[],
): RequirementRepositoryResolution {
  if (selected) {
    if (registered.includes(selected)) return { kind: "repository", slug: selected };
    return { kind: "skip", reason: `names the repository ${selected}, which is not registered here` };
  }
  if (registered.length === 1) return { kind: "repository", slug: registered[0]! };
  if (registered.length === 0) return { kind: "skip", reason: "no repository is registered yet" };
  return { kind: "skip", reason: "names no target repository, and this installation serves more than one" };
}

export interface RequirementIntakeResult {
  ingested: RequirementIntake[];
  /** Cards left on the board, with what a person has to fix. */
  skipped: { notionPageId: string; title: string; reason: string }[];
}

/**
 * Brings freshly written requirement cards into the central database. Unlike an
 * Epic, a requirement with an empty body is still workable: asking what it means
 * is the product manager's whole job, so the title alone is enough to start.
 */
export async function ingestRequirements(
  store: RequirementStore,
  gateway: NotionGateway,
  requirementsDataSourceId: string,
  registeredRepositories: readonly string[] = [],
): Promise<RequirementIntakeResult> {
  const response = await gateway.request({
    method: "POST",
    path: `/v1/data_sources/${encodeURIComponent(requirementsDataSourceId)}/query`,
    priority: "projection",
    body: {
      filter: {
        property: schema.propertyNames.requirementStatus,
        select: { equals: schema.options.requirementStatus[0] },
      },
      page_size: 100,
    },
  });
  const pages = listSchema.parse(response.data).results;
  const result: RequirementIntakeResult = { ingested: [], skipped: [] };

  for (const page of pages) {
    const pageId = String(page.id ?? "");
    const properties = (page.properties ?? {}) as Record<string, unknown>;
    const title = titleText(properties[schema.propertyNames.title]);
    if (!pageId || !title) continue;
    const repository = resolveRequirementRepository(
      selectName(properties[schema.propertyNames.repository]),
      registeredRepositories,
    );
    if (repository.kind === "skip") {
      // Not written to the database at all: the next cycle reads the card
      // again, so the person filling the property in is all it takes.
      result.skipped.push({ notionPageId: pageId, title, reason: repository.reason });
      continue;
    }
    const body = await readPageText(gateway, pageId);
    const intake: RequirementIntake = {
      id: requirementIdFor(pageId),
      notionPageId: pageId,
      title,
      originalRequest: body || title,
      repo: repository.slug,
    };
    if (await store.createRequirement(intake)) result.ingested.push(intake);
  }
  return result;
}

async function readPageText(gateway: NotionGateway, pageId: string): Promise<string> {
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
