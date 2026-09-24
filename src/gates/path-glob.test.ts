import { describe, expect, it } from "vitest";
import { matchesAnyGlob, matchesGlob } from "./path-glob.ts";

describe("single-segment wildcards", () => {
  it("keeps * inside one directory", () => {
    expect(matchesGlob("src/a.ts", "src/*.ts")).toBe(true);
    expect(matchesGlob("src/x/a.ts", "src/*.ts")).toBe(false);
  });

  it("reads ? as exactly one character that is not a separator", () => {
    expect(matchesGlob("src/a.ts", "src/?.ts")).toBe(true);
    expect(matchesGlob("src/ab.ts", "src/?.ts")).toBe(false);
    expect(matchesGlob("src//.ts", "src/?.ts")).toBe(false);
  });

  it("matches the whole path, not a part of it", () => {
    expect(matchesGlob("lib/src/a.ts", "src/*.ts")).toBe(false);
    expect(matchesGlob("src/a.tsx", "src/*.ts")).toBe(false);
  });

  it("treats every other character literally", () => {
    expect(matchesGlob("src/(a)+[b]{c}$^|.ts", "src/(a)+[b]{c}$^|.ts")).toBe(true);
    expect(matchesGlob("src/abts", "src/a.ts")).toBe(false);
    expect(matchesGlob("src\\a.ts", "src\\a.ts")).toBe(true);
  });
});

describe("globstar", () => {
  it("covers a file at the root when it leads the pattern", () => {
    // A fence written as **/*.test.ts once missed exactly this file.
    for (const path of ["a.test.ts", "src/a.test.ts", "src/x/y/a.test.ts"]) {
      expect(matchesGlob(path, "**/*.test.ts")).toBe(true);
    }
    expect(matchesGlob("src/a.ts", "**/*.test.ts")).toBe(false);
  });

  it("covers zero or more directories in the middle", () => {
    for (const path of ["src/index.ts", "src/a/index.ts", "src/a/b/index.ts"]) {
      expect(matchesGlob(path, "src/**/index.ts")).toBe(true);
    }
    expect(matchesGlob("lib/index.ts", "src/**/index.ts")).toBe(false);
    expect(matchesGlob("srcx/index.ts", "src/**/index.ts")).toBe(false);
  });

  it("covers a directory and everything under it when it ends the pattern", () => {
    for (const path of ["docs/prototype", "docs/prototype/tokens.json", "docs/prototype/a/b.html"]) {
      expect(matchesGlob(path, "docs/prototype/**")).toBe(true);
    }
    expect(matchesGlob("docs/prototypes/x", "docs/prototype/**")).toBe(false);
    expect(matchesGlob("docs/prototype-old/x", "docs/prototype/**")).toBe(false);
  });

  it("matches every path on its own, and repeated globstars mean one", () => {
    expect(matchesGlob("a/b/c.ts", "**")).toBe(true);
    expect(matchesGlob("a.ts", "**/**")).toBe(true);
    expect(matchesGlob("src/a.ts", "src/**/**/a.ts")).toBe(true);
  });

  it("crosses directories when it sits inside a segment", () => {
    expect(matchesGlob("src/a/b/c.ts", "src**.ts")).toBe(true);
  });

  it("does not stop at a newline in a file name", () => {
    expect(matchesGlob(".hivemind/a\nb", ".hivemind/**")).toBe(true);
  });
});

describe("the test layouts a repository may use", () => {
  const testPaths = ["**/*.test.*", "test/**", "tests/**"];

  it("recognises test files wherever they live", () => {
    for (const path of ["src/console/data.test.ts", "test/price.test.ts", "tests/console/listing.py", "price.test.ts"]) {
      expect(matchesAnyGlob(path, testPaths)).toBe(true);
    }
    expect(matchesAnyGlob("src/console/data.ts", testPaths)).toBe(false);
  });

  it("collects a test directly under the include root", () => {
    expect(matchesGlob("src/a.test.ts", "src/**/*.test.ts")).toBe(true);
    expect(matchesGlob("src/gates/path-glob.test.ts", "src/**/*.test.ts")).toBe(true);
  });
});

describe("options", () => {
  it("matches case-sensitively unless asked not to", () => {
    expect(matchesGlob(".HIVEMIND/plan.yaml", ".hivemind/**")).toBe(false);
    expect(matchesGlob(".HIVEMIND/plan.yaml", ".hivemind/**", { ignoreCase: true })).toBe(true);
    expect(matchesAnyGlob("SRC/A.TEST.TS", ["**/*.test.ts"], { ignoreCase: true })).toBe(true);
  });

  it("matches nothing against an empty pattern list", () => {
    expect(matchesAnyGlob("src/a.ts", [])).toBe(false);
  });
});
