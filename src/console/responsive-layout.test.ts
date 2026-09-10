import { createClient } from "@libsql/client";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../persistence/migrate.js";
import { LibsqlConsoleDataSource } from "./libsql-data-source.js";
import { createConsoleServer, listenConsole } from "./server.js";

/**
 * The overview and the Story detail page are read on a phone and on a desktop
 * screen. Only a real layout engine can answer whether a page drags sideways,
 * so these scenarios render the built console in Chromium at both viewports.
 *
 * The default unit-test gate runs on hosts that never installed a Playwright
 * browser (CI installs the CLI, not its browsers), so the checks skip there
 * instead of failing the gate; `npx playwright install chromium` enables them.
 */
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const UI_ROOT = join(REPO_ROOT, "console-ui");

const NOW = 1_700_000_000_000;
const PHASE = { story: "S-E1ACTION-06", title: "Add activity summary", phase: "CODE", startedAt: NOW - 125 * 60_000 };

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };

const DECISION = {
  question: "Which customers should be exported?",
  recommendedChoice: "Only export paid customers",
  recommendationReason: "This meets the current contract scope first",
  otherOption: "Export all customers",
  whereThisArose: "DESIGN",
  confirmationReason: "Customer scope changes contractual commitments and needs an owner decision",
};

const SECTION_TITLES = ["Pending responses", "Active requirements"];
const QUESTION = DECISION.question;
const DECISION_LABELS = [
  "Recommended choice",
  "Why this is recommended",
  "Other options",
  "Where this arose",
  "Why you need to confirm",
];
const DECISION_VALUES = [
  DECISION.recommendedChoice,
  DECISION.recommendationReason,
  DECISION.otherOption,
  DECISION.whereThisArose,
  DECISION.confirmationReason,
];
const REQUIREMENT_TITLE = "Export customers";
const PROGRESS_FIELDS = [
  "Current phase: CODE",
  "Working on: Add activity summary",
  "Active for: 2 hours 5 minutes",
  "Latest progress: CODE started",
];
const EMPTY_OR_ERROR_TEXT = ["No pending responses", "No active requirements", "Unable to load work status"];

const OVERVIEW_TEXTS = [
  ...SECTION_TITLES,
  QUESTION,
  ...DECISION_LABELS,
  REQUIREMENT_TITLE,
  ...PROGRESS_FIELDS,
  "View details",
  "Open in Notion",
];

/** A console that only reads never grows a way to answer, edit or run a card. */
const WRITE_CONTROL = /save|submit|apply|update|modify|edit|execute|answer|approve|delete/i;
const CONTROL_SELECTOR = "input,select,textarea";
const READING_SELECTOR = "h2,h3,strong,p,dt,dd";

/**
 * The slice of the DOM these probes read. The project compiles without the DOM
 * library, and page functions are serialized into the browser, so the globals
 * they touch are described here rather than imported.
 */
interface DomRect {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}
interface DomElement {
  readonly tagName: string;
  readonly textContent: string | null;
  readonly scrollWidth: number;
  readonly clientWidth: number;
  getBoundingClientRect(): DomRect;
  getAttribute(name: string): string | null;
  closest(selector: string): DomElement | null;
  scrollIntoView(options?: { block?: string }): void;
}
interface DomGlobals {
  readonly document: {
    readonly documentElement: { readonly scrollWidth: number };
    readonly body: { readonly innerText: string };
    querySelectorAll(selector: string): ArrayLike<DomElement>;
    elementFromPoint(x: number, y: number): DomElement | null;
  };
  readonly innerWidth: number;
  getComputedStyle(element: DomElement): { display: string; visibility: string; opacity: string };
}

interface ElementBox {
  text: string;
  tag: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
  clipped: boolean;
  shown: boolean;
}
interface NavBox {
  text: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
}
interface NotionEntry {
  href: string;
  left: number;
  right: number;
  width: number;
  height: number;
  hitHref: string | null;
  overlaps: string[];
}
interface Snapshot {
  innerWidth: number;
  scrollWidth: number;
  bodyText: string;
  labels: string[];
  links: string[];
  wanted: Record<string, ElementBox[]>;
  nav: NavBox[];
  notion: NotionEntry[];
  writeControls: string[];
}

