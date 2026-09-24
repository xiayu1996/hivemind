import { createClient, type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../persistence/migrate.js";
import {
  CommentIngestor,
  type NotionComment,
  type NotionCommentSource,
} from "./comment-ingest.js";

let client: Client;

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  await migrate(client);
});

afterEach(() => client.close());

function comment(id: string, createdTime: number, blockId: string | null = null): NotionComment {
  return {
    id,
    pageId: "page-1",
    blockId,
    discussionId: `discussion-${id}`,
    authorId: "human-1",
    body: `body-${id}`,
    createdTime,
  };
}

describe("CommentIngestor", () => {
  it("polls the page and registered block anchors", async () => {
    const calls: string[] = [];
    const source: NotionCommentSource = {
      listComments: async (targetId) => {
        calls.push(targetId);
        return targetId === "spec-block" ? [comment("block-comment", 1_000, "spec-block")] : [];
      },
    };
    const ingestor = new CommentIngestor(client, source, { now: () => 2_000 });
    await ingestor.registerPage("page-1", ["spec-block", "design-anchor"]);
    expect(await ingestor.pollPage("page-1")).toEqual({ inserted: 1, maxCreatedTime: 1_000 });
    expect(calls).toEqual(["page-1", "design-anchor", "spec-block"]);
    const row = (await client.execute("SELECT block_id FROM ingested_comments")).rows[0];
    expect(row?.block_id).toBe("spec-block");
  });

  it("re-reads the two-minute overlap and inserts each comment only once", async () => {
    let poll = 0;
    const source: NotionCommentSource = {
      listComments: async () => {
        poll++;
        return poll === 1
          ? [comment("c-1", 300_000)]
          : [comment("c-1", 300_000), comment("c-2", 299_000)];
      },
    };
    const ingestor = new CommentIngestor(client, source, { now: () => 400_000 });
    await ingestor.registerPage("page-1", []);
    expect((await ingestor.pollPage("page-1")).inserted).toBe(1);
    expect((await ingestor.pollPage("page-1")).inserted).toBe(1);
    const count = (await client.execute("SELECT COUNT(*) AS count FROM ingested_comments")).rows[0]?.count;
    expect(count).toBe(2);
  });

  it("filters the integration bot and comments older than the overlap", async () => {
    const source: NotionCommentSource = {
      listComments: async () => [
        { ...comment("bot", 390_000), authorId: "bot-1" },
        comment("too-old", 100_000),
        comment("fresh", 390_000),
      ],
    };
    const ingestor = new CommentIngestor(client, source, { now: () => 400_000, botUserId: "bot-1" });
    await ingestor.registerPage("page-1", []);
    await client.execute({
      sql: "UPDATE comment_watermark SET max_created_time = ? WHERE page_id = ?",
      args: [300_000, "page-1"],
    });
    expect(await ingestor.pollPage("page-1")).toEqual({ inserted: 1, maxCreatedTime: 390_000 });
  });
});

describe("author names", () => {
  it("stores the name a person will read, not the id Notion gave them", async () => {
    const source: NotionCommentSource = {
      listComments: async (targetId) => (targetId === "page-1" ? [comment("c1", 1_000)] : []),
    };
    const asked: string[] = [];
    const ingestor = new CommentIngestor(client, source, {
      now: () => 2_000,
      users: {
        displayName: async (userId) => {
          asked.push(userId);
          return "雨 夏";
        },
      },
    });
    await ingestor.registerPage("page-1", []);

    await ingestor.pollPage("page-1");

    const rows = (await client.execute("SELECT author FROM ingested_comments")).rows;
    expect(rows).toMatchObject([{ author: "雨 夏" }]);
    expect(asked).toEqual(["human-1"]);
  });

  it("keeps the id when no directory is wired in, so ingest never depends on it", async () => {
    const source: NotionCommentSource = {
      listComments: async (targetId) => (targetId === "page-1" ? [comment("c1", 1_000)] : []),
    };
    const ingestor = new CommentIngestor(client, source, { now: () => 2_000 });
    await ingestor.registerPage("page-1", []);

    await ingestor.pollPage("page-1");

    expect((await client.execute("SELECT author FROM ingested_comments")).rows).toMatchObject([{ author: "human-1" }]);
  });
});
