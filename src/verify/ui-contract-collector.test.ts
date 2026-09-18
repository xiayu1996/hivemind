import { describe, expect, it, vi } from "vitest";
import { CONTRACT_PROPERTIES } from "./ui-contract.js";
import { collectPageStyles, type StyleCollectorPort } from "./ui-contract-collector.js";

function port(pages: Record<string, { rootFontSizePx: number; usages: [] } | Error>): StyleCollectorPort {
  return {
    collect: vi.fn(async (url: string) => {
      const name = Object.keys(pages).find((page) => url.endsWith(page));
      const value = name ? pages[name] : undefined;
      if (value === undefined) throw new Error("no such page");
      if (value instanceof Error) throw value;
      return value;
    }),
  };
}

describe("collectPageStyles", () => {
  it("visits every page as a file URL, so a prototype needs no server", async () => {
    const collector = port({ "pages/board.html": { rootFontSizePx: 16, usages: [] } });

    await collectPageStyles({ root: "/repo/docs/prototype", pages: ["pages/board.html"], port: collector });

    expect(collector.collect).toHaveBeenCalledWith(
      expect.stringMatching(/^file:\/\/.*\/repo\/docs\/prototype\/pages\/board\.html$/),
      CONTRACT_PROPERTIES,
      expect.any(Number),
    );
  });

  it("reports a page that would not render instead of calling it clean", async () => {
    const collector = port({
      "pages/a.html": { rootFontSizePx: 16, usages: [] },
      "pages/b.html": new Error("net::ERR_FILE_NOT_FOUND"),
    });

    const result = await collectPageStyles({
      root: "/repo/docs/prototype",
      pages: ["pages/b.html", "pages/a.html"],
      port: collector,
    });

    expect([...result.styles.keys()]).toEqual(["pages/a.html"]);
    expect(result.failures).toEqual(["pages/b.html: net::ERR_FILE_NOT_FOUND"]);
  });

  it("visits the pages in a stable order whatever order they were listed in", async () => {
    const seen: string[] = [];
    const collector: StyleCollectorPort = {
      collect: async (url) => {
        seen.push(url.split("/").at(-1)!);
        return { rootFontSizePx: 16, usages: [] };
      },
    };

    await collectPageStyles({
      root: "/repo/docs/prototype",
      pages: ["pages/c.html", "pages/a.html", "pages/b.html"],
      port: collector,
    });

    expect(seen).toEqual(["a.html", "b.html", "c.html"]);
  });
});
