import { createClient } from "@libsql/client";
import { describe, expect, it } from "vitest";
import { StoryExecutionStore } from "../orchestrator/story-execution-store.js";
import { migrate } from "../persistence/migrate.js";
import { NotionGateway } from "./gateway.js";
import { NotionGatewayStoryApi, ingestReadyStories, listReadyStories, type NotionStoryApi } from "./story-intake.js";

function richText(content: string) {
  return [{ plain_text: content }];
}

const page = {
  object: "page",
  id: "page-1",
  properties: {
    "标题": { type: "title", title: richText("Deliver one Story") },
    "任务 ID": { type: "rich_text", rich_text: richText("S-EPIC1-01") },
    "目标仓库": { type: "select", select: { name: "example/repo" } },
    "目标分支": { type: "rich_text", rich_text: richText("develop") },
    "优先级": { type: "select", select: { name: "P1" } },
    "能力标签": { type: "multi_select", multi_select: [{ name: "windows" }, { name: "web" }] },
  },
};

const blocks = [
  { id: "heading-requirement", type: "heading_2", heading_2: { rich_text: richText("需求描述") } },
  { id: "requirement-1", type: "paragraph", paragraph: { rich_text: richText("First requirement line.") } },
  { id: "requirement-2", type: "bulleted_list_item", bulleted_list_item: { rich_text: richText("Second line.") } },
  { id: "heading-specification", type: "heading_2", heading_2: { rich_text: richText("需求规格") } },
  { id: "heading-design", type: "heading_2", heading_2: { rich_text: richText("核心设计") } },
];

function api(): NotionStoryApi {
  return {
    queryReady: async (_dataSourceId, cursor) => cursor
      ? { results: [page], hasMore: false, nextCursor: null }
      : { results: [], hasMore: true, nextCursor: "page-2" },
    listChildren: async () => ({ results: blocks, hasMore: false, nextCursor: null }),
  };
}

describe("Notion Story intake", () => {
  it("routes data-source and block pagination through the central gateway", async () => {
    const paths: string[] = [];
    const gateway = new NotionGateway({
      ratePerSecond: 1_000_000,
      transport: async (request) => {
        paths.push(request.path);
        return { status: 200, data: { results: [], has_more: false, next_cursor: null } };
      },
    });
    const gatewayApi = new NotionGatewayStoryApi(gateway);
    await gatewayApi.queryReady("source-1");
    await gatewayApi.listChildren("page-1", "cursor-1");
    expect(paths).toEqual([
      "/v1/data_sources/source-1/query",
      "/v1/blocks/page-1/children?page_size=100&start_cursor=cursor-1",
    ]);
  });

  it("paginates ready cards and reads only the human-owned requirement section", async () => {
    await expect(listReadyStories(api(), "stories-source")).resolves.toEqual([{
      id: "S-EPIC1-01",
      notionPageId: "page-1",
      title: "Deliver one Story",
      requirement: "First requirement line.\nSecond line.",
      repo: "example/repo",
      branch: "story/s-epic1-01",
      targetBranch: "develop",
      priority: 1,
      capabilities: ["web", "windows"],
      sections: {
        requirement: "heading-requirement",
        specification: "heading-specification",
        design: "heading-design",
      },
    }]);
  });

  it("ingests each Notion page once and persists its section anchors", async () => {
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    const store = new StoryExecutionStore(client, () => 100);
    await expect(ingestReadyStories(api(), "stories-source", store)).resolves.toEqual(["S-EPIC1-01"]);
    await expect(ingestReadyStories(api(), "stories-source", store)).resolves.toEqual([]);
    await expect(store.getStory("S-EPIC1-01")).resolves.toMatchObject({
      state: "QUEUED",
      targetBranch: "develop",
      requirement: "First requirement line.\nSecond line.",
    });
    const anchors = await client.execute(
      "SELECT section, anchor_block_id FROM notion_sections ORDER BY section",
    );
    expect(anchors.rows).toMatchObject([
      { section: "design", anchor_block_id: "heading-design" },
      { section: "requirement", anchor_block_id: "heading-requirement" },
      { section: "specification", anchor_block_id: "heading-specification" },
    ]);
    client.close();
  });
});
