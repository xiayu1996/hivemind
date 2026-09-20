import { hasScreen, type DefinitionOfDone } from "./dod.js";

/** A screen the card promises, and where the DoD says it is served. */
export interface ScreenPage {
  scenarioId: string;
  page: string;
}

/** What the application answered, or why nothing answered at all. */
export type ScreenResponse = { status: number } | { failed: string };

export interface UnreachableScreen {
  scenarioId: string;
  page: string;
  /** Written for the session that has to fix it, in its own words. */
  reason: string;
}

/** Screens the DoD promises, in a stable order. */
export function screenPages(definition: DefinitionOfDone): ScreenPage[] {
  return definition.scenarios
    .filter((entry): entry is typeof entry & { page: string } => hasScreen(entry) && entry.page !== undefined)
    .map((entry) => ({ scenarioId: entry.id, page: entry.page }))
    .toSorted((left, right) => left.scenarioId.localeCompare(right.scenarioId, "en"));
}

/**
 * Whether the application the repository itself starts serves each screen.
 *
 * This is the one question about a screen that code can answer, and until it
 * was asked here nothing asked it before a browser did: a component that was
 * written and never mounted passes every unit test it has, and the verifier
 * that would have noticed was reading a server it had assembled itself.
 *
 * Only "not found" and "nothing answered" refuse. A redirect to a sign-in
 * page, a 401 or a 500 all mean the route is mounted, and demanding a 200
 * would make every screen behind a session depend on data this phase has no
 * way to create -- which is a different problem, and not one a card can fix.
 */
export async function probeScreens(
  origin: string,
  pages: readonly ScreenPage[],
  request: (url: string) => Promise<ScreenResponse>,
): Promise<UnreachableScreen[]> {
  const unreachable: UnreachableScreen[] = [];
  for (const entry of pages) {
    const url = new URL(entry.page, origin).toString();
    const response = await request(url);
    if ("failed" in response) {
      unreachable.push({ ...entry, reason: `应用没有应答（${response.failed}）` });
      continue;
    }
    if (response.status === 404 || response.status === 410) {
      unreachable.push({ ...entry, reason: `应用回了「找不到页面」（HTTP ${response.status}）` });
    }
  }
  return unreachable;
}

/** What the session is asked to fix, with the application in front of it. */
export function renderUnreachableScreens(entries: readonly UnreachableScreen[]): string {
  return [
    "把这个仓库自己的启动命令跑起来之后，下面这些页面打不开：",
    ...entries.map((entry) => `- ${entry.scenarioId} ${entry.page}：${entry.reason}`),
    "页面组件写好了、单测也绿，但产品的入口没有把它挂上去——从入口进不去的页面，对用户来说就是不存在。",
    "请把它接到应用启动时真正会走到的那个入口上，然后自己再跑一遍确认打得开。",
    "如果这条路径本来就需要先有数据才存在（例如某个具体记录的详情页），说明 DoD 里写的不是一条稳定存在的路径，",
    "这一轮先把承载它的那一页接上，并在交付说明里写清楚。",
  ].join("\n");
}
