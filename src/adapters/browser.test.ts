import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { matchVisible } from "../gates/evidence.ts";
import type { CapturedEvidence, EvaluatorBrowser, ReplayScript, ReplayStep, ToolOutput } from "../ports.ts";
import { openEvaluatorBrowser, replayScript } from "./browser.ts";

const runFile = promisify(execFile);

interface Site {
  origin: string;
  close(): Promise<void>;
}

async function serve(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<Site> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the test server has no port");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/**
 * A server-rendered todo list kept in `todos`: the form posts and redirects
 * back, as a product without client code does. /broken drops the connection.
 */
function todoApp(todos: string[], elsewhere: string) {
  return (request: IncomingMessage, response: ServerResponse): void => {
    const url = new URL(request.url ?? "/", "http://product.test");
    if (request.method === "POST" && url.pathname === "/todos") {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.on("end", () => {
        const title = new URLSearchParams(body).get("title")?.trim() ?? "";
        if (title !== "") todos.push(title);
        response.writeHead(303, { location: "/todos" }).end();
      });
      return;
    }
    if (url.pathname === "/broken") {
      request.socket.destroy();
      return;
    }
    if (url.pathname !== "/todos") {
      response.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Todos</title></head><body>
<h1>Todos</h1>
<form method="post" action="/todos">
  <label for="new-todo">New todo</label> <input id="new-todo" name="title" autocomplete="off">
  <button type="submit">Add</button> <button type="button">Add later</button>
</form>
<ul>${todos.map((todo) => `<li>${escapeHtml(todo)}</li>`).join("")}</ul>
<button type="button" onclick="document.getElementById('status').textContent = confirm('Archive everything?') ? 'Archived' : 'Kept'">Archive</button>
<p id="status"></p>
<a href="/todos?from=help" target="_blank">Help</a>
<a href="${elsewhere}/">Elsewhere</a>
</body></html>`);
  };
}

async function elsewhereSite(): Promise<Site> {
  return serve((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<!doctype html><title>Elsewhere</title><h1>Somewhere else</h1>");
  });
}

function caller(browser: EvaluatorBrowser): (name: string, args?: unknown) => Promise<ToolOutput> {
  const tools = new Map(browser.tools().map((tool) => [tool.name, tool]));
  return async (name, args = {}) => {
    const tool = tools.get(name);
    if (tool === undefined) throw new Error(`there is no tool ${name}`);
    return tool.execute(args);
  };
}

function idIn(text: string, kind: "S" | "P" | "O"): string {
  const id = new RegExp(`\\b(${kind}\\d+)\\b`).exec(text)?.[1];
  if (id === undefined) throw new Error(`no ${kind} id in: ${text}`);
  return id;
}

function snapshotText(item: CapturedEvidence | undefined): string {
  if (item?.kind !== "snapshot") throw new Error(`not a snapshot: ${JSON.stringify(item)}`);
  return item.text;
}

/**
 * Browser processes started by this test process and not yet reaped. Only the
 * parent pid and the executable name are read: command lines and
 * environments stay out of the test output.
 */
async function browserProcesses(): Promise<string[]> {
  const { stdout } = await runFile("ps", ["-A", "-o", "ppid=,comm="]);
  return stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter(([parent, ...command]) => parent === String(process.pid) && /chrom|headless/i.test(command.join(" ")))
    .map((fields) => fields.slice(1).join(" "));
}

const NO_COMMANDS = async () => ({ code: 0, output: "" });

function script(steps: ReplayStep[], page = "/todos"): ReplayScript {
  return { scenarioId: "A1.1", page, steps };
}

const openTodos: ReplayStep = { action: "open", path: "/todos" };

describe("openEvaluatorBrowser", () => {
  const todos: string[] = [];
  const seeded: string[] = [];
  let elsewhere: Site;
  let app: Site;
  let workspace: string;
  let artifactsDir: string;
  let browser: EvaluatorBrowser;
  let call: (name: string, args?: unknown) => Promise<ToolOutput>;

  beforeAll(async () => {
    elsewhere = await elsewhereSite();
    app = await serve(todoApp(todos, elsewhere.origin));
    workspace = await mkdtemp(join(tmpdir(), "hivemind-browser-"));
    artifactsDir = join(workspace, "evidence", "round-1");
    browser = await openEvaluatorBrowser({
      origin: app.origin,
      artifactsDir,
      async seed(scenarioId) {
        seeded.push(scenarioId);
        if (scenarioId === "A9.1") return { ok: false, detail: "fixture todos.json is missing" };
        if (scenarioId === "A9.2") throw new Error("the seed command crashed");
        todos.length = 0;
        return { ok: true };
      },
      async runCommand(command) {
        if (command === "long") return { code: 0, output: `${"x".repeat(30_000)}END` };
        return { code: command === "fail" ? 2 : 0, output: `ran ${command}` };
      },
    });
    call = caller(browser);
  });

  afterAll(async () => {
    await browser?.close();
    await app?.close();
    await elsewhere?.close();
    if (workspace !== undefined) await rm(workspace, { recursive: true, force: true });
  });

  it("captures the page a scenario ends on and records steps that replay it on a reset product", async () => {
    const begun = await call("begin_scenario", { scenario_id: "A1.1" });
    expect(begun.text).toContain("Scenario A1.1 begins; its seed ran.");
    expect(seeded).toEqual(["A1.1"]);

    const opened = await call("open_page", { path: "/todos" });
    expect(opened.text).toContain('Opened /todos: HTTP 200, title "Todos".');
    await call("fill", { role: "textbox", name: "New todo", value: "Buy milk" });
    const added = await call("click", { role: "button", name: "Add" });
    expect(added.text).toContain("The page is now /todos.");
    const shown = await call("snapshot");

    expect(shown.text).toMatch(/^Snapshot S1 of \/todos:\n/);
    const captured = browser.evidence().get("S1");
    expect(captured).toMatchObject({ id: "S1", kind: "snapshot", scenarioId: "A1.1", path: "/todos" });
    expect(shown.text).toContain(snapshotText(captured));
    expect(matchVisible(snapshotText(captured), [{ role: "heading", text: "Todos" }, { role: "listitem", text: "Buy milk" }]))
      .toEqual({ ok: true, missing: [] });

    const recorded = browser.script("A1.1");
    expect(recorded).toEqual({
      scenarioId: "A1.1",
      page: "/todos",
      steps: [
        { action: "open", path: "/todos" },
        { action: "fill", role: "textbox", name: "New todo", value: "Buy milk" },
        { action: "click", role: "button", name: "Add" },
        { action: "snapshot" },
      ],
    });
    if (recorded === null) return;

    todos.length = 0;
    expect(await (await fetch(`${app.origin}/todos`)).text()).not.toContain("Buy milk");
    const replayed = await replayScript({ origin: app.origin, script: recorded });
    expect(replayed).toMatchObject({ ok: true });
    expect(todos).toEqual(["Buy milk"]);
    expect(matchVisible(replayed.ok ? replayed.snapshot : "", [{ role: "listitem", text: "Buy milk" }]).ok).toBe(true);
  });

  it("numbers evidence in capture order and ends a scenario's script at its last snapshot", async () => {
    await call("begin_scenario", { scenario_id: "A1.2" });
    await expect(call("snapshot")).rejects.toThrow("No page of the product is open.");
    await call("open_page", { path: "/todos?view=compact" });
    const first = idIn((await call("snapshot")).text, "S");
    expect(browser.evidence().get(first)).toMatchObject({ kind: "snapshot", scenarioId: "A1.2", path: "/todos?view=compact" });
    await call("fill", { role: "textbox", name: "New todo", value: "after the snapshot" });
    expect(browser.script("A1.2")).toEqual({
      scenarioId: "A1.2",
      page: "/todos",
      steps: [{ action: "open", path: "/todos?view=compact" }, { action: "snapshot" }],
    });

    const second = idIn((await call("snapshot")).text, "S");
    expect(Number(second.slice(1))).toBe(Number(first.slice(1)) + 1);
    expect(browser.script("A1.2")?.steps.map((step) => step.action)).toEqual(["open", "snapshot", "fill", "snapshot"]);

    await call("begin_scenario", { scenario_id: "A1.2" });
    expect(browser.script("A1.2")).toBeNull();
    expect(browser.evidence().has(second)).toBe(true);
    expect(browser.script("A7.7")).toBeNull();
  });

  it("opens only the product's own pages and captures nothing once a click has left it", async () => {
    await call("begin_scenario", { scenario_id: "A2.1" });
    for (const path of [`${elsewhere.origin}/`, "https://example.com/", "//example.com/", "/\\example.com/", "todos"]) {
      await expect(call("open_page", { path }), path).rejects.toThrow(/other sites cannot be opened|leads outside the product/);
    }
    await call("open_page", { path: "/todos" });
    const left = await call("click", { role: "link", name: "Elsewhere" });
    expect(left.text).toContain(`The page is at ${elsewhere.origin}/, outside the product at ${app.origin}. Use open_page`);
    await expect(call("snapshot")).rejects.toThrow("outside the product");
    await expect(call("screenshot")).rejects.toThrow("outside the product");
    await expect(call("click", { role: "heading", name: "Somewhere else" })).rejects.toThrow("outside the product");

    await call("open_page", { path: "/todos" });
    await call("snapshot");
    expect(browser.script("A2.1")?.steps).toEqual([
      { action: "open", path: "/todos" },
      { action: "click", role: "link", name: "Elsewhere" },
      { action: "open", path: "/todos" },
      { action: "snapshot" },
    ]);
    const captured = [...browser.evidence().values()].filter((item) => item.kind === "snapshot");
    expect(captured.every((item) => !snapshotText(item).includes("Somewhere else"))).toBe(true);
  });

  it("opens the next page after one that failed to load", async () => {
    await call("begin_scenario", { scenario_id: "A2.2" });
    for (let round = 0; round < 2; round += 1) {
      await expect(call("open_page", { path: "/broken" })).rejects.toThrow("Could not open /broken: net::ERR_");
      expect((await call("open_page", { path: "/todos" })).text).toContain("HTTP 200");
    }
  });

  it("lists the elements of a role when no name matches, and records nothing for the miss", async () => {
    await call("begin_scenario", { scenario_id: "A3.1" });
    await call("open_page", { path: "/todos" });
    await expect(call("click", { role: "button", name: "Remove" })).rejects.toThrow(
      'No button named "Remove" is on /todos; a name matches when it is part of the element\'s name, in any case. The button elements there are:\n'
      + '- button "Add"\n- button "Add later"\n- button "Archive"',
    );
    await expect(call("fill", { role: "combobox", name: "Todo", value: "x" })).rejects.toThrow(
      /^No element with role "combobox" is on \/todos\. The roles there are: heading, textbox, button, .*link\. Take a snapshot/,
    );
    await call("snapshot");
    expect(browser.script("A3.1")?.steps).toEqual([{ action: "open", path: "/todos" }, { action: "snapshot" }]);
  });

  it("uses the element named exactly when several match, and says which it used", async () => {
    await call("begin_scenario", { scenario_id: "A3.2" });
    await call("open_page", { path: "/todos" });
    await call("fill", { role: "textbox", name: "new", value: "Walk the dog" });
    const exact = await call("click", { role: "Button", name: "add" });
    expect(exact.text).toContain('2 button elements match "add"; the one named exactly that was used.');
    expect(todos).toEqual(["Walk the dog"]);
    const first = await call("click", { role: "button", name: "dd" });
    expect(first.text).toContain('2 button elements match "dd" and none is named exactly that, so the first was used');
    await call("snapshot");
    expect(browser.script("A3.2")?.steps).toContainEqual({ action: "click", role: "button", name: "add" });
  });

  it("presses a key on the focused element and waits for the page it leads to", async () => {
    await call("begin_scenario", { scenario_id: "A3.3" });
    await call("open_page", { path: "/todos" });
    await call("fill", { role: "textbox", name: "New todo", value: "Water the plants" });
    expect((await call("press", { key: "Enter" })).text).toBe("Pressed Enter.\nThe page is now /todos.");
    expect(todos).toEqual(["Water the plants"]);
    const id = idIn((await call("snapshot")).text, "S");
    expect(matchVisible(snapshotText(browser.evidence().get(id)), [{ role: "listitem", text: "Water the plants" }]).ok).toBe(true);
    expect(browser.script("A3.3")?.steps).toContainEqual({ action: "press", key: "Enter" });
  });

  it("accepts a dialog and closes a new tab, and says so", async () => {
    await call("begin_scenario", { scenario_id: "A3.4" });
    await call("open_page", { path: "/todos" });
    const archived = await call("click", { role: "button", name: "Archive" });
    expect(archived.text).toContain('The page showed a confirm dialog saying "Archive everything?"; it was accepted');
    const help = await call("click", { role: "link", name: "Help" });
    const shown = await call("snapshot");
    // The tab can report itself after the click has returned; then the next result carries the notice.
    expect(`${help.text}\n${shown.text}`).toContain("That opened a new tab at /todos?from=help, which was closed");
    expect(help.text).toContain("The page is now /todos.");
    expect(matchVisible(snapshotText(browser.evidence().get(idIn(shown.text, "S"))), [{ text: "Archived" }]).ok).toBe(true);
  });

  it("reports a seed that failed or threw as a scenario that could not be prepared", async () => {
    const failed = await call("begin_scenario", { scenario_id: "A9.1" });
    expect(failed.text).toContain("Scenario A9.1 could not be prepared: its seed failed: fixture todos.json is missing");
    const crashed = await call("begin_scenario", { scenario_id: "A9.2" });
    expect(crashed.text).toContain("Scenario A9.2 could not be prepared: its seed failed: the seed command crashed");
    await call("open_page", { path: "/todos" });
    const id = idIn((await call("snapshot")).text, "S");
    expect(browser.evidence().get(id)?.scenarioId).toBe("A9.2");
  });

  it("keeps a command's whole output as evidence and shows the model a bounded copy", async () => {
    await call("begin_scenario", { scenario_id: "A4.1" });
    const long = await call("run_command", { command: "long" });
    const id = idIn(long.text, "O");
    expect(long.text).toMatch(new RegExp(`^Output ${id} of long \\(exit code 0\\):\\n`));
    expect(long.text.length).toBeLessThan(21_000);
    expect(long.text).toContain(`characters omitted here; ${id} keeps the whole output`);
    expect(long.text.endsWith("END")).toBe(true);
    expect(browser.evidence().get(id)).toEqual({ id, kind: "output", scenarioId: "A4.1", command: "long", text: `${"x".repeat(30_000)}END` });
    expect((await call("run_command", { command: "fail" })).text).toBe(`Output O${Number(id.slice(1)) + 1} of fail (exit code 2):\nran fail`);
    expect(browser.script("A4.1")).toBeNull();
  });

  it("writes a full-page screenshot into the artifacts directory and hands the image to the model", async () => {
    await call("begin_scenario", { scenario_id: "A5.1" });
    await call("open_page", { path: "/todos" });
    const shot = await call("screenshot");
    const id = idIn(shot.text, "P");
    const stored = browser.evidence().get(id);
    expect(stored).toMatchObject({ id, kind: "screenshot", scenarioId: "A5.1", path: "/todos" });
    const file = stored?.kind === "screenshot" ? stored.file : "";
    expect(file.startsWith(`${artifactsDir}/`)).toBe(true);
    expect((await stat(file)).size).toBeGreaterThan(0);
    expect(shot.images?.map((image) => image.mimeType)).toEqual(["image/png"]);
    expect(Buffer.from(shot.images?.[0]?.data ?? "", "base64").subarray(1, 4).toString("latin1")).toBe("PNG");
  });

  it("declares a closed schema for every tool and refuses arguments that do not fit it", async () => {
    const tools = browser.tools();
    expect(tools.map((tool) => tool.name)).toEqual(["begin_scenario", "open_page", "click", "fill", "press", "snapshot", "screenshot", "run_command"]);
    for (const tool of tools) expect(tool.parameters).toMatchObject({ type: "object", additionalProperties: false });
    expect(tools.find((tool) => tool.name === "fill")?.parameters).toMatchObject({ required: ["role", "name", "value"] });
    await expect(call("open_page", {})).rejects.toThrow("The arguments of open_page are not valid");
    await expect(call("click", { role: "button", name: "Add", force: true })).rejects.toThrow("The arguments of click are not valid");
    await expect(call("click", { role: "button[disabled]", name: "Add" })).rejects.toThrow("an ARIA role is one word");
  });
});

describe("EvaluatorBrowser.close", () => {
  it("can be called twice, leaves no browser process behind and refuses later calls", async () => {
    const before = await browserProcesses();
    const browser = await openEvaluatorBrowser({
      origin: "http://127.0.0.1:1",
      artifactsDir: tmpdir(),
      seed: async () => ({ ok: true }),
      runCommand: NO_COMMANDS,
    });
    expect((await browserProcesses()).length).toBeGreaterThan(before.length);
    await browser.close();
    await browser.close();
    expect(await browserProcesses()).toEqual(before);
    await expect(caller(browser)("open_page", { path: "/" })).rejects.toThrow("This browser session is closed.");
  });
});

describe("replayScript", () => {
  const todos: string[] = [];
  let elsewhere: Site;
  let app: Site;

  beforeAll(async () => {
    elsewhere = await elsewhereSite();
    app = await serve(todoApp(todos, elsewhere.origin));
  });

  afterAll(async () => {
    await app?.close();
    await elsewhere?.close();
  });

  it("names the step at which the page had left the product, and closes its browser", async () => {
    const before = await browserProcesses();
    const result = await replayScript({
      origin: app.origin,
      script: script([openTodos, { action: "click", role: "link", name: "Elsewhere" }, { action: "snapshot" }]),
    });
    expect(result).toEqual({
      ok: false,
      detail: `step 3 of 3 (snapshot) failed: The page is at ${elsewhere.origin}/, outside the product at ${app.origin}.`,
    });
    expect(await browserProcesses()).toEqual(before);
  });

  it("names a navigation that failed", async () => {
    const gone = await serve(() => undefined);
    await gone.close();
    const result = await replayScript({ origin: gone.origin, script: script([openTodos, { action: "snapshot" }]) });
    expect(result.ok ? "" : result.detail).toMatch(/^step 1 of 2 \(open \/todos\) failed: Could not open \/todos: net::ERR_CONNECTION_REFUSED/);
  });

  it("holds the final snapshot to the script's page, ignoring the query and a trailing slash", async () => {
    const matched = await replayScript({ origin: app.origin, script: script([{ action: "open", path: "/todos?view=all" }, { action: "snapshot" }], "/todos/") });
    expect(matched).toMatchObject({ ok: true });
    const elsewhereJudged = await replayScript({ origin: app.origin, script: script([openTodos, { action: "snapshot" }], "/archive") });
    expect(elsewhereJudged).toEqual({
      ok: false,
      detail: "the final snapshot was taken on /todos, not on /archive, the page the scenario is judged on",
    });
  });

  it("has nothing to show for a script without a snapshot", async () => {
    expect(await replayScript({ origin: app.origin, script: script([openTodos]) })).toEqual({
      ok: false,
      detail: "the script has no snapshot step, so the replay has nothing to show",
    });
  });
});
