import { describe, expect, it } from "vitest";
import { entrypointFiles, entrypointsTouched, renderEntrypointsTouched } from "./app-entrypoint.js";

const CONSOLE = ["npx", "tsx", "scripts/serve-console.ts", "--port", "{port}"];

describe("the file a start command runs", () => {
  it("picks the repository path out of the argv", () => {
    expect(entrypointFiles(CONSOLE)).toEqual(["scripts/serve-console.ts"]);
  });

  it("accuses nothing when the command names no file of its own", () => {
    expect(entrypointFiles(["npm", "run", "dev"])).toEqual([]);
  });

  it("leaves paths outside the repository alone, which no round could have written", () => {
    expect(entrypointFiles(["node", "/usr/local/bin/serve.js", "../elsewhere/app.ts"])).toEqual([]);
  });
});

describe("an application lane the round rewrote", () => {
  it("names the entry point a round edited under itself", () => {
    expect(entrypointsTouched(CONSOLE, ["src/console/server.ts", "scripts/serve-console.ts"]))
      .toEqual(["scripts/serve-console.ts"]);
  });

  it("says nothing about a round that only changed what the entry point loads", () => {
    expect(entrypointsTouched(CONSOLE, ["src/console/server.ts", "src/console/role-configuration.ts"]))
      .toEqual([]);
  });

  it("tells the session where the page belongs instead, in the words it was asked in", () => {
    const rendered = renderEntrypointsTouched(["scripts/serve-console.ts"]);

    expect(rendered).toContain("- scripts/serve-console.ts");
    expect(rendered).toContain("路由装配");
  });
});
