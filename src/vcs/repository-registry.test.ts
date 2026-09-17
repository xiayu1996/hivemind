import { createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../persistence/migrate.js";
import { RepositoryRegistry } from "./repository-registry.js";

const input = (remoteUrl = "https://github.com/acme/widget.git") => ({
  remoteUrl, defaultBranch: "main", registeredBy: "installer",
});

describe("RepositoryRegistry", () => {
  let client: ReturnType<typeof createClient>;
  let registry: RepositoryRegistry;

  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    await migrate(client);
    registry = new RepositoryRegistry(client, () => 1_000);
  });

  afterEach(() => client.close());

  it("registers a repository from its clone URL alone", async () => {
    await expect(registry.register(input())).resolves.toEqual({
      created: true,
      repository: {
        slug: "acme/widget",
        remoteUrl: "https://github.com/acme/widget.git",
        defaultBranch: "main",
        registeredBy: "installer",
        registeredAt: 1_000,
      },
    });
    await expect(registry.slugs()).resolves.toEqual(["acme/widget"]);
  });

  it("is idempotent, because the installer runs it on every upgrade", async () => {
    await registry.register(input());
    await expect(registry.register(input())).resolves.toMatchObject({ created: false });
    await expect(registry.list()).resolves.toHaveLength(1);
  });

  it("refuses to repoint a slug that cards already name", async () => {
    await registry.register(input());
    await expect(registry.register(input("git@github.com:acme/widget.git")))
      .rejects.toThrow(/already registered/);
  });

  it("refuses a second repository that would share the checkout directory", async () => {
    await registry.register(input());
    await expect(registry.register(input("https://github.com/other/widget.git")))
      .rejects.toThrow(/occupies the checkout directory/);
  });

  it("keeps a malformed slug out of the table even when nothing in code asks", async () => {
    // The slug is a primary key every other table joins on; the constraint sits
    // in the database so an application bug cannot get around it.
    for (const slug of ["widget", "a/b/c", "acme/wid get", "/widget", "acme/"]) {
      await expect(client.execute({
        sql: `INSERT INTO repositories (slug, remote_url, default_branch, checkout_key, registered_by, registered_at)
              VALUES (?, 'https://example.invalid/x.git', 'main', 'widget', 'test', 1)`,
        args: [slug],
      })).rejects.toThrow();
    }
  });
});
