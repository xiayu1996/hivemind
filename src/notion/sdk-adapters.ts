import type { Client } from "@notionhq/client";
import { Blob } from "node:buffer";
import { basename } from "node:path";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { NotionComment, NotionCommentSource } from "./comment-ingest.js";
import type { NotionTransport } from "./gateway.js";
import type { NotionGateway } from "./gateway.js";
import type { NotionMediaPort } from "./media.js";

type CommentClient = Pick<Client, "comments">;
type MediaClient = Pick<Client, "fileUploads" | "blocks">;

export interface NotionHttpTransportOptions {
  token: string;
  notionVersion?: string;
  baseUrl?: string;
  request?: typeof fetch;
}

/** Creates the only raw HTTP transport used beneath NotionGateway. */
export function createNotionHttpTransport(options: NotionHttpTransportOptions): NotionTransport {
  const request = options.request ?? fetch;
  const baseUrl = (options.baseUrl ?? "https://api.notion.com").replace(/\/$/, "");
  const notionVersion = options.notionVersion ?? "2025-09-03";
  return async (input) => {
    const multipart = typeof FormData !== "undefined" && input.body instanceof FormData;
    const body: FormData | string | undefined = input.body === undefined
      ? undefined
      : multipart
        ? input.body as FormData
        : JSON.stringify(input.body);
    const response = await request(`${baseUrl}${input.path}`, {
      method: input.method,
      headers: {
        authorization: `Bearer ${options.token}`,
        ...(multipart ? {} : { "content-type": "application/json" }),
        "notion-version": notionVersion,
      },
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(30_000),
    });
    const raw = await response.text();
    let data: unknown = null;
    if (raw) {
      try {
        data = JSON.parse(raw);
      } catch {
        data = { message: "Notion returned a non-JSON response" };
      }
    }
    const retryAfter = Number(response.headers.get("retry-after"));
    return {
      status: response.status,
      data,
      ...(Number.isFinite(retryAfter) && retryAfter >= 0 ? { retryAfterSeconds: retryAfter } : {}),
    };
  };
}

function richTextPlainText(richText: readonly { plain_text: string }[]): string {
  return richText.map((item) => item.plain_text).join("");
}

/** Maps paginated Notion comments into the ingest contract for page and block anchors. */
export class NotionSdkCommentSource implements NotionCommentSource {
  constructor(private readonly client: CommentClient) {}

  async listComments(targetId: string, pageId: string): Promise<NotionComment[]> {
    const comments: NotionComment[] = [];
    let cursor: string | undefined;
    do {
      const response = await this.client.comments.list({
        block_id: targetId,
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
      });
      for (const item of response.results) {
        comments.push({
          id: item.id,
          pageId,
          blockId: item.parent.type === "block_id" ? item.parent.block_id : null,
          discussionId: item.discussion_id,
          authorId: item.created_by.id,
          body: richTextPlainText(item.rich_text),
          createdTime: Date.parse(item.created_time),
        });
      }
      cursor = response.has_more && response.next_cursor ? response.next_cursor : undefined;
    } while (cursor);
    return comments;
  }
}

const gatewayCommentListSchema = z.object({
  results: z.array(z.object({
    id: z.string().min(1),
    discussion_id: z.string().min(1),
    created_time: z.string().min(1),
    created_by: z.object({ id: z.string().min(1) }).passthrough(),
    parent: z.object({ type: z.string(), block_id: z.string().optional() }).passthrough(),
    rich_text: z.array(z.object({ plain_text: z.string() }).passthrough()),
  }).passthrough()),
  has_more: z.boolean(),
  next_cursor: z.string().nullable(),
}).passthrough();

/** Reads comments through NotionGateway so polling shares the global budget. */
export class NotionGatewayCommentSource implements NotionCommentSource {
  constructor(private readonly gateway: NotionGateway) {}

