import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseSecretsFile, upsertSecretFile } from "./secrets-file.js";

describe("secrets file parser", () => {
  it("parses quoted values without exposing or transforming their contents", () => {
    expect(parseSecretsFile("# local only\nTOKEN='value=with=separators'\nEMPTY=\n")).toEqual(new Map([
      ["TOKEN", "value=with=separators"],
      ["EMPTY", ""],
    ]));
  });

  it("rejects malformed assignments", () => {
    expect(() => parseSecretsFile("MISSING_SEPARATOR")).toThrow(/invalid secrets.env assignment/);
  });

  it("atomically replaces one key while preserving unrelated lines", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hm-secrets-"));
    const path = join(directory, "secrets.env");
    await writeFile(path, "# keep\nTOKEN=old\nOTHER=value\n", "utf8");
    await upsertSecretFile("TOKEN", "new", path);
    expect(await readFile(path, "utf8")).toBe("# keep\nTOKEN=new\nOTHER=value\n");
  });
});
