import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  describePrototypePage,
  parseDesignTokens,
  readInterfaceContract,
  renderInterfaceContract,
} from "./interface-contract.js";

const TOKENS = JSON.stringify({
  color: {
    $type: "color",
    surface: { $value: "#FFFFFF" },
    brand: { primary: { $value: "#2F6FED" }, hover: { $value: "{color.brand.primary}" } },
  },
  space: { $type: "dimension", gutter: { $value: "16px" } },
  shadow: {
    raised: { $type: "shadow", $value: { color: "#0000001A", offsetX: "0", offsetY: "2px", blur: "8px" } },
  },
});

async function contractRoot(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hivemind-prototype-"));
  await mkdir(join(root, "pages"), { recursive: true });
  for (const [name, body] of Object.entries(files)) await writeFile(join(root, name), body);
  return root;
}

function page(title: string, purpose: string): string {
  return `<!doctype html><html><head><title>${title}</title>`
    + `<meta name="description" content="${purpose}"></head><body></body></html>`;
}

describe("parseDesignTokens", () => {
  it("flattens the groups and lets a token inherit the type its group declares", () => {
    const parsed = parseDesignTokens(TOKENS);
    expect("tokens" in parsed && parsed.tokens).toEqual([
      { name: "color.brand.hover", type: "color", value: "{color.brand.primary}" },
      { name: "color.brand.primary", type: "color", value: "#2F6FED" },
      { name: "color.surface", type: "color", value: "#FFFFFF" },
      // A composite keeps its parts: a phase building a shadow needs them.
      { name: "shadow.raised", type: "shadow", value: '{"color":"#0000001A","offsetX":"0","offsetY":"2px","blur":"8px"}' },
      { name: "space.gutter", type: "dimension", value: "16px" },
    ]);
  });

  it("refuses a token no group gave a type, instead of guessing one", () => {
    const parsed = parseDesignTokens(JSON.stringify({ radius: { small: { $value: "4px" } } }));
    expect("reasons" in parsed && parsed.reasons).toEqual([
      "token radius.small has no $type, and no group above it declares one",
    ]);
  });

  it("refuses a table with nothing in it and text that is not a table", () => {
    expect(parseDesignTokens("{}")).toMatchObject({ reasons: ["tokens.json declares no tokens"] });
    expect(parseDesignTokens("[]")).toMatchObject({ reasons: ["tokens.json must be an object of token groups"] });
    expect("reasons" in parseDesignTokens("not json") && true).toBe(true);
  });
});

describe("describePrototypePage", () => {
  it("takes the page's own words for its name and its purpose", () => {
    expect(describePrototypePage("pages/board.html", page("任务看板", "值班的人一眼看到哪些卡在等自己"))).toEqual({
      file: "pages/board.html",
      name: "任务看板",
      purpose: "值班的人一眼看到哪些卡在等自己",
    });
  });

  it("refuses a page that does not say what it is for", () => {
    const described = describePrototypePage("pages/board.html", "<html><head></head><body>x</body></html>");
    expect("reasons" in described && described.reasons).toEqual([
      "pages/board.html has no <title>, so the page has no name",
      'pages/board.html has no <meta name="description">, so nothing says what the page is for',
    ]);
  });
});

describe("readInterfaceContract", () => {
  it("reads the three pieces and sorts the pages by file name", async () => {
    const root = await contractRoot({
      "tokens.json": TOKENS,
      "components.md": "# 组件清单\n\n卡片：一张任务的摘要。",
      "pages/board.html": page("任务看板", "看到哪些卡在等自己"),
      "pages/card.html": page("任务详情", "看一张卡这一轮做了什么"),
    });

    const read = await readInterfaceContract(root);
    expect(read).toMatchObject({ kind: "present" });
    expect(read.kind === "present" && read.contract.pages).toEqual([
      { file: "pages/board.html", name: "任务看板", purpose: "看到哪些卡在等自己" },
      { file: "pages/card.html", name: "任务详情", purpose: "看一张卡这一轮做了什么" },
    ]);
    expect(read.kind === "present" && read.contract.components).toContain("卡片");
  });

  it("reports a directory with nothing in it as no contract at all", async () => {
    await expect(readInterfaceContract(await contractRoot({}))).resolves.toEqual({ kind: "absent" });
    await expect(readInterfaceContract(join(tmpdir(), "hivemind-no-such-prototype"))).resolves.toEqual({ kind: "absent" });
  });

  it("names every piece a half-written contract is missing, not the first one", async () => {
    const root = await contractRoot({ "components.md": "# 组件清单\n\n卡片：一张任务的摘要。" });

    const read = await readInterfaceContract(root);
    expect(read.kind === "incomplete" && read.reasons).toEqual([
      "tokens.json is missing",
      "pages/ has no page to look at",
    ]);
  });
});

describe("renderInterfaceContract", () => {
  it("renders the same bytes whichever order the file was written in", async () => {
    const first = await readInterfaceContract(await contractRoot({
      "tokens.json": TOKENS,
      "components.md": "# 组件清单\n\n卡片：一张任务的摘要。",
      "pages/board.html": page("任务看板", "看到哪些卡在等自己"),
      "pages/card.html": page("任务详情", "看一张卡这一轮做了什么"),
    }));
    // The same tokens and the same pages, written in another order and with
    // the JSON reindented: reformatting must not move a prompt byte.
    const second = await readInterfaceContract(await contractRoot({
      "tokens.json": JSON.stringify(JSON.parse(TOKENS), null, 4),
      "components.md": "# 组件清单\n\n卡片：一张任务的摘要。",
      "pages/card.html": page("任务详情", "看一张卡这一轮做了什么"),
      "pages/board.html": page("任务看板", "看到哪些卡在等自己"),
    }));

    expect(first.kind === "present" && second.kind === "present"
      && renderInterfaceContract(first.contract)).toEqual(
        second.kind === "present" ? renderInterfaceContract(second.contract) : "",
      );
    const rendered = first.kind === "present" ? renderInterfaceContract(first.contract) : "";
    expect(rendered).toContain("- color.brand.primary (color): #2F6FED");
    expect(rendered).toContain("- pages/board.html - 任务看板: 看到哪些卡在等自己");
  });
});
