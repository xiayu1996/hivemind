import { createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate } from "../persistence/migrate.js";
import { ingestEpicsForDecomposition } from "./epic-intake.js";
import type { NotionGateway } from "./gateway.js";

function page(id: string, title: string, status: string): unknown {
  return {
    id,
    properties: {
      标题: { title: [{ plain_text: title }] },
      "Epic 状态": { select: { name: status } },
    },
  };
}

function paragraph(content: string): unknown {
  return { type: "paragraph", paragraph: { rich_text: [{ plain_text: content }] } };
}

describe("ingestEpicsForDecomposition", () => {
  let client: ReturnType<typeof createClient>;
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
    pages = [page("epic-page", "M2 并行与回归", "待拆解")];
    blocks = [paragraph("业务目标: 多个 Story 并行推进。"), paragraph("出口判据: 一次评审看到全部结果。")];
  });

  afterEach(() => client.close());

  it("takes the Epic id from the title token the board already uses", async () => {
    const ingested = await ingestEpicsForDecomposition(client, gateway(), "epics-ds", () => 5);

    expect(ingested).toMatchObject([{ id: "M2", notionPageId: "epic-page", title: "M2 并行与回归" }]);
    expect(ingested[0]?.requirement).toContain("业务目标: 多个 Story 并行推进。");
    expect(ingested[0]?.requirement).toContain("出口判据");
    const stored = (await client.execute("SELECT id, state FROM epics")).rows;
    expect(stored).toMatchObject([{ id: "M2", state: "INTAKE" }]);
  });

  it("is safe to run every cycle: an Epic already known keeps its state", async () => {
    await ingestEpicsForDecomposition(client, gateway(), "epics-ds", () => 5);
    await client.execute("UPDATE epics SET state = 'DECOMPOSE' WHERE id = 'M2'");

    await ingestEpicsForDecomposition(client, gateway(), "epics-ds", () => 6);

    expect((await client.execute("SELECT state FROM epics")).rows).toMatchObject([{ state: "DECOMPOSE" }]);
  });

  it("refuses a title with no usable id rather than inventing one", async () => {
    pages = [page("epic-page", "并行与回归", "待拆解")];
    await expect(ingestEpicsForDecomposition(client, gateway(), "epics-ds", () => 5))
      .rejects.toThrow(/Epic id/);
  });

  it("ignores an Epic with no requirement text to decompose", async () => {
    blocks = [];
    await expect(ingestEpicsForDecomposition(client, gateway(), "epics-ds", () => 5)).resolves.toEqual([]);
    expect((await client.execute("SELECT COUNT(*) AS count FROM epics")).rows[0]?.count).toBe(0);
  });
});
