import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import { chromium, type Locator, type Page, type Request, type Response } from "playwright";
import { z } from "zod";
import { parseAriaSnapshot } from "../gates/evidence.ts";
import type { BrowserSessionInput, CapturedEvidence, OpenEvaluatorBrowser, ReplayScriptRunner, ReplayStep, ToolOutput, ToolSpec } from "../ports.ts";

/**
 * The evaluator's hands on the running product, and the replay of what they
 * did. The harness, not the model, captures everything a verdict may cite:
 * snapshots are taken here, only on the product's own origin, and filed under
 * ids the model can point at but never write. Each scenario's steps are
 * recorded the way a person names things (a role and an accessible name), so
 * a scenario that passed once can be repeated later without a model.
 */

const ELEMENT_TIMEOUT_MS = 10_000;
const NAVIGATION_TIMEOUT_MS = 30_000;
const LAUNCH_TIMEOUT_MS = 60_000;
/**
 * How long a live session waits for a named element to appear. The model names
 * elements from a snapshot it took, so one still missing after this is
 * misnamed, and the list of what is there helps it more than waiting longer.
 * A replay has nobody to correct it and waits the full element timeout.
 */
const LIVE_APPEAR_MS = 2_000;
/**
 * An action has settled once it has been over for SETTLE_QUIET_MS and nothing
 * it started has been in flight for as long: Playwright's networkidle rule,
 * applied after every action instead of once per document, so it also covers
 * the fetches of a single-page application and a search box that waits for
 * typing to pause. It gives up after SETTLE_CAP_MS, or NAVIGATION_TIMEOUT_MS
 * while a new document is loading. Without it a replay, which has no model
 * pausing between steps, snapshots a list before the fetch that fills it has
 * returned.
 */
const SETTLE_QUIET_MS = 500;
const SETTLE_CAP_MS = 3_000;
const SETTLE_POLL_MS = 50;
const LISTED_ELEMENTS = 10;
/** Command output shown to the model; the evidence keeps all of it. */
const OUTPUT_SHOWN_CHARS = 20_000;
const RETURN_ADVICE = " Use open_page to open a page of the product; nothing outside it is clicked or captured.";

/** One headless browser with one page. The live session and the replay drive it the same way. */
interface Driver {
  readonly page: Page;
  /** The product's origin, as `URL.origin` writes it. */
  readonly origin: string;
  /** Runs an action, then waits until what it started has settled. */
  act<T>(action: () => Promise<T>, signal: AbortSignal | undefined): Promise<T>;
  /** Navigates the page until its document is parsed; settling is the caller's choice. */
  goto(url: string, signal: AbortSignal | undefined): Promise<Response | null>;
  /** What the page did on its own since the last call (dialogs accepted, tabs closed), for the tool result. */
  takeNotices(): string[];
  /** Closes the browser; a second call returns the first call's promise. */
  close(): Promise<void>;
}

interface Location {
  href: string;
  onProduct: boolean;
  /** Pathname and query string: where evidence says it was taken. */
  path: string;
}

interface RecordedStep {
  step: ReplayStep;
  /** Where a snapshot step was taken; null for every other step. */
  snapshotPath: string | null;
}

