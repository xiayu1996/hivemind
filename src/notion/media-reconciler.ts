import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { Client } from "@libsql/client";
import { z } from "zod";
import { isWithinRoot } from "../guard/danger-rules.js";
import { NotionMediaPipeline, type MediaResult } from "./media.js";

const screenshotsSchema = z.array(z.object({
  scenarioId: z.string().min(1),
  path: z.string().min(1),
}).strict());

export interface NotionMediaReconcileResult {
  queued: number;
  skipped: number;
}

export interface NotionMediaReconcilerOptions {
  now?: () => number;
  onError?: (error: unknown) => void;
}

function evidenceId(cardId: string, round: number, scenarioId: string, path: string): string {
  return createHash("sha256").update(JSON.stringify([cardId, round, scenarioId, path])).digest("hex");
}

/** Durably discovers verified screenshots and starts non-blocking Notion uploads. */
export class NotionMediaReconciler {
  readonly #inFlight = new Map<string, Promise<void>>();
  readonly #now: () => number;
  readonly #onError: (error: unknown) => void;

  constructor(
    private readonly client: Client,
    private readonly pipeline: NotionMediaPipeline,
    options: NotionMediaReconcilerOptions = {},
  ) {
    this.#now = options.now ?? Date.now;
    this.#onError = options.onError ?? ((error) => console.error("Notion media delivery failed", error));
  }

  async reconcile(cardId?: string): Promise<NotionMediaReconcileResult> {
    const rows = (await this.client.execute({
      sql: `SELECT vr.card_id, vr.round, vr.evidence_dir, vr.screenshots, nvr.toggle_block_id
            FROM verify_records vr
            JOIN notion_verification_rounds nvr
              ON nvr.story_id = vr.card_id AND nvr.round = vr.round
            WHERE vr.evidence_dir IS NOT NULL
              AND vr.screenshots <> '[]'
              ${cardId ? "AND vr.card_id = ?" : ""}
            ORDER BY vr.card_id, vr.round`,
      args: cardId ? [cardId] : [],
    })).rows;
    let queued = 0;
    let skipped = 0;

    for (const row of rows) {
      const currentCardId = String(row.card_id);
      const round = Number(row.round);
      const root = resolve(String(row.evidence_dir));
      const targetBlockId = String(row.toggle_block_id);
      const screenshots = screenshotsSchema.parse(JSON.parse(String(row.screenshots)));
      for (const screenshot of screenshots) {
        const localPath = resolve(root, screenshot.path);
        if (!isWithinRoot(localPath, root)) {
          throw new Error(`verified screenshot escapes its evidence directory: ${screenshot.path}`);
        }
        const id = evidenceId(currentCardId, round, screenshot.scenarioId, screenshot.path);
        const time = this.#now();
        await this.client.execute({
          sql: `INSERT INTO notion_media_delivery
                  (evidence_id, card_id, round, scenario_id, local_path, target_block_id,
                   status, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
                ON CONFLICT(evidence_id) DO NOTHING`,
          args: [id, currentCardId, round, screenshot.scenarioId, localPath, targetBlockId, time, time],
        });
        const delivery = (await this.client.execute({
          sql: "SELECT status FROM notion_media_delivery WHERE evidence_id = ?",
          args: [id],
        })).rows[0];
        if (delivery?.status !== "pending" || this.#inFlight.has(id)) {
          skipped++;
          continue;
        }
        this.#start(id, {
          evidenceId: id,
          path: localPath,
          targetBlockId,
          caption: `${screenshot.scenarioId} evidence, round ${round}`,
        });
        queued++;
      }
    }
    return { queued, skipped };
  }

  async waitForIdle(): Promise<void> {
    while (this.#inFlight.size > 0) await Promise.all(this.#inFlight.values());
  }

  #start(
    id: string,
    request: { evidenceId: string; path: string; targetBlockId: string; caption: string },
  ): void {
    const queued = this.pipeline.enqueue(request);
    const work = queued.completion
      .then((result) => this.#remember(id, result))
      .catch(this.#onError)
      .finally(() => { this.#inFlight.delete(id); });
    this.#inFlight.set(id, work);
  }

  async #remember(id: string, result: MediaResult): Promise<void> {
    const time = this.#now();
    if (result.kind === "image") {
      await this.client.execute({
        sql: `UPDATE notion_media_delivery
              SET status = 'uploaded', upload_id = ?, failure = NULL, updated_at = ?
              WHERE evidence_id = ? AND status = 'pending'`,
        args: [result.uploadId, time, id],
      });
      return;
    }
    if (!result.attached) {
      this.#onError(new Error(result.reason ?? "Notion media placeholder was not attached"));
      return;
    }
    await this.client.execute({
      sql: `UPDATE notion_media_delivery
            SET status = 'placeholder', upload_id = NULL, failure = ?, updated_at = ?
            WHERE evidence_id = ? AND status = 'pending'`,
      args: [result.reason ?? result.text, time, id],
    });
  }
}
