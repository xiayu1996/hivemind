import { readFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  installPiModelDeclarations,
  piModelDeclarationsPath,
  renderPiModelDeclarations,
  type DeclaringProfile,
} from "./pi-model-declarations.js";

const flash: DeclaringProfile = {
  envKey: "MIMO_API_KEY",
  declaration: {
    baseUrl: "https://api.example.com/v1",
    api: "openai-completions",
    models: [
      {
        id: "flash",
        name: "Flash",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 1_000_000,
        maxTokens: 65_536,
        thinkingLevelMap: { minimal: null, high: null },
        cost: { input: 0.14, output: 0.28, cacheRead: 0.0014, cacheWrite: 0 },
      },
    ],
  },
};

describe("renderPiModelDeclarations", () => {
  it("names the environment variable instead of carrying the key", () => {
    expect(renderPiModelDeclarations({ mimo: flash })).toContain('"apiKey": "$MIMO_API_KEY"');
  });

  it("leaves out providers pi already knows", () => {
    const rendered = renderPiModelDeclarations({ mimo: flash, "openai-codex": { authType: "oauth" } as DeclaringProfile });
    expect(Object.keys(JSON.parse(rendered).providers)).toEqual(["mimo"]);
  });

  it("renders the same bytes whatever order the providers arrive in", () => {
    const other = { ...flash, envKey: "OTHER_KEY" };
    expect(renderPiModelDeclarations({ a: flash, b: other })).toBe(
      renderPiModelDeclarations({ b: other, a: flash }),
    );
  });

  it("ends with a newline so an editor and a rewrite agree on the file", () => {
    expect(renderPiModelDeclarations({ mimo: flash }).endsWith("}\n")).toBe(true);
  });
});

describe("installPiModelDeclarations", () => {
  it("writes the file when it is missing and reports nothing to do the second time", async () => {
    const home = await mkdtemp(join(tmpdir(), "pi-models-"));
    const path = piModelDeclarationsPath(home);
    const contents = renderPiModelDeclarations({ mimo: flash });

    expect(await installPiModelDeclarations(contents, path)).toBe("written");
    expect(await readFile(path, "utf8")).toBe(contents);
    expect(await installPiModelDeclarations(contents, path)).toBe("unchanged");
  });

  it("replaces a declaration a previous configuration left behind", async () => {
    const home = await mkdtemp(join(tmpdir(), "pi-models-"));
    const path = piModelDeclarationsPath(home);
    await installPiModelDeclarations("{}\n", path);
    await writeFile(path, '{"providers":{"gone":{}}}\n');

    const contents = renderPiModelDeclarations({ mimo: flash });
    expect(await installPiModelDeclarations(contents, path)).toBe("written");
    expect(await readFile(path, "utf8")).toBe(contents);
  });
});