async function launch(origin: string): Promise<Driver> {
  const browser = await chromium.launch({ headless: true, timeout: LAUNCH_TIMEOUT_MS });
  let page: Page;
  try {
    const context = await browser.newContext();
    context.setDefaultTimeout(ELEMENT_TIMEOUT_MS);
    context.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
    page = await context.newPage();
  } catch (error) {
    // The error worth reporting is the one that kept the page from opening;
    // close kills the process itself when it cannot end it gracefully.
    await browser.close().catch(() => undefined);
    throw error;
  }

  const notices: string[] = [];
  page.on("dialog", (dialog) => {
    notices.push(`The page showed a ${dialog.type()} dialog saying ${JSON.stringify(dialog.message())}; it was accepted, as a person going ahead would.`);
    // Rejects only when the page already took the dialog down by navigating away; nothing waits on it then.
    void dialog.accept().catch(() => undefined);
  });
  page.on("popup", (popup) => {
    const opened = new URL(popup.url());
    notices.push(opened.origin === origin
      ? `That opened a new tab at ${opened.pathname}${opened.search}, which was closed: this browser keeps to one tab. Use open_page to go there.`
      : `That opened a new tab at ${opened.href}, outside the product, which was closed.`);
    // Rejects only when the tab has already closed itself.
    void popup.close().catch(() => undefined);
  });

  const inflight = new Map<Request, { startedAt: number; loadsPage: boolean }>();
  let lastActivity = 0;
  page.on("request", (request) => {
    // An event stream stays open for the life of the page; counting it would hold every action to the cap.
    if (request.resourceType() === "eventsource") return;
    inflight.set(request, { startedAt: Date.now(), loadsPage: loadsPage(page, request) });
    lastActivity = Date.now();
  });
  const finished = (request: Request): void => {
    inflight.delete(request);
    lastActivity = Date.now();
  };
  page.on("requestfinished", finished);
  page.on("requestfailed", finished);
  page.on("framenavigated", (frame) => {
    if (frame !== page.mainFrame()) return;
    // Once a document commits, no navigation request is loading the page any
    // more, whether or not its end was reported; the document itself is
    // awaited through its load state.
    for (const [request, entry] of inflight) {
      if (entry.loadsPage) inflight.delete(request);
    }
  });

  /**
   * Only requests started since `since` count: the ones a replaced document
   * left open are never reported finished or failed, and a long poll that was
   * open before the action is not the action's doing.
   */
  async function settle(since: number, signal: AbortSignal | undefined): Promise<void> {
    const from = Date.now();
    for (;;) {
      const now = Date.now();
      const pending = [...inflight.values()].filter((entry) => entry.startedAt >= since);
      if (pending.length === 0 && now - Math.max(from, lastActivity) >= SETTLE_QUIET_MS) break;
      if (now - from >= (pending.some((entry) => entry.loadsPage) ? NAVIGATION_TIMEOUT_MS : SETTLE_CAP_MS)) break;
      await sleep(SETTLE_POLL_MS, undefined, signal === undefined ? {} : { signal });
    }
    await page.waitForLoadState("domcontentloaded", within(NAVIGATION_TIMEOUT_MS, signal));
  }

  async function act<T>(action: () => Promise<T>, signal: AbortSignal | undefined): Promise<T> {
    const since = Date.now();
    const result = await action();
    await settle(since, signal);
    return result;
  }

  async function goto(url: string, signal: AbortSignal | undefined): Promise<Response | null> {
    const load = () => page.goto(url, { waitUntil: "domcontentloaded", ...within(NAVIGATION_TIMEOUT_MS, signal) });
    try {
      return await load();
    } catch (error) {
      // Chromium commits the error page of a failed load only after the
      // failure is reported, and that late commit cancels whichever navigation
      // comes next. Once it has landed, going again is what was asked.
      if (!explain(error).includes("interrupted by another navigation")) throw error;
      await page.waitForLoadState("domcontentloaded", within(NAVIGATION_TIMEOUT_MS, signal));
      return load();
    }
  }

  let closing: Promise<void> | undefined;
  return {
    page,
    origin,
    act,
    goto,
    takeNotices: () => notices.splice(0),
    close: () => (closing ??= browser.close()),
  };
}

/** Whether the request loads a new document into the page itself, rather than a resource or a frame's document. */
function loadsPage(page: Page, request: Request): boolean {
  if (!request.isNavigationRequest()) return false;
  try {
    return request.frame() === page.mainFrame();
  } catch {
    // frame() throws only for a request a service worker made on its own
    // behalf, which never loads the page's document.
    return false;
  }
}

/** Bounds one Playwright call, and lets the caller's signal cancel it when there is one. */
function within(timeout: number, signal: AbortSignal | undefined): { timeout: number; signal?: AbortSignal } {
  return signal === undefined ? { timeout } : { timeout, signal };
}

/**
 * A Playwright error as one readable line, without colors: its headline and
 * the last element state its call log names, as in "Timeout 10000ms exceeded
 * (element is not enabled)". A message without a call log is kept whole.
 */
