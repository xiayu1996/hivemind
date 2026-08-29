import { extname } from "node:path";
import { stat } from "node:fs/promises";
import { redactForExport } from "../observability/redact.js";

export const MAX_NOTION_UPLOAD_BYTES = 20 * 1024 * 1024;

export interface MediaRequest {
  evidenceId: string;
  path: string;
  targetBlockId: string;
  caption: string;
}

export interface NotionMediaPort {
  upload(input: { path: string; size: number; contentType: string }): Promise<{ uploadId: string }>;
  attach(targetBlockId: string, uploadId: string, caption: string): Promise<void>;
}

export type MediaResult =
  | { kind: "image"; uploadId: string }
  | { kind: "placeholder"; text: string; reason?: string };

export interface QueuedMedia {
  placeholder: MediaResult;
  completion: Promise<MediaResult>;
}

function contentType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".webp": return "image/webp";
    case ".gif": return "image/gif";
    default: return "image/png";
  }
}

function unavailable(evidenceId: string, reason?: string): MediaResult {
  return {
    kind: "placeholder",
    text: `Image unavailable; see evidence ${evidenceId}`,
    ...(reason ? { reason } : {}),
  };
}

/** Starts upload work without making the Story reporting path await Notion. */
export class NotionMediaPipeline {
  constructor(private readonly port: NotionMediaPort) {}

  enqueue(request: MediaRequest): QueuedMedia {
    return {
      placeholder: unavailable(request.evidenceId),
      completion: this.#process(request),
    };
  }

  async #process(request: MediaRequest): Promise<MediaResult> {
    try {
      const details = await stat(request.path);
      if (!details.isFile()) throw new Error("evidence path is not a regular file");
      if (details.size > MAX_NOTION_UPLOAD_BYTES) {
        throw new Error(`file exceeds the ${MAX_NOTION_UPLOAD_BYTES} byte direct-upload limit`);
      }
      const uploaded = await this.port.upload({
        path: request.path,
        size: details.size,
        contentType: contentType(request.path),
      });
      await this.port.attach(request.targetBlockId, uploaded.uploadId, request.caption);
      return { kind: "image", uploadId: uploaded.uploadId };
    } catch (cause) {
      const safe = redactForExport({ message: (cause as Error).message }).message;
      return unavailable(request.evidenceId, safe);
    }
  }
}
