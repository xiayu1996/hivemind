import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("S-E3OVERVIEW-03-responsive", () => {
  it("uses a narrow-screen single column layout without a horizontal navigation overflow", async () => {
    const css = await readFile("console-ui/src/style.css", "utf8");
    expect(css).toContain("flex-wrap: wrap");
    expect(css).toMatch(/@media \(max-width: 600px\)[\s\S]*main \{ max-width: none; padding: 16px; \}/);
    expect(css).toMatch(/@media \(max-width: 600px\)[\s\S]*\.overview-item \{ flex-direction: column; \}/);
  });
});
