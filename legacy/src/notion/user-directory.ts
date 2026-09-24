import type { Client } from "@libsql/client";
import { z } from "zod";
import type { NotionGateway } from "./gateway.js";

const userSchema = z.object({
  id: z.string().min(1),
  name: z.string().nullable().optional(),
  person: z.object({ email: z.string() }).partial().optional(),
  bot: z.object({ owner: z.unknown() }).partial().optional(),
}).passthrough();

export interface UserDirectory {
  /** Never throws: a name is presentation, and losing it must not cost a comment. */
  displayName(userId: string): Promise<string>;
}

/**
 * Puts a person's name on everything they wrote.
 *
 * Notion identifies comment authors by id only, and an id is what a person
 * ends up reading beside their own words on their own requirement page. Names
 * are cached in the central database because the alternative is a lookup per
 * ingested comment, and because a cached name still reads correctly when the
 * lookup fails.
 */
export class NotionUserDirectory implements UserDirectory {
  readonly #memory = new Map<string, string>();

  constructor(
    private readonly client: Client,
    private readonly gateway: NotionGateway,
    private readonly now: () => number = Date.now,
  ) {}

  async displayName(userId: string): Promise<string> {
    const remembered = this.#memory.get(userId);
    if (remembered) return remembered;

    const stored = (await this.client.execute({
      sql: "SELECT display_name FROM notion_users WHERE user_id = ?",
      args: [userId],
    })).rows[0];
    if (stored) {
      const name = String(stored.display_name);
      this.#memory.set(userId, name);
      return name;
    }

    const name = await this.fetch(userId);
    // The id is a usable last resort, but it is never cached as if it were a
    // name: the next pass should get another chance at the real one.
    if (name === userId) return userId;
    this.#memory.set(userId, name);
    await this.client.execute({
      sql: `INSERT INTO notion_users (user_id, display_name, fetched_at) VALUES (?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET display_name = excluded.display_name, fetched_at = excluded.fetched_at`,
      args: [userId, name, this.now()],
    });
    return name;
  }

  private async fetch(userId: string): Promise<string> {
    try {
      const response = await this.gateway.request({
        method: "GET",
        path: `/v1/users/${encodeURIComponent(userId)}`,
        priority: "projection",
      });
      const user = userSchema.safeParse(response.data);
      const name = user.success ? user.data.name?.trim() : undefined;
      return name ? name : userId;
    } catch {
      // A workspace can deny reading its user list, and a person's name is
      // never worth failing an ingest over.
      return userId;
    }
  }
}