function explain(error: unknown): string {
  const message = stripVTControlCharacters(error instanceof Error ? error.message : String(error));
  const [head = "", log = ""] = message.split("\nCall log:");
  const headline = head.trim().replace(/^[\w.]+: /, "").replace(/\.$/, "");
  const state = log
    .split("\n")
    .map((line) => line.trim().replace(/^-\s*/, ""))
    .findLast((line) => line.startsWith("element ") || line.includes("intercepts pointer events"));
  return state === undefined ? headline : `${headline} (${state})`;
}

async function attempt<T>(what: string, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    throw new Error(`Could not ${what}: ${explain(error)}`, { cause: error });
  }
}

function productOrigin(value: string): string {
  const url = URL.parse(value);
  if (url === null || (url.protocol !== "http:" && url.protocol !== "https:")) {
    throw new Error(`the product origin must be an http or https URL, got ${JSON.stringify(value)}`);
  }
  return url.origin;
}

/** A path of the product as a URL. Anything that resolves elsewhere is refused, including `//host` and `/\host`. */
function productUrl(origin: string, path: string): URL {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new Error(`open_page takes a path of the product starting with a single "/", such as /todos, not ${JSON.stringify(path)}; other sites cannot be opened.`);
  }
  const url = new URL(path, origin);
  if (url.origin !== origin) throw new Error(`${JSON.stringify(path)} leads outside the product at ${origin}; open a path of the product itself.`);
  return url;
}

function currentLocation(driver: Driver): Location {
  const url = new URL(driver.page.url());
  return { href: url.href, onProduct: url.origin === driver.origin, path: `${url.pathname}${url.search}` };
}

function outsideTheProduct(location: Location, origin: string): string {
  if (location.href === "about:blank") return "No page of the product is open.";
  if (location.href.startsWith("chrome-error:")) return "The last page failed to load, so no page of the product is showing.";
  return `The page is at ${location.href}, outside the product at ${origin}.`;
}

/** Where the page is, or the error a live tool answers with when that is not the product. */
function requireProduct(driver: Driver): Location {
  const location = currentLocation(driver);
  if (!location.onProduct) throw new Error(`${outsideTheProduct(location, driver.origin)}${RETURN_ADVICE}`);
  return location;
}

function landing(driver: Driver): string {
  const location = currentLocation(driver);
  return location.onProduct ? `The page is now ${location.path}.` : `${outsideTheProduct(location, driver.origin)}${RETURN_ADVICE}`;
}

async function openPath(driver: Driver, path: string, signal: AbortSignal | undefined): Promise<{ opened: string; status: number | null }> {
  const url = productUrl(driver.origin, path);
  const opened = `${url.pathname}${url.search}${url.hash}`;
  const response = await attempt(`open ${opened}`, () => driver.act(() => driver.goto(url.href, signal), signal));
  return { opened, status: response?.status() ?? null };
}

/**
 * The element a person would mean by this role and name. Playwright matches
 * the name case-insensitively as a part of the accessible name; when several
 * elements match, the one whose whole name it is wins, else the first, and the
 * returned note says which was used.
 */
async function find(
  driver: Driver,
  role: string,
  name: string,
  appearMs: number,
  signal: AbortSignal | undefined,
): Promise<{ target: Locator; note: string | null }> {
  const byRole = (accessibleName: string | RegExp) => driver.page.getByRole(role as Parameters<Page["getByRole"]>[0], { name: accessibleName });
  const matches = byRole(name);
  const quoted = JSON.stringify(name);
  try {
    await matches.first().waitFor({ state: "attached", ...within(appearMs, signal) });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") throw new Error(await missingElement(driver, role, name, signal), { cause: error });
    throw new Error(`Could not look for ${role} ${quoted}: ${explain(error)}`, { cause: error });
  }
  const count = await matches.count();
  if (count === 1) return { target: matches.first(), note: null };
  const exact = byRole(wholeName(name));
  const exactCount = await exact.count();
  if (exactCount === 0) {
    return { target: matches.first(), note: `${count} ${role} elements match ${quoted} and none is named exactly that, so the first was used; give its whole name to pick another.` };
  }
  return { target: exact.first(), note: `${count} ${role} elements match ${quoted}; the one named exactly that was used${exactCount > 1 ? `, the first of ${exactCount}` : ""}.` };
}