  async listComments(targetId: string, pageId: string): Promise<NotionComment[]> {
    const comments: NotionComment[] = [];
    let cursor: string | undefined;
    do {
      const query = new URLSearchParams({ block_id: targetId, page_size: "100" });
      if (cursor) query.set("start_cursor", cursor);
      const response = await this.gateway.request({
        method: "GET",
        path: `/v1/comments?${query.toString()}`,
        priority: "interaction",
      });
      const data = gatewayCommentListSchema.parse(response.data);
      for (const item of data.results) {
        const createdTime = Date.parse(item.created_time);
        if (!Number.isFinite(createdTime)) throw new Error(`Notion comment has an invalid created_time: ${item.id}`);
        comments.push({
          id: item.id,
          pageId,
          blockId: item.parent.type === "block_id" ? item.parent.block_id ?? null : null,
          discussionId: item.discussion_id,
          authorId: item.created_by.id,
          body: item.rich_text.map((part) => part.plain_text).join(""),
          createdTime,
        });
      }
      cursor = data.has_more && data.next_cursor ? data.next_cursor : undefined;
    } while (cursor);
    return comments;
  }
}

function caption(content: string) {
  return content ? [{ type: "text" as const, text: { content } }] : [];
}

/** Performs Notion's single-part File Upload flow and appends an image block. */
export class NotionSdkMediaPort implements NotionMediaPort {
  constructor(private readonly client: MediaClient) {}

  async upload(input: { path: string; size: number; contentType: string }): Promise<{ uploadId: string }> {
    const created = await this.client.fileUploads.create({
      mode: "single_part",
      filename: basename(input.path),
      content_type: input.contentType,
    });
    const bytes = await readFile(input.path);
    if (bytes.byteLength !== input.size) throw new Error("evidence file changed while it was being uploaded");
    await this.client.fileUploads.send({
      file_upload_id: created.id,
      file: { filename: basename(input.path), data: new Blob([bytes], { type: input.contentType }) },
    });
    return { uploadId: created.id };
  }

  async attach(targetBlockId: string, uploadId: string, label: string): Promise<void> {
    await this.client.blocks.children.append({
      block_id: targetBlockId,
      children: [{
        object: "block",
        type: "image",
        image: {
          type: "file_upload",
          file_upload: { id: uploadId },
          caption: caption(label),
        },
      }],
    });
  }

  async attachPlaceholder(targetBlockId: string, text: string): Promise<void> {
    await this.client.blocks.children.append({
      block_id: targetBlockId,
      children: [{
        object: "block",
        type: "paragraph",
        paragraph: { rich_text: caption(text) },
      }],
    });
  }
}

const uploadResponseSchema = z.object({ id: z.string().min(1) }).passthrough();

/** Performs File Upload and attachment through the gateway's shared rate budget. */
export class NotionGatewayMediaPort implements NotionMediaPort {
  constructor(private readonly gateway: NotionGateway) {}

  async upload(input: { path: string; size: number; contentType: string }): Promise<{ uploadId: string }> {
    const created = await this.gateway.request({
      method: "POST",
      path: "/v1/file_uploads",
      priority: "report",
      body: {
        mode: "single_part",
        filename: basename(input.path),
        content_type: input.contentType,
      },
    });
    const uploadId = uploadResponseSchema.parse(created.data).id;
    const bytes = await readFile(input.path);
    if (bytes.byteLength !== input.size) throw new Error("evidence file changed while it was being uploaded");
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: input.contentType }), basename(input.path));
    await this.gateway.request({
      method: "POST",
      path: `/v1/file_uploads/${encodeURIComponent(uploadId)}/send`,
      priority: "report",
      body: form,
    });
    return { uploadId };
  }

  async attach(targetBlockId: string, uploadId: string, label: string): Promise<void> {
    await this.gateway.request({
      method: "PATCH",
      path: `/v1/blocks/${encodeURIComponent(targetBlockId)}/children`,
      priority: "report",
      body: {
        children: [{
          object: "block",
          type: "image",
          image: {
            type: "file_upload",
            file_upload: { id: uploadId },
            caption: caption(label),
          },
        }],
      },
    });
  }

  async attachPlaceholder(targetBlockId: string, text: string): Promise<void> {
    await this.gateway.request({
      method: "PATCH",
      path: `/v1/blocks/${encodeURIComponent(targetBlockId)}/children`,
      priority: "report",
      body: {
        children: [{
          object: "block",
          type: "paragraph",
          paragraph: { rich_text: caption(text) },
        }],
      },
    });
  }
}
