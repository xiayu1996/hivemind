import { createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RequirementStore } from "../orchestrator/requirement-store.js";
import { migrate } from "../persistence/migrate.js";
import type { NotionGateway } from "./gateway.js";
import { ingestRequirements, requirementIdFor } from "./requirement-intake.js";

function page(id: string, title: string, status: string): unknown {
  return {
    id,
    properties: {
      标题: { title: [{ plain_text: title }] },
      需求状态: { select: { name: status } },
    },
  };
}

function paragraph(content: string): unknown {
  return { type: "paragraph", paragraph: { rich_text: [{ plain_text: content }] } };
}

describe("ingestRequirements", () => {
  let client: ReturnType<typeof createClient>;
  let store: RequirementStore;
  let pages: unknown[];
  let blocks: unknown[];

  function gateway(): NotionGateway {
    return {
      request: vi.fn(async (request: { method: string; path: string }) => {
        if (request.path.endsWith("/query")) return { status: 200, data: { results: pages, has_more: false } };
        return { status: 200, data: { results: blocks, has_more: false } };
      }),
    } as unknown as NotionGateway;
  }

  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    await migrate(client);
    let time = 1_000;
    store = new RequirementStore(client, () => time++);
    pages = [page("requirement-page", "给 hivemind 做一个 web 控制台", "待澄清")];
    blocks = [paragraph("我想不打开数据库就看到 agent 在做什么。"), paragraph("手机上也要能看。")];
  });

  afterEach(() => client.close());

  it("takes in a card the person wrote in their own words", async () => {
    const ingested = await ingestRequirements(store, gateway(), "requirements-ds", "owner/repo");

    expect(ingested).toMatchObject([
      { id: requirementIdFor("requirement-page"), notionPageId: "requirement-page", repo: "owner/repo" },
    ]);
    expect(ingested[0]?.originalRequest).toContain("我想不打开数据库就看到 agent 在做什么。");
    expect(ingested[0]?.originalRequest).toContain("手机上也要能看。");
    await expect(store.getRequirement(ingested[0]!.id)).resolves.toMatchObject({ state: "CLARIFY" });
  });

  it("starts on the title alone, because asking what an empty card means is the job", async () => {
    blocks = [];
    const ingested = await ingestRequirements(store, gateway(), "requirements-ds");

    expect(ingested).toHaveLength(1);
    expect(ingested[0]?.originalRequest).toBe("给 hivemind 做一个 web 控制台");
  });

  it("is safe to run every cycle: a card already known is not reported again", async () => {
    await ingestRequirements(store, gateway(), "requirements-ds");
    await store.transition(requirementIdFor("requirement-page"), "CLARIFY", "PRD_CONFIRM", "system", "run-1");

    await expect(ingestRequirements(store, gateway(), "requirements-ds")).resolves.toEqual([]);
    await expect(store.getRequirement(requirementIdFor("requirement-page"))).resolves.toMatchObject({
      state: "PRD_CONFIRM",
    });
  });

  it("keeps the id stable when a person retitles the card", async () => {
    await ingestRequirements(store, gateway(), "requirements-ds");
    pages = [page("requirement-page", "控制台（改名后）", "待澄清")];

    await expect(ingestRequirements(store, gateway(), "requirements-ds")).resolves.toEqual([]);
    expect((await client.execute("SELECT COUNT(*) AS count FROM requirements")).rows[0]?.count).toBe(1);
  });
});