/** What the model needs to correct a name: the elements of that role that are there, or the roles that are. */
async function missingElement(driver: Driver, role: string, name: string, signal: AbortSignal | undefined): Promise<string> {
  const where = currentLocation(driver).path;
  const quoted = JSON.stringify(name);
  let snapshot: string;
  try {
    snapshot = await driver.page.locator("body").ariaSnapshot(within(ELEMENT_TIMEOUT_MS, signal));
  } catch (error) {
    return `No ${role} named ${quoted} is on ${where}, and the page could not be read to list what is there: ${explain(error)}`;
  }
  const nodes = parseAriaSnapshot(snapshot);
  const sameRole = nodes.filter((node) => node.role.toLowerCase() === role);
  if (sameRole.length > 0) {
    const listed = sameRole
      .slice(0, LISTED_ELEMENTS)
      .map((node) => `- ${node.role}${node.name === "" ? " (no name)" : ` ${JSON.stringify(node.name)}`}`);
    if (sameRole.length > LISTED_ELEMENTS) listed.push(`- and ${sameRole.length - LISTED_ELEMENTS} more`);
    return `No ${role} named ${quoted} is on ${where}; a name matches when it is part of the element's name, in any case. The ${role} elements there are:\n${listed.join("\n")}`;
  }
  const roles = [...new Set(nodes.map((node) => node.role).filter((found) => found !== "text"))];
  const present = roles.length > 0 ? `The roles there are: ${roles.join(", ")}.` : "The page shows no elements at all.";
  return `No element with role ${JSON.stringify(role)} is on ${where}. ${present} Take a snapshot to see the page.`;
}

