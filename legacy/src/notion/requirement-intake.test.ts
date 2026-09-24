import { createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RequirementStore } from "../orchestrator/requirement-store.js";
import { migrate } from "../persistence/migrate.js";
import type { NotionGateway } from "./gateway.js";
import { ingestRequirements, requirementIdFor, resolveRequirementRepository } from "./requirement-intake.js";

function page(id: string, title: string, status: string, repository?: string): unknown {
  return {
    id,
    properties: {
      标题: { title: [{ plain_text: title }] },
      需求状态: { select: { name: status } },
      目标仓库: { select: repository ? { name: repository } : null },
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
    const { ingested } = await ingestRequirements(store, gateway(), "requirements-ds", ["owner/repo"]);

    expect(ingested).toMatchObject([
      { id: requirementIdFor("requirement-page"), notionPageId: "requirement-page", repo: "owner/repo" },
    ]);
    expect(ingested[0]?.originalRequest).toContain("我想不打开数据库就看到 agent 在做什么。");
    expect(ingested[0]?.originalRequest).toContain("手机上也要能看。");
    await expect(store.getRequirement(ingested[0]!.id)).resolves.toMatchObject({ state: "CLARIFY" });
  });

  it("starts on the title alone, because asking what an empty card means is the job", async () => {
    blocks = [];
    const { ingested } = await ingestRequirements(store, gateway(), "requirements-ds", ["owner/repo"]);

    expect(ingested).toHaveLength(1);
    expect(ingested[0]?.originalRequest).toBe("给 hivemind 做一个 web 控制台");
  });

  it("is safe to run every cycle: a card already known is not reported again", async () => {
    await ingestRequirements(store, gateway(), "requirements-ds", ["owner/repo"]);
    await store.transition(requirementIdFor("requirement-page"), "CLARIFY", "PRD_CONFIRM", "system", "run-1");

    await expect(ingestRequirements(store, gateway(), "requirements-ds", ["owner/repo"]))
      .resolves.toMatchObject({ ingested: [] });
    await expect(store.getRequirement(requirementIdFor("requirement-page"))).resolves.toMatchObject({
      state: "PRD_CONFIRM",
    });
  });

  it("keeps the id stable when a person retitles the card", async () => {
    await ingestRequirements(store, gateway(), "requirements-ds", ["owner/repo"]);
    pages = [page("requirement-page", "控制台（改名后）", "待澄清")];

    await expect(ingestRequirements(store, gateway(), "requirements-ds", ["owner/repo"]))
      .resolves.toMatchObject({ ingested: [] });
    expect((await client.execute("SELECT COUNT(*) AS count FROM requirements")).rows[0]?.count).toBe(1);
  });

  it("leaves a card whose repository cannot be resolved on the board", async () => {
    pages = [page("requirement-page", "给 hivemind 做一个 web 控制台", "待澄清")];
    const first = await ingestRequirements(store, gateway(), "requirements-ds", ["owner/repo", "owner/other"]);
    expect(first.ingested).toEqual([]);
    expect(first.skipped).toMatchObject([{ notionPageId: "requirement-page", reason: expect.stringContaining("more than one") }]);
    // Nothing was written, so filling the property in is all it takes.
    expect((await client.execute("SELECT COUNT(*) AS count FROM requirements")).rows[0]?.count).toBe(0);

    pages = [page("requirement-page", "给 hivemind 做一个 web 控制台", "待澄清", "owner/other")];
    const second = await ingestRequirements(store, gateway(), "requirements-ds", ["owner/repo", "owner/other"]);
    expect(second.ingested).toMatchObject([{ repo: "owner/other" }]);
  });

  it("refuses a repository this installation does not serve", async () => {
    pages = [page("requirement-page", "给 hivemind 做一个 web 控制台", "待澄清", "someone/else")];
    const result = await ingestRequirements(store, gateway(), "requirements-ds", ["owner/repo"]);
    expect(result.ingested).toEqual([]);
    expect(result.skipped[0]?.reason).toContain("not registered");
  });
});

describe("resolveRequirementRepository", () => {
  it("decides from what the person picked and what is registered", () => {
    expect(resolveRequirementRepository("a/b", ["a/b"])).toEqual({ kind: "repository", slug: "a/b" });
    expect(resolveRequirementRepository("a/b", ["c/d"])).toMatchObject({ kind: "skip" });
    expect(resolveRequirementRepository("a/b", [])).toMatchObject({ kind: "skip" });
    // One repository needs no choosing, which is the single-repository install.
    expect(resolveRequirementRepository(null, ["a/b"])).toEqual({ kind: "repository", slug: "a/b" });
    expect(resolveRequirementRepository(null, ["a/b", "c/d"])).toMatchObject({ kind: "skip" });
    expect(resolveRequirementRepository(null, [])).toMatchObject({ kind: "skip" });
  });
});
