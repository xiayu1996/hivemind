import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { CONTRACT_PROPERTIES, type PageStyles } from "./ui-contract.js";

/**
 * Reads the computed styles of a rendered page.
 *
 * Separate from the checking so the judgement stays a pure function: whether a
 * value is in the token table is decided by code that needs no browser, and
 * only getting the values needs one. The browser is reached through a port for
 * the same reason the screenshots are -- a test about the contract layer must
 * not have to start Chromium.
 */

/** How many elements one page contributes. A page that renders a thousand rows
 * says nothing new after the first screenful of them, and an unbounded walk
 * would put a megabyte of duplicates through the checker. */
export const CONTRACT_MAX_ELEMENTS = 400;

export interface StyleCollectorPort {
  /**
   * Opens `url` and returns what `COLLECT_STYLES` evaluates to. Rejecting is
   * allowed: a page that will not render is reported as a failure rather than
   * as a page with no violations.
   */
  collect(url: string, properties: readonly string[], maxElements: number): Promise<PageStyles>;
}

export interface PageStyleRequest {
  /** The contract root the page paths are relative to. */
  root: string;
  /** Page files relative to the root, as the contract lists them. */
  pages: readonly string[];
  port: StyleCollectorPort;
}

export interface PageStyleResult {
  styles: Map<string, PageStyles>;
  /** One line per page that produced nothing. Never thrown: a prototype that
   * will not render is something a person has to be told about. */
  failures: string[];
}

/**
 * The body evaluated in the page. Written as a string rather than a function
 * so it is obvious that it runs in the browser's context, where none of this
 * module's imports exist.
 *
 * It reads only the values the page itself declared -- the properties named in
 * its own stylesheets and style attributes -- and reads them computed, so a
 * declaration that points at a custom property comes back as the value that
 * property holds. Walking every element instead would report the user agent's
 * own stylesheet: a bare `h1` is 32px and a bare `button` has six pixels of
 * padding on a machine nobody configured, and none of that is a decision the
 * token table was supposed to contain. Measured on the first real page: 484
 * readings, of which every violation came from the browser.
 */
const COLLECT_STYLES_BODY = `(input) => {
  const { properties, maxElements } = input;
  const wanted = new Set(properties);
  const path = (element) => {
    const parts = [];
    for (let node = element; node && node.nodeType === 1 && parts.length < 4; node = node.parentElement) {
      const name = node.tagName.toLowerCase();
      const id = node.id ? "#" + node.id : "";
      const cls = !id && node.classList.length > 0 ? "." + node.classList[0] : "";
      parts.unshift(name + id + cls);
      if (id) break;
    }
    return parts.join(" > ");
  };
  const declared = new Map();
  const note = (element, property) => {
    let named = declared.get(element);
    if (!named) { named = new Set(); declared.set(element, named); }
    named.add(property);
  };
  const visit = (rules) => {
    for (const rule of rules) {
      if (rule.style && typeof rule.selectorText === "string") {
        const named = [];
        for (const property of rule.style) if (wanted.has(property)) named.push(property);
        if (named.length > 0) {
          let matched = null;
          // A selector this document cannot evaluate, such as one that ends in
          // a pseudo-element, matches no element here and is not a finding.
          try { matched = document.querySelectorAll(rule.selectorText); } catch (error) { matched = null; }
          if (matched) for (const element of matched) for (const property of named) note(element, property);
        }
      }
      if (rule.cssRules) visit(rule.cssRules);
    }
  };
  for (const sheet of document.styleSheets) {
    let rules = null;
    // A stylesheet from another origin refuses to be read; nothing here can
    // make it readable, and a page that loads one says so in its own source.
    try { rules = sheet.cssRules; } catch (error) { rules = null; }
    if (rules) visit(rules);
  }
  for (const element of document.querySelectorAll("[style]")) {
    for (const property of element.style) if (wanted.has(property)) note(element, property);
  }
  const usages = [];
  let seen = 0;
  for (const [element, named] of declared) {
    if (seen >= maxElements) break;
    seen += 1;
    const computed = getComputedStyle(element);
    const selector = path(element);
    for (const property of [...named].sort()) {
      usages.push({ selector, property, value: computed.getPropertyValue(property) });
    }
  }
  return {
    rootFontSizePx: Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16,
    usages,
  };
}`;

/**
 * The evaluation Playwright is handed: a call, not a function.
 *
 * `page.evaluate` given a string evaluates it as an expression and does not
 * call what it produces, so handing it the function source alone returned
 * undefined for every page -- and a page with no readings has no violations,
 * which is the shape a broken check and a clean page share. The argument is
 * inlined as JSON because an expression takes none.
 */
export function collectStylesExpression(input: {
  properties: readonly string[];
  maxElements: number;
}): string {
  return `(${COLLECT_STYLES_BODY})(${JSON.stringify(input)})`;
}

/**
 * The port backed by this installation's own Playwright. The target repository
 * may not have Playwright at all, and a prototype must not need it to be
 * checked.
 *
 * One browser for the whole request: launching Chromium per page is most of
 * the wall clock of checking a contract with six pages in it.
 */
export async function playwrightStyleCollector(): Promise<StyleCollectorPort & { close(): Promise<void> }> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  return {
    collect: async (url, properties, maxElements) => {
      const page = await browser.newPage();
      try {
        await page.goto(url, { waitUntil: "load" });
        return await page.evaluate(collectStylesExpression({ properties, maxElements })) as PageStyles;
      } finally {
        await page.close();
      }
    },
    close: () => browser.close(),
  };
}

/** Every page's computed styles, in a stable order so two runs of one contract
 * report the same findings in the same sequence. */
export async function collectPageStyles(request: PageStyleRequest): Promise<PageStyleResult> {
  const styles = new Map<string, PageStyles>();
  const failures: string[] = [];
  for (const page of [...request.pages].toSorted()) {
    const url = pathToFileURL(resolve(request.root, page)).href;
    try {
      styles.set(page, await request.port.collect(url, CONTRACT_PROPERTIES, CONTRACT_MAX_ELEMENTS));
    } catch (cause) {
      failures.push(`${page}: ${cause instanceof Error ? cause.message : "did not render"}`);
    }
  }
  return { styles, failures };
}