/** The name as an element's whole accessible name, in any case: what "named exactly that" means here. */
function wholeName(name: string): RegExp {
  const words = name.trim().replaceAll(/\s+/g, " ").replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${words}$`, "i");
}

async function clickElement(driver: Driver, role: string, name: string, appearMs: number, signal: AbortSignal | undefined): Promise<string | null> {
  const { target, note } = await find(driver, role, name, appearMs, signal);
  await attempt(`click ${role} ${JSON.stringify(name)}`, () => driver.act(() => target.click(within(ELEMENT_TIMEOUT_MS, signal)), signal));
  return note;
}

async function fillElement(driver: Driver, role: string, name: string, value: string, appearMs: number, signal: AbortSignal | undefined): Promise<string | null> {
  const { target, note } = await find(driver, role, name, appearMs, signal);
  await attempt(`fill ${role} ${JSON.stringify(name)}`, () => driver.act(() => target.fill(value, within(ELEMENT_TIMEOUT_MS, signal)), signal));
  return note;
}

async function pressKey(driver: Driver, key: string, signal: AbortSignal | undefined): Promise<void> {
  const focused = driver.page.locator("*:focus");
  await attempt(`press ${key}`, () => driver.act(async () => {
    // Through the focused element, Playwright waits for a navigation the key
    // starts (Enter submitting a form), as it does for a click; the keyboard
    // alone would return before the new page has even been requested.
    if ((await focused.count()) > 0) await focused.first().press(key, within(ELEMENT_TIMEOUT_MS, signal));
    else await driver.page.keyboard.press(key);
  }, signal));
}

/** The page's accessibility tree, discarded when the page moved while it was read. */
async function capture(driver: Driver, signal: AbortSignal | undefined): Promise<string> {
  const before = driver.page.url();
  const text = await attempt("capture the page", () => driver.page.locator("body").ariaSnapshot(within(ELEMENT_TIMEOUT_MS, signal)));
  if (driver.page.url() !== before) throw new Error("The page navigated while it was being captured, so the capture was discarded.");
  return text;
}

async function prepare(input: BrowserSessionInput, scenarioId: string): Promise<{ ok: true } | { ok: false; detail: string }> {
  try {
    return await input.seed(scenarioId);
  } catch (error) {
    // A seed that throws has failed as surely as one that says so; the
    // scenario is reported unprepared and the session goes on.
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

/** Head and tail of a long output: failures tend to be printed first, and the summary last. */
function shownOutput(output: string, id: string): string {
  if (output.length <= OUTPUT_SHOWN_CHARS) return output;
  const half = OUTPUT_SHOWN_CHARS / 2;
  return `${output.slice(0, half)}\n[... ${output.length - OUTPUT_SHOWN_CHARS} characters omitted here; ${id} keeps the whole output ...]\n${output.slice(-half)}`;
}

/** Runs tasks one at a time in call order: one page takes one action at a time, and evidence ids follow the calls. */
function serialQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task);
    // Each caller awaits its own task's outcome; the queue only waits for it to be over.
    tail = run.catch(() => undefined);
    return run;
  };
}

const elementArguments = {
  role: z
    .string()
    .regex(/^[A-Za-z-]+$/, "an ARIA role is one word, such as button or textbox")
    .describe("The element's ARIA role as a snapshot lists it: button, link, checkbox, radio, tab, menuitem, option, ..."),
  name: z.string().describe("The element's accessible name as a snapshot lists it, or a part of it."),
};

export const openEvaluatorBrowser: OpenEvaluatorBrowser = async (input) => {
  const driver = await launch(productOrigin(input.origin));
  const evidence = new Map<string, CapturedEvidence>();
  const recordings = new Map<string, RecordedStep[]>();
  const taken = { snapshot: 0, screenshot: 0, output: 0 };
  /** Keeps the screenshot files of two sessions sharing one directory apart. */
  const fileTag = new Date().toISOString().replaceAll(/[-:.]/g, "");
  const serially = serialQueue();
  let current: string | null = null;
  let closed = false;

  const record = (step: ReplayStep, snapshotPath: string | null = null): void => {
    if (current !== null) recordings.get(current)?.push({ step, snapshotPath });
  };
  const reply = (...lines: (string | null)[]): ToolOutput => ({
    text: [...lines, ...driver.takeNotices()].filter((line) => line !== null).join("\n"),
  });

  function tool<Args>(
    name: string,
    description: string,
    schema: z.ZodType<Args>,
    run: (args: Args, signal: AbortSignal | undefined) => Promise<ToolOutput>,
  ): ToolSpec {
    const parameters = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
    delete parameters.$schema;
    return {
      name,
      description,
      parameters,
      execute: (args, signal) => serially(async () => {
        if (closed) throw new Error("This browser session is closed.");
        signal?.throwIfAborted();
        const parsed = schema.safeParse(args);
        if (!parsed.success) throw new Error(`The arguments of ${name} are not valid; fix them and call it again:\n${z.prettifyError(parsed.error)}`);
        return run(parsed.data, signal);
      }),
    };
  }

  const tools: readonly ToolSpec[] = [
    tool(
      "begin_scenario",
      "Start one scenario: run the fixture it declares, blank the page and start recording. Everything you do until your last snapshot is replayed later without you, from a blank page, so first open the page the scenario starts on. Beginning a scenario again starts its recording over.",
      z.object({ scenario_id: z.string().min(1).describe("The scenario's id from the contract, such as A1.1.") }).strict(),
      async ({ scenario_id: scenarioId }, signal) => {
        // Every scenario starts where its replay will, so no evidence rests on a
        // page a previous scenario left open, and a reopen is a real reload.
        // A blank page starts nothing, so there is nothing to wait for.
        await attempt("blank the page", () => driver.goto("about:blank", signal));
        driver.takeNotices();
        const prepared = await prepare(input, scenarioId);
        current = scenarioId;
        recordings.set(scenarioId, []);
        const recording = "The page is blank: open the page the scenario starts on with open_page. Every step from here to your last snapshot is recorded and replayed later without you.";
        return {
          text: prepared.ok
            ? `Scenario ${scenarioId} begins; its seed ran. ${recording}`
            : `Scenario ${scenarioId} could not be prepared: its seed failed: ${prepared.detail}\n${recording} The data the scenario assumes may be missing.`,
        };
      },
    ),
    tool(
      "open_page",
      "Open a page of the product by its path, such as /todos or /todos?filter=done, and wait for it to load. Only the product's own pages can be opened. Answers with the HTTP status and the page title.",
      z.object({ path: z.string().describe("A path starting with a single /, never a full URL.") }).strict(),
      async ({ path }, signal) => {
        const { opened, status } = await openPath(driver, path, signal);
        record({ action: "open", path: opened });
        const answer = status === null ? "no HTTP response (the document did not change)" : `HTTP ${status}`;
        return reply(`Opened ${opened}: ${answer}, title ${JSON.stringify(await driver.page.title())}.`, landing(driver));
      },
    ),
    tool(
      "click",
      "Click an element named the way a snapshot lists it: for `- button \"Add todo\"` the role is button and the name is Add todo. The name matches when it is part of the element's accessible name, in any case; when several elements match, the one named exactly that is used, else the first.",
      z.object(elementArguments).strict(),
      async ({ role, name }, signal) => {
        const target = role.trim().toLowerCase();
        requireProduct(driver);
        const note = await clickElement(driver, target, name, LIVE_APPEAR_MS, signal);
        record({ action: "click", role: target, name });
        return reply(`Clicked ${target} ${JSON.stringify(name)}.`, note, landing(driver));
      },
    ),
    tool(
      "fill",
      "Replace the text of a field, named the way a snapshot lists it (role and accessible name, matched as for click).",
      z.object({
        role: elementArguments.role.describe("The field's ARIA role, usually textbox, searchbox, spinbutton or combobox."),
        name: elementArguments.name,
        value: z.string().describe("The text the field should hold afterwards."),
      }).strict(),
      async ({ role, name, value }, signal) => {
        const target = role.trim().toLowerCase();
        requireProduct(driver);
        const note = await fillElement(driver, target, name, value, LIVE_APPEAR_MS, signal);
        record({ action: "fill", role: target, name, value });
        return reply(`Filled ${target} ${JSON.stringify(name)}.`, note, landing(driver));
      },
    ),
    tool(
      "press",
      "Press a key on the element that has focus, or on the page when nothing has: Enter, Tab, Escape, ArrowDown, or a chord such as Control+A.",
      z.object({ key: z.string().min(1).describe("A key as Playwright names it: Enter, Tab, Escape, ArrowDown, Backspace, a, Control+A.") }).strict(),
      async ({ key }, signal) => {
        requireProduct(driver);
        await pressKey(driver, key, signal);
        record({ action: "press", key });
        return reply(`Pressed ${key}.`, landing(driver));
      },
    ),
    tool(
      "snapshot",
      "Capture the accessibility tree of the current page as evidence S<n>. A scenario passes only by citing a snapshot taken on its page that shows everything it expects, so take one there once the page shows the outcome.",
      z.object({}).strict(),
      async (_args, signal) => {
        const location = requireProduct(driver);
        const text = await capture(driver, signal);
        taken.snapshot += 1;
        const id = `S${taken.snapshot}`;
        evidence.set(id, { id, kind: "snapshot", scenarioId: current, path: location.path, text });
        record({ action: "snapshot" }, location.path);
        return reply(`Snapshot ${id} of ${location.path}:`, text);
      },
    ),
    tool(
      "screenshot",
      "Capture a full-page screenshot as evidence P<n>, for judging layout by eye. A screenshot never proves a scenario; cite a snapshot for that.",
      z.object({}).strict(),
      async (_args, signal) => {
        const location = requireProduct(driver);
        const id = `P${taken.screenshot + 1}`;
        await mkdir(input.artifactsDir, { recursive: true });
        const file = resolve(input.artifactsDir, `${fileTag}-${id}.png`);
        const image = await attempt("take a screenshot", () => driver.page.screenshot({ fullPage: true, path: file, ...within(NAVIGATION_TIMEOUT_MS, signal) }));
        taken.screenshot += 1;
        evidence.set(id, { id, kind: "screenshot", scenarioId: current, path: location.path, file });
        return { ...reply(`Screenshot ${id} of ${location.path}.`), images: [{ data: image.toString("base64"), mimeType: "image/png" }] };
      },
    ),
    tool(
      "run_command",
      "Run a command-line scenario's command in the product's worktree and capture its output as evidence O<n>, the evidence a command-line scenario cites.",
      z.object({ command: z.string().min(1).describe("The command exactly as the scenario gives it.") }).strict(),
      async ({ command }) => {
        const result = await input.runCommand(command);
        taken.output += 1;
        const id = `O${taken.output}`;
        evidence.set(id, { id, kind: "output", scenarioId: current, command, text: result.output });
        const exit = result.code === null ? "it did not exit on its own: killed or timed out" : `exit code ${result.code}`;
        return { text: `Output ${id} of ${command} (${exit}):\n${shownOutput(result.output, id)}` };
      },
    ),
  ];

  return {
    tools: () => tools,
    evidence: () => new Map(evidence),
    script(scenarioId) {
      const recorded = recordings.get(scenarioId) ?? [];
      const last = recorded.findLastIndex((entry) => entry.snapshotPath !== null);
      const judgedOn = recorded[last]?.snapshotPath;
      if (judgedOn === undefined || judgedOn === null) return null;
      return {
        scenarioId,
        page: judgedOn.split("?")[0] ?? judgedOn,
        steps: structuredClone(recorded.slice(0, last + 1).map((entry) => entry.step)),
      };
    },
    close() {
      closed = true;
      return driver.close();
    },
  };
};

