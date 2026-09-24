import { describe, expect, it } from "vitest";
import {
  introducedExports,
  isTestFile,
  renderUnwiredExports,
  unwiredExports,
} from "./unwired-exports.js";

const DIFF = [
  "diff --git a/src/console/overview.ts b/src/console/overview.ts",
  "--- a/src/console/overview.ts",
  "+++ b/src/console/overview.ts",
  "@@ -0,0 +1,4 @@",
  "+export function registerOverviewRoutes(app) {",
  "+  return app;",
  "+}",
  "+const internal = 1;",
  "diff --git a/src/console/overview.test.ts b/src/console/overview.test.ts",
  "--- a/src/console/overview.test.ts",
  "+++ b/src/console/overview.test.ts",
  "@@ -0,0 +1,2 @@",
  "+export const fixtureApp = {};",
].join("\n");

describe("what a round introduced", () => {
  it("reads the exports out of the diff, not out of the tree", () => {
    expect(introducedExports(DIFF)).toEqual([
      { name: "registerOverviewRoutes", file: "src/console/overview.ts" },
    ]);
  });

  it("leaves the tests' own exports out, since tests mention what they test", () => {
    expect(introducedExports(DIFF).map((entry) => entry.name)).not.toContain("fixtureApp");
  });

  it("accuses only functions and classes, never a type that earns its keep at home", () => {
    const typeDiff = [
      "--- a/src/console/overview.ts",
      "+++ b/src/console/overview.ts",
      "+export interface OverviewRow { id: string }",
      "+export type OverviewKind = \"task\" | \"requirement\";",
      "+export const OVERVIEW_PATH = \"/overview\";",
    ].join("\n");

    expect(introducedExports(typeDiff)).toEqual([]);
  });

  it("knows a test path in the shapes this repository writes them", () => {
    expect(isTestFile("src/console/overview.test.ts")).toBe(true);
    expect(isTestFile("tests/console/overview.ts")).toBe(true);
    expect(isTestFile("src/console/overview.ts")).toBe(false);
  });
});

describe("an export the product never calls", () => {
  const introduced = [{ name: "registerOverviewRoutes", file: "src/console/overview.ts" }];

  it("names the one nothing outside its own file and the tests mentions", () => {
    const mentions = new Map([["registerOverviewRoutes", ["src/console/overview.ts", "src/console/overview.test.ts"]]]);

    expect(unwiredExports(introduced, mentions)).toEqual(introduced);
  });

  it("says nothing once the entry point calls it", () => {
    const mentions = new Map([["registerOverviewRoutes", ["src/console/overview.ts", "src/console/server.ts"]]]);

    expect(unwiredExports(introduced, mentions)).toEqual([]);
  });

  it("tells the session what a vertical slice owes, with the case that taught it", () => {
    const rendered = renderUnwiredExports(introduced);

    expect(rendered).toContain("- registerOverviewRoutes（src/console/overview.ts）");
    expect(rendered).toContain("竖切");
  });
});