/**
 * Everything the scenarios judge, read once per page. `shown` means the
 * element is inside the viewport sideways, which is what "readable without
 * dragging" comes down to; the vertical position stays the reader's scroll.
 */
async function snapshot(page: Page, wanted: string[]): Promise<Snapshot> {
  return page.evaluate((input: { wanted: string[]; reading: string; control: string; write: string }) => {
    const dom = globalThis as unknown as DomGlobals;
    const all = (selector: string) => Array.from(dom.document.querySelectorAll(selector));
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- page functions are serialized into the browser and cannot close over module scope
    const textOf = (element: DomElement) => element.textContent?.trim() ?? "";
    const shown = (element: DomElement) => {
      const style = dom.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0 && rect.width > 0;
    };
    const inside = (element: DomElement) => {
      const rect = element.getBoundingClientRect();
      return rect.left >= -0.5 && rect.right <= dom.innerWidth + 0.5;
    };
    const box = (element: DomElement): ElementBox => {
      const rect = element.getBoundingClientRect();
      return {
        text: textOf(element),
        tag: element.tagName,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
        clipped: element.scrollWidth > element.clientWidth + 1,
        shown: shown(element),
      };
    };

    const boxes: Record<string, ElementBox[]> = {};
    for (const text of input.wanted) {
      boxes[text] = all(`${input.reading},a,button`).filter((element) => textOf(element) === text).map(box);
    }

    const writePattern = new RegExp(input.write, "i");
    const writeControls = [
      ...all(input.control).map((element) => element.tagName),
      ...all("a,button").map(textOf).filter((text) => writePattern.test(text)),
    ];

    const notion: NotionEntry[] = all("a")
      .filter((element) => (element.getAttribute("href") ?? "").startsWith("https://www.notion.so/"))
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          href: element.getAttribute("href") ?? "",
          left: rect.left,
          right: rect.right,
          width: rect.width,
          height: rect.height,
          hitHref: null,
          overlaps: [],
        };
      });

    const result: Snapshot = {
      innerWidth: dom.innerWidth,
      scrollWidth: dom.document.documentElement.scrollWidth,
      bodyText: dom.document.body.innerText,
      labels: all(input.reading).filter(shown).filter(inside).map(textOf).toSorted(),
      links: all("a,button").filter(shown).filter(inside).map(textOf).toSorted(),
      wanted: boxes,
      nav: all("nav > *").map((element) => {
        const rect = element.getBoundingClientRect();
        return { text: textOf(element), left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width };
      }),
      notion,
      writeControls,
    };

    // The Notion entry has to stay tappable, which means nothing sits on top of
    // it. That needs the link on screen, so this runs after every other measure.
    result.notion = result.notion.map((entry, index) => {
      const link = all("a").filter((element) => (element.getAttribute("href") ?? "").startsWith("https://www.notion.so/"))[index];
      if (!link) return entry;
      link.scrollIntoView({ block: "center" });
      const rect = link.getBoundingClientRect();
      const point = dom.document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      const hit = point?.closest("a");
      const overlaps = all("a,button")
        .filter((other) => other !== link)
        .filter((other) => {
          const bounds = other.getBoundingClientRect();
          return rect.left < bounds.right - 0.5 && bounds.left < rect.right - 0.5
            && rect.top < bounds.bottom - 0.5 && bounds.top < rect.bottom - 0.5;
        })
        .map(textOf);
      return { ...entry, width: rect.width, height: rect.height, left: rect.left, right: rect.right, hitHref: hit?.getAttribute("href") ?? null, overlaps };
    });

    return result;
  }, { wanted, reading: READING_SELECTOR, control: CONTROL_SELECTOR, write: WRITE_CONTROL.source });
}

