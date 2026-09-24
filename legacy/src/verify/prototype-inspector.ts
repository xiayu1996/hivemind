import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { collectStylesExpression, CONTRACT_MAX_ELEMENTS } from "./ui-contract-collector.js";
import { PROTOTYPE_STATES, type PrototypePageEvidence, type PrototypeState } from "./prototype-exit.js";
import { CONTRACT_PROPERTIES, type PageStyles } from "./ui-contract.js";
import { axeRunExpression, type AccessibilityViolation } from "./accessibility-audit.js";

/**
 * Opens the pages of a prototype and brings back what the exit checks judge.
 *
 * A prototype is static files, so it is read over `file://` with no server:
 * requiring one would make the check depend on a stack the prototype has not
 * chosen yet, and the prototype exists precisely to be judged before anything
 * is built.
 *
 * The browser is behind a port for the same reason the rest of the verify side
 * is: the tests of what a finding means must not have to start Chromium.
 */

export interface PageInspection {
  /** The accessibility tree, as Playwright's YAML. */
  snapshot: string;
  /** Computed styles, only when they were asked for. */
  styles: PageStyles | null;
  /** What axe-core found, only when it was asked for. */
  violations?: readonly AccessibilityViolation[];
}

export interface PrototypeInspectorPort {
  /** Opens `url`. Rejecting is the answer for a page that will not render. */
  inspect(url: string, want: { styles: boolean }): Promise<PageInspection>;
}

/** This installation's own Playwright. The target repository may not have one,
 * and a prototype must not need it to be checked. One browser for the whole
 * prototype: a contract with six pages opens twenty-four URLs. */
export async function playwrightPrototypeInspector(): Promise<
  PrototypeInspectorPort & { close(): Promise<void> }
> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  return {
    inspect: async (url, want) => {
      const page = await browser.newPage();
      try {
        await page.goto(url, { waitUntil: "load" });
        const snapshot = await page.locator("body").ariaSnapshot();
        if (!want.styles) return { snapshot, styles: null };
        const styles = await page.evaluate(collectStylesExpression({
          properties: CONTRACT_PROPERTIES,
          maxElements: CONTRACT_MAX_ELEMENTS,
        })) as PageStyles;
        // axe's own source, added to the page rather than bundled with it: the
        // prototype must not have to depend on anything to be audited.
        // axe-core is CommonJS, so the named export is only on the default:
        // reading `source` off the namespace gets undefined and adds an empty
        // script, and the page then has no `axe` for the expression to call.
        const axe = (await import("axe-core")).default;
        await page.addScriptTag({ content: axe.source });
        const violations = await page.evaluate(axeRunExpression()) as AccessibilityViolation[];
        return { snapshot, styles, violations };
      } finally {
        await page.close();
      }
    },
    close: () => browser.close(),
  };
}

/**
 * Every page in a stable order, each opened once plain and once per state.
 *
 * A page that will not open is reported as such rather than thrown: one broken
 * page is a finding the round can fix, and throwing would lose what the other
 * pages already proved.
 */
export async function inspectPrototypePages(request: {
  root: string;
  pages: readonly string[];
  port: PrototypeInspectorPort;
}): Promise<PrototypePageEvidence[]> {
  const evidence: PrototypePageEvidence[] = [];
  for (const page of [...request.pages].toSorted()) {
    const base = pathToFileURL(resolve(request.root, page)).href;
    const plain = await request.port.inspect(base, { styles: true }).catch(() => null);
    const states: Partial<Record<PrototypeState, string>> = {};
    // A page that would not open plain will not open with a query either, and
    // four more timeouts would only slow the round that has to fix it down.
    for (const state of plain === null ? [] : PROTOTYPE_STATES) {
      const seen = await request.port.inspect(`${base}?state=${state}`, { styles: false }).catch(() => null);
      if (seen !== null) states[state] = seen.snapshot;
    }
    evidence.push({
      file: page,
      snapshot: plain?.snapshot ?? null,
      states,
      styles: plain?.styles ?? null,
      violations: plain?.violations ?? [],
    });
  }
  return evidence;
}
