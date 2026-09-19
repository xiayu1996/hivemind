import { describe, expect, it, vi } from "vitest";
import { inspectPrototypePages, type PrototypeInspectorPort } from "./prototype-inspector.js";

function port(answer: (url: string) => { snapshot: string } | Error): PrototypeInspectorPort {
  return {
    inspect: vi.fn(async (url: string, want: { styles: boolean }) => {
      const value = answer(url);
      if (value instanceof Error) throw value;
      return { snapshot: value.snapshot, styles: want.styles ? { rootFontSizePx: 16, usages: [] } : null };
    }),
  };
}

describe("inspectPrototypePages", () => {
  it("opens each page plain and once per state, over file URLs so no server is needed", async () => {
    const collector = port((url) => ({ snapshot: url }));

    const evidence = await inspectPrototypePages({
      root: "/repo/docs/prototype",
      pages: ["pages/board.html"],
      port: collector,
    });

    expect(collector.inspect).toHaveBeenCalledTimes(5);
    expect(evidence[0]!.snapshot).toMatch(/^file:\/\/.*\/pages\/board\.html$/);
    expect(Object.keys(evidence[0]!.states)).toEqual(["empty", "loading", "error", "waiting"]);
    expect(evidence[0]!.states.error).toMatch(/\?state=error$/);
  });

  it("asks for computed styles only on the page itself, not once per state", async () => {
    const wanted: boolean[] = [];
    const collector: PrototypeInspectorPort = {
      inspect: async (_url, want) => {
        wanted.push(want.styles);
        return { snapshot: "- main", styles: null };
      },
    };

    await inspectPrototypePages({ root: "/repo", pages: ["pages/a.html"], port: collector });

    expect(wanted).toEqual([true, false, false, false, false]);
  });

  it("records a state that would not render as absent rather than losing the page", async () => {
    const collector = port((url) => url.includes("state=error") ? new Error("boom") : ({ snapshot: "- main" }));

    const evidence = await inspectPrototypePages({ root: "/repo", pages: ["pages/a.html"], port: collector });

    expect(evidence[0]!.snapshot).toBe("- main");
    expect(evidence[0]!.states.error).toBeUndefined();
    expect(evidence[0]!.states.empty).toBe("- main");
  });

  it("records a page that would not open at all without asking it four more times in vain", async () => {
    const collector = port(() => new Error("net::ERR_FILE_NOT_FOUND"));

    const evidence = await inspectPrototypePages({ root: "/repo", pages: ["pages/a.html"], port: collector });

    expect(evidence[0]).toEqual({
      file: "pages/a.html",
      snapshot: null,
      states: {},
      styles: null,
      violations: [],
    });
    expect(collector.inspect).toHaveBeenCalledTimes(1);
  });

  it("visits the pages in a stable order whatever order they were listed in", async () => {
    const seen: string[] = [];
    const collector: PrototypeInspectorPort = {
      inspect: async (url) => {
        seen.push(url);
        return { snapshot: "- main", styles: null };
      },
    };

    await inspectPrototypePages({
      root: "/repo",
      pages: ["pages/c.html", "pages/a.html"],
      port: collector,
    });

    expect(seen.filter((url) => !url.includes("?")).map((url) => url.split("/").at(-1))).toEqual([
      "a.html",
      "c.html",
    ]);
  });
});
