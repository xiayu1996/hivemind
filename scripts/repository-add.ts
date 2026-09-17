import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@notionhq/client";
import { loadSecretsFile } from "../src/config/secrets-file.js";
import { seedRepositoryOptions } from "../src/notion/bootstrap.js";
import { openDb } from "../src/persistence/client.js";
import { migrate } from "../src/persistence/migrate.js";
import {
  CheckoutError,
  ensureCheckout,
  redactRemoteUrl,
  remoteDefaultBranch,
  repositorySlugFromUrl,
} from "../src/vcs/repository-checkout.js";
import { RepositoryRegistry } from "../src/vcs/repository-registry.js";

/**
 * Registers a repository hivemind may work in, and brings this machine's
 * checkout of it into existence.
 *
 *   npx tsx scripts/repository-add.ts https://github.com/acme/widget.git
 *   npx tsx scripts/repository-add.ts git@github.com:acme/widget.git --default-branch trunk
 *
 * A clone URL and whatever credentials the host already has are the whole
 * input: nothing about the repository is hardcoded anywhere, and the checkout
 * path is derived from the slug rather than given.
 */
const ROOT = fileURLToPath(new URL("..", import.meta.url));

function optional(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function seedBoards(slugs: readonly string[]): Promise<void> {
  const stored = await loadSecretsFile();
  const token = process.env.NOTION_TOKEN ?? stored.get("NOTION_TOKEN");
  const boards = [
    process.env.HIVEMIND_NOTION_REQUIREMENTS_DATA_SOURCE_ID ?? stored.get("HIVEMIND_NOTION_REQUIREMENTS_DATA_SOURCE_ID"),
    process.env.HIVEMIND_NOTION_STORIES_DATA_SOURCE_ID ?? stored.get("HIVEMIND_NOTION_STORIES_DATA_SOURCE_ID"),
  ].filter((id): id is string => Boolean(id));
  // Registration has to work before Notion is set up: the board is where a
  // person picks the repository, not where the registry lives.
  if (!token || boards.length === 0) return;
  const client = new Client({ auth: token, notionVersion: "2025-09-03" });
  for (const board of boards) {
    const added = await seedRepositoryOptions(client, board, slugs);
    if (added.length > 0) console.log(`added ${added.join(", ")} to a board's repository column`);
  }
}

async function main(): Promise<void> {
  const url = process.argv[2];
  if (!url || url.startsWith("--")) {
    console.error("usage: npx tsx scripts/repository-add.ts <git-url> [--default-branch main] [--slug owner/name] [--work-root path]");
    process.exit(2);
  }
  const workRoot = resolve(optional("--work-root") ?? join(ROOT, "data", "work"));
  const slug = optional("--slug") ?? repositorySlugFromUrl(url);
  // Asking the remote for its default branch is also the proof that this host
  // can reach it, which is why it happens before anything is written down.
  const defaultBranch = optional("--default-branch") ?? await remoteDefaultBranch(url);

  const handle = openDb(process.env.HIVEMIND_DB_URL ?? "file:data/hivemind.db");
  try {
    await migrate(handle.client);
    const registry = new RepositoryRegistry(handle.client);
    const { repository, created } = await registry.register({
      remoteUrl: url,
      defaultBranch,
      registeredBy: `${process.env.USER ?? "operator"}@${hostname()}`,
      ...(optional("--slug") ? { slug } : {}),
    });
    const checkout = await ensureCheckout({
      url: repository.remoteUrl,
      slug: repository.slug,
      defaultBranch: repository.defaultBranch,
      workRoot,
    }, { refresh: true });
    console.log(`${created ? "registered" : "already registered"} ${repository.slug} (${repository.defaultBranch})`
      + ` -> ${checkout.path} [${checkout.action}]`);
    await seedBoards(await registry.slugs());
  } finally {
    handle.close();
  }
}

main().catch((error: unknown) => {
  if (error instanceof CheckoutError) {
    const advice = {
      auth: "the host has no credential for this remote: run `gh auth login` (and `gh auth setup-git`) or add an ssh key",
      not_found: "check the URL, and that the account this host authenticates as can see the repository",
      network: "the host could not reach the remote",
      unknown: "",
    }[error.kind];
    console.error(`FAILED: ${error.message}${advice ? `\n${advice}` : ""}`);
    process.exit(1);
  }
  console.error(`FAILED: ${redactRemoteUrl((error as Error).message)}`);
  process.exit(1);
});