function describeStep(step: ReplayStep): string {
  switch (step.action) {
    case "open":
      return `open ${step.path}`;
    case "click":
      return `click ${step.role} ${JSON.stringify(step.name)}`;
    case "fill":
      return `fill ${step.role} ${JSON.stringify(step.name)}`;
    case "press":
      return `press ${step.key}`;
    case "snapshot":
      return "snapshot";
  }
}

/** A path the way a verdict binds a snapshot to its page: without the query and without a trailing slash. */
function barePath(value: string): string {
  const withoutQuery = value.split(/[?#]/)[0] ?? value;
  return withoutQuery.length > 1 ? withoutQuery.replace(/\/+$/, "") : withoutQuery;
}

/**
 * Repeats a recorded scenario in a browser of its own and hands back the last
 * snapshot for the caller to judge. A step that cannot be taken, a page that
 * left the product, or a last snapshot taken anywhere but the script's page is
 * a result; a browser that cannot start throws.
 */
export const replayScript: ReplayScriptRunner = async ({ origin, script }) => {
  const driver = await launch(productOrigin(origin));
  try {
    let last: { text: string; path: string } | null = null;
    for (const [index, step] of script.steps.entries()) {
      const failed = (reason: string) => ({ ok: false as const, detail: `step ${index + 1} of ${script.steps.length} (${describeStep(step)}) failed: ${reason}` });
      const location = currentLocation(driver);
      if (step.action !== "open" && !location.onProduct) return failed(outsideTheProduct(location, driver.origin));
      try {
        if (step.action === "open") await openPath(driver, step.path, undefined);
        else if (step.action === "click") await clickElement(driver, step.role, step.name, ELEMENT_TIMEOUT_MS, undefined);
        else if (step.action === "fill") await fillElement(driver, step.role, step.name, step.value, ELEMENT_TIMEOUT_MS, undefined);
        else if (step.action === "press") await pressKey(driver, step.key, undefined);
        else last = { text: await capture(driver, undefined), path: location.path };
      } catch (error) {
        return failed(error instanceof Error ? error.message : String(error));
      }
    }
    if (last === null) return { ok: false, detail: "the script has no snapshot step, so the replay has nothing to show" };
    if (barePath(last.path) !== barePath(script.page)) {
      return { ok: false, detail: `the final snapshot was taken on ${last.path}, not on ${script.page}, the page the scenario is judged on` };
    }
    return { ok: true, snapshot: last.text };
  } finally {
    await driver.close();
  }
};
