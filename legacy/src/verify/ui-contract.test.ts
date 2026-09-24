import { describe, expect, it } from "vitest";
import type { DesignToken } from "../pipeline/interface-contract.js";
import {
  allowedValues,
  contractEnforcement,
  contractViolations,
  describeContractViolations,
  normalizeColor,
  normalizeLength,
  type PageStyles,
} from "./ui-contract.js";

const tokens: DesignToken[] = [
  { name: "color.surface", type: "color", value: "#111827" },
  { name: "color.brand", type: "color", value: "rgb(37, 99, 235)" },
  { name: "color.accent", type: "color", value: "{color.brand}" },
  { name: "size.text.body", type: "dimension", value: "1rem" },
  { name: "size.space.tight", type: "dimension", value: "8px" },
];

function styles(usages: PageStyles["usages"], rootFontSizePx = 16): PageStyles {
  return { rootFontSizePx, usages };
}

describe("normalizeColor", () => {
  it("reads the three ways the same colour gets written", () => {
    expect(normalizeColor("#111827")).toBe("rgb(17, 24, 39, 1)");
    expect(normalizeColor("rgb(17, 24, 39)")).toBe("rgb(17, 24, 39, 1)");
    expect(normalizeColor("RGB( 17 , 24 , 39 )")).toBe("rgb(17, 24, 39, 1)");
  });

  it("expands a short hex and keeps its alpha", () => {
    expect(normalizeColor("#abc")).toBe("rgb(170, 187, 204, 1)");
    expect(normalizeColor("#11182780")).toBe("rgb(17, 24, 39, 0.502)");
  });

  it("treats transparent as the absence of a colour, not as a colour", () => {
    expect(normalizeColor("transparent")).toBe("rgb(0, 0, 0, 0)");
    expect(normalizeColor("rgba(0, 0, 0, 0)")).toBe("rgb(0, 0, 0, 0)");
  });

  it("returns nothing for a keyword nobody chose", () => {
    expect(normalizeColor("currentcolor")).toBeNull();
    expect(normalizeColor("")).toBeNull();
  });
});

describe("normalizeLength", () => {
  it("resolves rem against the root size the page reported, not an assumed one", () => {
    expect(normalizeLength("1rem", 16)).toBe("16px");
    expect(normalizeLength("1rem", 20)).toBe("20px");
  });

  it("reads zero however it was written", () => {
    expect(normalizeLength("0", 16)).toBe("0px");
    expect(normalizeLength("0px", 16)).toBe("0px");
  });

  it("returns nothing for a value the browser reports for an unset property", () => {
    expect(normalizeLength("auto", 16)).toBeNull();
    expect(normalizeLength("normal", 16)).toBeNull();
  });
});

describe("allowedValues", () => {
  it("follows an alias to the value it stands for", () => {
    expect(allowedValues(tokens, 16).colors).toContain("rgb(37, 99, 235, 1)");
  });

  it("resolves a size token in the page's own scale", () => {
    expect(allowedValues(tokens, 20).lengths).toContain("20px");
    expect(allowedValues(tokens, 20).lengths).not.toContain("16px");
  });

  it("contributes nothing for an alias that leads nowhere", () => {
    const dangling: DesignToken[] = [{ name: "color.x", type: "color", value: "{color.missing}" }];

    expect(allowedValues(dangling, 16).colors).toEqual(new Set(["rgb(0, 0, 0, 0)"]));
  });

  it("allows zero and full transparency without a token for them", () => {
    const allowed = allowedValues([], 16);

    expect(allowed.lengths).toContain("0px");
    expect(allowed.colors).toContain("rgb(0, 0, 0, 0)");
  });
});

describe("contractViolations", () => {
  const allowed = allowedValues(tokens, 16);

  it("accepts a page whose every value came from the table, however it is written", () => {
    const found = contractViolations("board.html", styles([
      { selector: "main", property: "background-color", value: "rgb(17, 24, 39)" },
      { selector: "main > h1", property: "font-size", value: "16px" },
      { selector: "main > .card", property: "padding-top", value: "8px" },
    ]), allowed);

    expect(found).toEqual([]);
  });

  it("refuses a colour nobody put in the table", () => {
    const found = contractViolations("board.html", styles([
      { selector: "main > .card", property: "background-color", value: "rgb(200, 200, 200)" },
    ]), allowed);

    expect(found).toEqual([{
      page: "board.html",
      selector: "main > .card",
      property: "background-color",
      value: "rgb(200, 200, 200)",
      expected: "color",
    }]);
  });

  it("reports one finding for one decision, not one per element that repeats it", () => {
    const found = contractViolations("board.html", styles([
      { selector: "main > .card:nth-of-type(1)", property: "background-color", value: "rgb(200, 200, 200)" },
      { selector: "main > .card:nth-of-type(2)", property: "background-color", value: "rgb(200, 200, 200)" },
      { selector: "main > .card:nth-of-type(3)", property: "background-color", value: "rgb(200, 200, 200)" },
    ]), allowed);

    expect(found).toHaveLength(1);
  });

  it("says nothing about properties the token table is not responsible for", () => {
    const found = contractViolations("board.html", styles([
      { selector: "main", property: "display", value: "grid" },
      { selector: "main", property: "z-index", value: "40" },
    ]), allowed);

    expect(found).toEqual([]);
  });

  it("says nothing about a value the browser reported for an unset property", () => {
    const found = contractViolations("board.html", styles([
      { selector: "main", property: "margin-left", value: "auto" },
      { selector: "main", property: "padding-top", value: "0px" },
    ]), allowed);

    expect(found).toEqual([]);
  });

  it("measures against the page's own root size, so a rem token still matches", () => {
    const found = contractViolations("board.html", styles([
      { selector: "main > h1", property: "font-size", value: "20px" },
    ], 20), allowedValues(tokens, 20));

    expect(found).toEqual([]);
  });
});

describe("describeContractViolations", () => {
  it("says which page, which element and which value, in the card's language", () => {
    expect(describeContractViolations([{
      page: "board.html",
      selector: "main > .card",
      property: "background-color",
      value: "rgb(200, 200, 200)",
      expected: "color",
    }])).toEqual([
      "board.html 的 main > .card 用了不在设计规范里的颜色：background-color 是 rgb(200, 200, 200)",
    ]);
  });
});

describe("contractEnforcement", () => {
  it("keeps every setting the registry offers", () => {
    expect(contractEnforcement("off")).toBe("off");
    expect(contractEnforcement("warn")).toBe("warn");
    expect(contractEnforcement("block")).toBe("block");
  });

  it("reads a setting it does not know as the one that neither hides nor stops", () => {
    expect(contractEnforcement("strict")).toBe("warn");
  });
});
