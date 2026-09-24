import { describe, expect, it } from "vitest";
import { mechanicalFindings } from "./usability-mechanical.js";

function page(style: string, body = "<button>新建</button>"): { file: string; html: string } {
  return { file: "pages/board.html", html: `<html><head><style>${style}</style></head><body>${body}</body></html>` };
}

function items(input: { file: string; html: string; violations?: { id: string; impact: string; help: string; nodes: string[] }[] }): string[] {
  return mechanicalFindings(input).map((finding) => finding.item);
}

describe("mechanicalFindings", () => {
  it("refuses motion nothing can turn off, and says nothing about a page that turns it off", () => {
    expect(items(page("button { transition: all 200ms; }"))).toEqual(["M1"]);
    expect(items(page(
      "button { transition: all 200ms; } @media (prefers-reduced-motion: reduce) { button { transition: none; } }",
    ))).toEqual([]);
  });

  it("says nothing about the reduced-motion item on a page with no motion at all", () => {
    expect(items(page("button { color: red; }"))).toEqual([]);
  });

  it("refuses a tap target written smaller than a finger, and allows a big one", () => {
    expect(items(page("a.icon { width: 20px; height: 20px; }"))).toEqual(["M2"]);
    expect(items(page("a.icon { width: 48px; height: 48px; }"))).toEqual([]);
  });

  it("leaves a small box on something nobody taps alone", () => {
    expect(items(page(".divider { height: 1px; }"))).toEqual([]);
  });

  it("refuses a hidden focus ring with no replacement, and allows one that draws its own", () => {
    expect(items(page("button:focus { outline: none; }"))).toEqual(["M3"]);
    expect(items(page(
      "button:focus { outline: none; } button:focus-visible { outline: 2px solid #fff; }",
    ))).toEqual([]);
  });

  it("refuses a click the tab key never reaches, and allows one on a button", () => {
    expect(items(page("button { color: red; }", '<div onclick="open()">打开</div>'))).toEqual(["M4"]);
    expect(items(page("button { color: red; }", '<div tabindex="0" role="button" onclick="open()">打开</div>'))).toEqual([]);
    expect(items(page("button { color: red; }", '<button onclick="open()">打开</button>'))).toEqual([]);
  });

  it("takes the two axe rules that are checklist items, and ignores the ones that are not", () => {
    const found = mechanicalFindings({
      ...page("button { color: red; }"),
      violations: [
        { id: "target-size", impact: "serious", help: "Touch targets must be large enough", nodes: ["a.icon"] },
        { id: "nested-interactive", impact: "serious", help: "Interactive controls must not be nested", nodes: ["button"] },
        { id: "color-contrast", impact: "serious", help: "Contrast", nodes: ["p"] },
      ],
    });

    expect(found.map((finding) => finding.item)).toEqual(["M2", "M4"]);
  });
});
