/**
 * Things this round wrote that nothing in the product calls.
 *
 * A Story is a vertical slice: what it adds is reachable from the product by
 * the time it is done. So an export this round created, that no non-test file
 * anywhere in the tree mentions, is a feature that exists only in its own unit
 * tests -- green, complete-looking and unreachable.
 *
 * Both failures this week are this shape. S-R237511DT-04 wrote
 * `registerOverviewRoutes` and `server.ts` never called it, so the console
 * served the pre-existing page at the same path and every scenario was judged
 * against somebody else's screen. R237511RC wired its ports into the start
 * script alone and never into the mount a person opens. Unit tests passed in
 * both cases because unit tests import what they test.
 *
 * Asked of code rather than of a browser because code can answer it: no
 * application has to start, no data has to exist, and the answer does not
 * depend on how the page is rendered. It refuses only the total case -- zero
 * mentions outside tests -- because one mention is a wiring decision and this
 * gate has no standing to judge those.
 */

/** An export this round introduced, and where. */
export interface IntroducedExport {
  name: string;
  file: string;
}

/**
 * Functions and classes only. A type or an interface earns its keep inside the
 * file that declares it, and a constant often does too, so demanding a mention
 * elsewhere would refuse correct rounds -- and this gate refuses by failing the
 * phase. It may miss; it may not accuse wrongly.
 */
const EXPORT_DECLARATION = /^\+\s*export\s+(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/;
const FILE_HEADER = /^\+\+\+ b\/(.+)$/;

/**
 * The exports added by a unified diff, in a stable order.
 *
 * Read from the diff rather than from the tree because only the diff says
 * "this round wrote it": a file may have carried an unused export for months,
 * and that is somebody else's debt, not this card's.
 */
export function introducedExports(diff: string): IntroducedExport[] {
  const found: IntroducedExport[] = [];
  let file = "";
  for (const line of diff.split("\n")) {
    const header = FILE_HEADER.exec(line);
    if (header) {
      file = header[1]!;
      continue;
    }
    if (file === "" || isTestFile(file)) continue;
    const declaration = EXPORT_DECLARATION.exec(line);
    if (declaration) found.push({ name: declaration[1]!, file });
  }
  return found.toSorted((a, b) => a.name.localeCompare(b.name, "en") || a.file.localeCompare(b.file, "en"));
}

/** Whether this path holds tests, which mention what they test by definition. */
export function isTestFile(path: string): boolean {
  return /(^|\/)(?:__tests__|tests?)\//.test(path) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path);
}

export interface UnwiredExport extends IntroducedExport {}

/**
 * The introduced exports that nothing outside their own file and the tests
 * mentions.
 *
 * `mentions` answers, for one name, the non-test files that contain it. The
 * caller greps the worktree; the judgement is here so it can be read and
 * tested without one.
 */
export function unwiredExports(
  introduced: readonly IntroducedExport[],
  mentions: ReadonlyMap<string, readonly string[]>,
): UnwiredExport[] {
  return introduced.filter((entry) => {
    const elsewhere = (mentions.get(entry.name) ?? []).filter((path) => path !== entry.file && !isTestFile(path));
    return elsewhere.length === 0;
  });
}

export function renderUnwiredExports(entries: readonly UnwiredExport[]): string {
  return [
    "这一轮新写的下面这些东西，除了它自己那个文件和测试，产品里没有任何地方用到：",
    ...entries.map((entry) => `- ${entry.name}（${entry.file}）`),
    "一张卡是一条能走通的竖切：它加的东西，做完时应该从产品里到得了。只有单测用到，说明它还没接上——",
    "单测会导入它要测的东西，所以单测全绿证明不了这一点。",
    "S-R237511DT-04 写了 registerOverviewRoutes 而入口从未调用它，于是同一路径上服务的仍是原来那一页，",
    "三条场景全都在对着别人的页面判定。",
    "请把它接到产品真正会走到的地方；如果这一轮确实只需要它存在（例如下一张卡才接），在交付说明里写明。",
  ].join("\n");
}
