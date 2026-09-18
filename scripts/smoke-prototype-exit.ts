import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readInterfaceContract } from "../src/pipeline/interface-contract.js";
import { evaluatePrototypeExit } from "../src/verify/prototype-exit.js";
import { inspectPrototypePages, playwrightPrototypeInspector } from "../src/verify/prototype-inspector.js";

/**
 * The prototype exit against a real browser.
 *
 * The unit tests answer what a finding means; only Chromium answers whether an
 * accessibility tree and a computed style come back at all, whether `?state=`
 * reaches the page, and whether a rem in the token table matches a rem on the
 * screen. Run it whenever the exit, the inspector or the contract reader
 * changes.
 */

const TOKENS = {
  color: {
    surface: { $type: "color", $value: "#111827" },
    text: { $type: "color", $value: "#f9fafb" },
    brand: { $type: "color", $value: "#2563eb" },
  },
  size: {
    text: { body: { $type: "dimension", $value: "1rem" } },
    space: { tight: { $type: "dimension", $value: "8px" } },
  },
};

/** A page that is four pages, chosen by the query, with every value from the
 * table above. Written the way the drawing session is asked to write one. */
const PAGE = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>任务看板</title>
<meta name="description" content="看今天要做什么">
<style>
  :root {
    --color-surface: #111827;
    --color-text: #f9fafb;
    --color-brand: #2563eb;
    --size-text-body: 1rem;
    --size-space-tight: 8px;
  }
  body {
    background-color: var(--color-surface);
    color: var(--color-text);
    font-size: var(--size-text-body);
    padding-top: var(--size-space-tight);
  }
  button { background-color: var(--color-brand); color: var(--color-text); padding-top: var(--size-space-tight); }
  [hidden] { display: none; }
</style>
</head>
<body>
  <h1>任务看板</h1>
  <label for="search">搜索任务</label><input id="search" name="search">
  <section id="ready"><button>新建任务</button><p>今天有 3 件事</p></section>
  <section id="empty" hidden><p>今天还没有任务</p><button>新建任务</button></section>
  <section id="loading" hidden><p>正在读取任务</p></section>
  <section id="error" hidden><p>读不到任务，检查网络后重试</p><button>重试</button></section>
  <section id="waiting" hidden><p>等负责人确认，确认后这里会更新</p></section>
<script>
  const state = new URLSearchParams(location.search).get("state") || "ready";
  for (const section of document.querySelectorAll("section")) {
    section.hidden = section.id !== state;
  }
</script>
</body>
</html>
`;

async function main(): Promise<void> {
  const root = join(await mkdtemp(join(tmpdir(), "hivemind-prototype-smoke-")), "docs", "prototype");
  await mkdir(join(root, "pages"), { recursive: true });
  await writeFile(join(root, "tokens.json"), JSON.stringify(TOKENS, null, 2));
  await writeFile(join(root, "components.md"), "# 组件\n\n- 按钮：触发一个动作，每页最多一个主按钮。\n");
  await writeFile(
    join(root, "design.md"),
    "# 为什么长这样\n\n值班的人在走动中看这块屏，所以底色用 `color.surface`，"
      + "主按钮用 `color.brand`，行间距用 `size.space.tight`。\n",
  );
  await writeFile(join(root, "pages", "board.html"), PAGE);
  await writeFile(
    join(root, "pages", "broken.html"),
    PAGE.replace("<title>任务看板</title>", "<title>写死了颜色的一页</title>")
      .replace("background-color: var(--color-brand);", "background-color: #c8c8c8;"),
  );

  const read = await readInterfaceContract(root);
  if (read.kind !== "present") {
    throw new Error(`contract was not readable: ${JSON.stringify(read)}`);
  }
  console.log(`contract read: ${read.contract.tokens.length} tokens, ${read.contract.pages.length} pages`);

  const inspector = await playwrightPrototypeInspector();
  try {
    const evidence = await inspectPrototypePages({
      root,
      pages: read.contract.pages.map((page) => page.file),
      port: inspector,
    });
    const board = evidence.find((page) => page.file === "pages/board.html")!;
    console.log(`board.html: ${board.snapshot?.split("\n").length ?? 0} snapshot lines, ` +
      `${board.styles?.usages.length ?? 0} style readings, states ${Object.keys(board.states).join(",")}, ` +
      `${board.violations?.length ?? 0} accessibility violations`);
    if (board.violations === undefined) throw new Error("axe-core did not run on the page at all");

    const good = evaluatePrototypeExit({
      claims: [{
        file: "pages/board.html",
        scenarios: ["R-SMOKE-01"],
        visible: [{ role: "heading", text: "任务看板" }, { role: "button", text: "新建任务" }],
      }],
      evidence,
      contractPages: ["pages/board.html"],
      scenarios: ["R-SMOKE-01"],
      tokens: read.contract.tokens,
      contractReasons: [],
    });
    if (good.length > 0) throw new Error(`a page built from the table was refused: ${good.join("; ")}`);
    console.log("a page that draws what it claims, in four states, out of the table: no findings");

    const bad = evaluatePrototypeExit({
      claims: [
        {
          file: "pages/broken.html",
          scenarios: ["R-SMOKE-01"],
          visible: [{ role: "button", text: "导出报表" }],
        },
      ],
      evidence,
      contractPages: ["pages/board.html", "pages/broken.html"],
      scenarios: ["R-SMOKE-01", "R-SMOKE-02"],
      tokens: read.contract.tokens,
      contractReasons: [],
    });
    for (const finding of bad) console.log(`  finding: ${finding}`);
    const wanted = [
      (text: string) => text.includes("导出报表"),
      (text: string) => text.includes("不在设计规范里的颜色"),
      (text: string) => text.includes("R-SMOKE-02"),
      (text: string) => text.includes("color-contrast"),
    ];
    for (const [index, predicate] of wanted.entries()) {
      if (!bad.some((finding) => predicate(finding))) {
        throw new Error(`the broken page was not refused for reason ${index + 1}`);
      }
    }
    console.log("a page that claims what it did not draw, paints outside the table and fails a contrast rule: refused for all three");
  } finally {
    await inspector.close();
  }
}

await main();
