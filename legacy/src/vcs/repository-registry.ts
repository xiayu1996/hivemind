import type { Client } from "@libsql/client";
import { checkoutKey, redactRemoteUrl, repositorySlugFromUrl } from "./repository-checkout.js";

export interface RegisteredRepository {
  slug: string;
  remoteUrl: string;
  defaultBranch: string;
  registeredBy: string;
  registeredAt: number;
}

export interface RegisterRepositoryInput {
  remoteUrl: string;
  defaultBranch: string;
  registeredBy: string;
  /** Overrides the slug derived from the URL, for a remote whose path does not read as owner/name. */
  slug?: string;
}

/**
 * The set of repositories this installation works in.
 *
 * Registration is idempotent because it runs from the installer: re-running it
 * with the same URL has to be a no-op, while the same slug pointing somewhere
 * else has to be refused loudly — cards, config scopes and review requests are
 * all keyed by the slug, so silently repointing it would move work between
 * repositories.
 */
export class RepositoryRegistry {
  constructor(private readonly client: Client, private readonly now: () => number = Date.now) {}

  async register(input: RegisterRepositoryInput): Promise<{ repository: RegisteredRepository; created: boolean }> {
    const slug = input.slug ?? repositorySlugFromUrl(input.remoteUrl);
    const existing = await this.get(slug);
    if (existing) {
      if (existing.remoteUrl !== input.remoteUrl) {
        throw new Error(
          `${slug} is already registered as ${redactRemoteUrl(existing.remoteUrl)}; ` +
          "unregister it before pointing the slug somewhere else",
        );
      }
      return { repository: existing, created: false };
    }
    const key = checkoutKey(slug);
    const clash = (await this.client.execute({
      sql: "SELECT slug FROM repositories WHERE checkout_key = ?",
      args: [key],
    })).rows[0];
    if (clash) {
      throw new Error(
        `${slug} cannot be registered: ${String(clash.slug)} already occupies the checkout directory "${key}"`,
      );
    }
    const repository: RegisteredRepository = {
      slug,
      remoteUrl: input.remoteUrl,
      defaultBranch: input.defaultBranch,
      registeredBy: input.registeredBy,
      registeredAt: this.now(),
    };
    await this.client.execute({
      sql: `INSERT INTO repositories (slug, remote_url, default_branch, checkout_key, registered_by, registered_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [slug, repository.remoteUrl, repository.defaultBranch, key, repository.registeredBy, repository.registeredAt],
    });
    return { repository, created: true };
  }

  async get(slug: string): Promise<RegisteredRepository | null> {
    const row = (await this.client.execute({
      sql: "SELECT slug, remote_url, default_branch, registered_by, registered_at FROM repositories WHERE slug = ?",
      args: [slug],
    })).rows[0];
    return row ? toRepository(row) : null;
  }

  async list(): Promise<RegisteredRepository[]> {
    const result = await this.client.execute(
      "SELECT slug, remote_url, default_branch, registered_by, registered_at FROM repositories ORDER BY slug",
    );
    return result.rows.map(toRepository);
  }

  async slugs(): Promise<string[]> {
    return (await this.list()).map((repository) => repository.slug);
  }
}

function toRepository(row: Record<string, unknown>): RegisteredRepository {
  return {
    slug: String(row.slug),
    remoteUrl: String(row.remote_url),
    defaultBranch: String(row.default_branch),
    registeredBy: String(row.registered_by),
    registeredAt: Number(row.registered_at),
  };
}
