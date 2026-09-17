import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { capturePrototypePages, pageSlug } from "./prototype-screenshots.js";

async function outputDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "hivemind-shots-"));
}

describe("capturePrototypePages", () => {
  it("photographs every page in every view, off the files and with no server", async () => {
    const argvs: string[][] = [];
    const result = await capturePrototypePages({
      root: "/repo/docs/prototype",
      pages: ["pages/card.html", "pages/board.html"],
      outputDir: await outputDir(),
      run: async (argv) => { argvs.push([...argv]); return { ok: true, output: "" }; },
    });

    expect(result.failures).toEqual([]);
    // Sorted by page so the evidence directory comes out the same on every host.
    expect(result.shots.map((shot) => `${shot.page} ${shot.view}`)).toEqual([
      "pages/board.html desktop-light",
      "pages/board.html desktop-dark",
      "pages/board.html mobile-light",
      "pages/board.html mobile-dark",
      "pages/card.html desktop-light",
      "pages/card.html desktop-dark",
      "pages/card.html mobile-light",
      "pages/card.html mobile-dark",
    ]);
    expect(argvs[0]).toContain("file:///repo/docs/prototype/pages/board.html");
    expect(argvs[0]!.join(" ")).toContain("--viewport-size 1440, 900");
    expect(argvs[2]!.join(" ")).toContain("--color-scheme light");
    expect(result.shots[0]!.path).toMatch(/board-desktop-light\.png$/);
  });

  it("reports a page that will not render instead of failing the requirement", async () => {
    const result = await capturePrototypePages({
      root: "/repo/docs/prototype",
      pages: ["pages/board.html"],
      outputDir: await outputDir(),
      views: [{ name: "desktop-light", width: 1440, height: 900, colorScheme: "light" }],
      run: async () => ({ ok: false, output: "page.goto: net::ERR_FILE_NOT_FOUND" }),
    });

    expect(result.shots).toEqual([]);
    expect(result.failures).toEqual(["pages/board.html at desktop-light: page.goto: net::ERR_FILE_NOT_FOUND"]);
  });

  it("creates the evidence directory it was pointed at", async () => {
    const directory = join(await outputDir(), "prototype");
    await capturePrototypePages({
      root: "/repo/docs/prototype",
      pages: [],
      outputDir: directory,
      run: async () => ({ ok: true, output: "" }),
    });
    await expect(readdir(directory)).resolves.toEqual([]);
  });
});

describe("pageSlug", () => {
  it("names a shot after the page a person is looking at", () => {
    expect(pageSlug("pages/board.html")).toBe("board");
    expect(pageSlug("index.html")).toBe("index");
  });
});
