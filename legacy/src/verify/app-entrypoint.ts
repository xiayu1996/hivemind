/**
 * The application lane is a witness, and a witness the round rewrote is not
 * one.
 *
 * Screen reachability asks the repository's own start command to serve each
 * page, which is the one question about a screen code can answer. It answers
 * it honestly only while the thing being started is the product. R237511RC
 * added the role-configuration ports to `scripts/serve-console.ts` -- the very
 * script `verify.appStartCommand` names -- and to nothing else: the mount that
 * holds the central store and that a person actually opens never received
 * them. Every screen was reachable, every round was green, and the page did
 * not exist in the product at all.
 *
 * So a round that writes screens may not edit the file its own reachability
 * probe and its own interface review are started from. Mounting a new page
 * belongs in the routing the entry point loads, not in how the product is
 * started; a round that has to change the start command itself is a round
 * building its own observation post, and that is a decision for a person.
 */

/** Paths inside the repository that the start command runs, in argv order. */
export function entrypointFiles(command: readonly string[]): string[] {
  const files: string[] = [];
  for (const argument of command) {
    // A repository-relative path with an extension. Flags, ports, package
    // scripts (`npm run dev`) and binaries name no file here and are not
    // held to anything: what cannot be identified is not accused.
    if (argument.startsWith("-") || argument.includes("{")) continue;
    if (!argument.includes("/") || !/\.[A-Za-z0-9]+$/.test(argument)) continue;
    if (argument.startsWith("/") || argument.includes("..")) continue;
    files.push(argument);
  }
  return files;
}

/** The entry points this round rewrote, in a stable order. */
export function entrypointsTouched(
  command: readonly string[],
  changedPaths: readonly string[],
): string[] {
  const entrypoints = new Set(entrypointFiles(command));
  return changedPaths.filter((path) => entrypoints.has(path)).toSorted((a, b) => a.localeCompare(b, "en"));
}

export function renderEntrypointsTouched(paths: readonly string[]): string {
  return [
    "这一轮改了「把应用起起来」的那个入口本身：",
    ...paths.map((path) => `- ${path}`),
    "页面能不能打开，是靠起这个入口来证明的。改了它，这一轮就等于在给自己造观测台——",
    "R237511RC 正是这样：角色配置页的数据端口只加在了这个启动脚本里，产品里真正持有中央库的那个挂载从来没接上，",
    "于是每一页都「可达」、每一轮都绿，而这页在产品里根本不存在。",
    "把页面挂到入口加载的路由装配里，不要动启动脚本本身；数据端口要接在产品真正用的那个挂载点上。",
    "如果这一轮确实必须改产品的启动方式，那不是一张卡该替所有卡做的决定，请在交付说明里写明并交给人。",
  ].join("\n");
}
