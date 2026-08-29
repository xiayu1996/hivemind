import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { NotionSdkCommentSource, NotionSdkMediaPort, createNotionHttpTransport } from "./sdk-adapters.js";

describe("Notion HTTP transport", () => {
  it("maps the gateway contract to the versioned API and exposes Retry-After", async () => {
    let observed: { url: string; init?: RequestInit } | undefined;
    const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      observed = { url: String(url), ...(init ? { init } : {}) };
      return new Response(JSON.stringify({ code: "rate_limited" }), {
        status: 429,
        headers: { "retry-after": "2" },
      });
    });
    const transport = createNotionHttpTransport({ token: "test-token", request });
    await expect(transport({ method: "PATCH", path: "/v1/pages/page-1", priority: "status", body: { x: 1 } }))
      .resolves.toMatchObject({ status: 429, retryAfterSeconds: 2, data: { code: "rate_limited" } });
    expect(observed?.url).toBe("https://api.notion.com/v1/pages/page-1");
    expect(observed?.init?.headers).toMatchObject({ "notion-version": "2025-09-03" });
  });
});

describe("Notion SDK comment source", () => {
  it("paginates block comments and maps them back to their owning page", async () => {
    const list = vi.fn()
      .mockResolvedValueOnce({
        results: [{
          id: "c1",
          parent: { type: "block_id", block_id: "block-1" },
          discussion_id: "d1",
          created_by: { id: "user-1" },
          created_time: "2026-08-29T00:00:00.000Z",
          rich_text: [{ plain_text: "first " }, { plain_text: "comment" }],
        }],
        has_more: true,
        next_cursor: "next",
      })
      .mockResolvedValueOnce({ results: [], has_more: false, next_cursor: null });
    const comments = await new NotionSdkCommentSource({ comments: { list } } as never)
      .listComments("block-1", "page-1");
    expect(comments).toEqual([expect.objectContaining({
      id: "c1", pageId: "page-1", blockId: "block-1", body: "first comment",
    })]);
    expect(list).toHaveBeenNthCalledWith(2, expect.objectContaining({ start_cursor: "next" }));
  });
});

describe("Notion SDK media port", () => {
  it("uploads the observed bytes and appends a file_upload image block", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hm-notion-media-"));
    const path = join(directory, "image.png");
    await writeFile(path, Buffer.from([1, 2, 3]));
    const create = vi.fn(async () => ({ id: "upload-1" }));
    const send = vi.fn(async () => ({}));
    const append = vi.fn(async () => ({}));
    const port = new NotionSdkMediaPort({
      fileUploads: { create, send },
      blocks: { children: { append } },
    } as never);
    await expect(port.upload({ path, size: 3, contentType: "image/png" })).resolves.toEqual({ uploadId: "upload-1" });
    await port.attach("block-1", "upload-1", "Evidence");
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ file_upload_id: "upload-1" }));
    expect(append).toHaveBeenCalledWith(expect.objectContaining({ block_id: "block-1" }));
  });
});