function expectReadable(entry: ElementBox, viewportWidth: number): void {
  const where = `"${entry.text}" (${entry.tag})`;
  expect(entry.width, `${where} has no width`).toBeGreaterThan(0);
  expect(entry.height, `${where} has no height`).toBeGreaterThan(0);
  expect(entry.shown, `${where} is hidden`).toBe(true);
  expect(entry.left, `${where} starts off the left edge`).toBeGreaterThanOrEqual(-0.5);
  expect(entry.right, `${where} ends past the right edge`).toBeLessThanOrEqual(viewportWidth + 0.5);
  expect(entry.clipped, `${where} is clipped`).toBe(false);
}

function expectTextsReadable(seen: Snapshot, texts: string[]): void {
  for (const text of texts) {
    const found = seen.wanted[text] ?? [];
    expect(found.length, `"${text}" is missing`).toBeGreaterThan(0);
    for (const entry of found) expectReadable(entry, seen.innerWidth);
  }
}

function expectNoWriteControls(seen: Snapshot): void {
  expect(seen.writeControls, "the console is read-only").toEqual([]);
}

function browserAvailable(): boolean {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

const describeLayout = browserAvailable() ? describe : describe.skip;

describeLayout("console layout", () => {
  let browser: Browser;
  let app: Awaited<ReturnType<typeof createConsoleServer>>;
  let client: ReturnType<typeof createClient>;
  let origin: string;
  const contexts: BrowserContext[] = [];

  beforeAll(async () => {
    await build({ root: UI_ROOT, logLevel: "error" });
    client = createClient({ url: ":memory:" });
    await migrate(client);
    await client.batch([
      { sql: `INSERT INTO requirements (id, notion_page_id, title, state, original_request, created_at, updated_at)
              VALUES ('requirement-exports', '11111111-2222-3333-4444-555555555555', 'Export customers', 'EXECUTING', 'Export customers', ?, ?)`,
        args: [NOW, NOW] },
      { sql: `INSERT INTO epics (id, notion_page_id, title, state, requirement_id, created_at, updated_at)
              VALUES ('EPIC-exports', 'epic-page-exports', 'Exports', 'EXECUTING', 'requirement-exports', ?, ?)`,
        args: [NOW, NOW] },
      { sql: `INSERT INTO stories (id, epic_id, notion_page_id, title, requirement, state, phase, phase_started_at, created_at, updated_at)
              VALUES (?, 'EPIC-exports', 'aaaa1111-2222-3333-4444-555555555555', ?, 'Export customers', 'CODE', 'CODE', ?, ?, ?)`,
        args: [PHASE.story, PHASE.title, PHASE.startedAt, PHASE.startedAt, PHASE.startedAt] },
      { sql: `INSERT INTO event_log (run_id, seq, card_id, phase, type, ts, data)
              VALUES ('code-run', 0, ?, 'CODE', 'phase_start', ?, '{}')`,
        args: [PHASE.story, PHASE.startedAt] },
      { sql: `INSERT INTO human_gates (
                id, object_type, object_id, required_action, phase, recommended_choice,
                recommendation_reason, other_options, confirmation_reason, navigation_target, created_at, updated_at
              ) VALUES ('gate-exports', 'requirement', 'requirement-exports', ?, 'DESIGN', ?, ?, ?, ?, '/requirements/requirement-exports', ?, ?)`,
        args: [DECISION.question, DECISION.recommendedChoice, DECISION.recommendationReason, JSON.stringify([DECISION.otherOption]), DECISION.confirmationReason, NOW, NOW] },
    ], "write");

    const source = new LibsqlConsoleDataSource(client, async () => [], () => NOW);
    app = await createConsoleServer(source, { uiRoot: join(UI_ROOT, "dist") });
    origin = await listenConsole(app, { host: "127.0.0.1", port: 0 });
    browser = await chromium.launch({ headless: true });
  }, 120_000);

  afterAll(async () => {
    await Promise.all(contexts.map((context) => context.close()));
    await browser?.close();
    await app?.close();
    client?.close();
  });

  async function openPage(width: number, height: number): Promise<Page> {
    const context = await browser.newContext({ viewport: { width, height } });
    contexts.push(context);
    return context.newPage();
  }

  async function overview(page: Page): Promise<void> {
    await page.goto(`${origin}/work-status`, { waitUntil: "networkidle" });
    await page.waitForSelector("nav > *");
  }

  // @scenario S-E1ACTION-06-phone
  it("S-E1ACTION-06-phone reads the whole overview on a 390x844 phone without dragging sideways", { timeout: 60_000 }, async () => {
    const page = await openPage(PHONE.width, PHONE.height);
    await overview(page);
    const seen = await snapshot(page, OVERVIEW_TEXTS);

    expect(seen.scrollWidth, "the overview drags sideways").toBeLessThanOrEqual(seen.innerWidth);

    expect(seen.nav.map((entry) => entry.text)).toEqual([
      "work-status", "nodes", "tasks", "costs", "config", "stats", "providers", "queues",
    ]);
    for (const entry of seen.nav) {
      expect(entry.left, `nav entry "${entry.text}" starts off the left edge`).toBeGreaterThanOrEqual(-0.5);
      expect(entry.right, `nav entry "${entry.text}" ends past the right edge`).toBeLessThanOrEqual(PHONE.width + 0.5);
      expect(entry.width, `nav entry "${entry.text}" has no width`).toBeGreaterThan(0);
    }
    for (const [index, entry] of seen.nav.entries()) {
      for (const other of seen.nav.slice(index + 1)) {
        const overlaps = entry.left < other.right - 0.5 && other.left < entry.right - 0.5
          && entry.top < other.bottom - 0.5 && other.top < entry.bottom - 0.5;
        expect(overlaps, `nav entries "${entry.text}" and "${other.text}" overlap`).toBe(false);
      }
    }

    expectTextsReadable(seen, OVERVIEW_TEXTS);
    expect(seen.wanted["Open in Notion"], "both Notion entries are missing").toHaveLength(2);

    for (const absent of [...EMPTY_OR_ERROR_TEXT, "navigationTarget"]) {
      expect(seen.bodyText, `"${absent}" reached the phone screen`).not.toContain(absent);
    }
  });

  // @scenario S-E1ACTION-06-desktop
  it("S-E1ACTION-06-desktop reads the same group of fields and links as the phone on a 1280x800 screen", { timeout: 60_000 }, async () => {
    const desktopPage = await openPage(DESKTOP.width, DESKTOP.height);
    await overview(desktopPage);
    const desktop = await snapshot(desktopPage, [...OVERVIEW_TEXTS, ...DECISION_VALUES]);

    expect(desktop.scrollWidth, "the overview drags sideways").toBeLessThanOrEqual(DESKTOP.width);
    expectTextsReadable(desktop, [...OVERVIEW_TEXTS, ...DECISION_VALUES]);

    const phonePage = await openPage(PHONE.width, PHONE.height);
    await overview(phonePage);
    const phone = await snapshot(phonePage, OVERVIEW_TEXTS);

    expect(desktop.labels, "the two viewports do not show the same fields").toEqual(phone.labels);
    expect(desktop.links, "the two viewports do not show the same links").toEqual(phone.links);

    for (const absent of EMPTY_OR_ERROR_TEXT) {
      expect(desktop.bodyText, `"${absent}" reached the desktop screen`).not.toContain(absent);
    }
  });

  // @scenario S-E1ACTION-06-detail
  it("S-E1ACTION-06-detail opens the Story detail from a phone without dragging sideways", { timeout: 60_000 }, async () => {
    const page = await openPage(PHONE.width, PHONE.height);
    await overview(page);
    await Promise.all([
      page.waitForURL(`**/tasks/${PHASE.story}`),
      page.getByRole("link", { name: "View details" }).click(),
    ]);
    await page.waitForSelector("pre");

    expect(new URL(page.url()).pathname).toBe(`/tasks/${PHASE.story}`);
    const detail = await snapshot(page, []);
    expect(detail.scrollWidth, "the detail page drags sideways").toBeLessThanOrEqual(detail.innerWidth);
    expect(detail.bodyText, "the Story title is missing").toContain(`"title": "${PHASE.title}"`);
    expect(detail.bodyText, "the Story phase is missing").toContain(`"phase": "${PHASE.phase}"`);
    expectNoWriteControls(detail);
  });
});
