import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  describeDesignLintFindings,
  parseDesignLint,
  runDesignLint,
  type DesignLintProcess,
} from "./design-lint.js";

const FIXTURES = fileURLToPath(new URL("../../fixtures/design-lint/", import.meta.url));

function capture(name: string): string {
  return readFileSync(`${FIXTURES}${name}`, "utf8");
}

/** The directory the capture was taken in, read out of the capture itself
 * rather than written down: the tool prints absolute paths. */
function capturedRoot(payload: string): string {
  return dirname((JSON.parse(payload) as Array<{ file: string }>)[0]!.file);
}

function scan(process: Partial<DesignLintProcess>) {
  const run = vi.fn(async () => ({ code: 0, stdout: "[]", stderr: "", ...process }));
  return { run, scan: (files: string[] = ["pages/board.html"]) => runDesignLint({
    binary: "impeccable", root: "/repo/docs/prototype", files, run,
  }) };
}

describe("parseDesignLint", () => {
  it("reads the findings a real scan printed, keyed by rule and page", () => {
    const payload = capture("findings-exit-2.json");
    const outcome = parseDesignLint(payload, capturedRoot(payload));

    expect(outcome.kind).toBe("ran");
    const findings = outcome.kind === "ran" ? outcome.findings : [];
    expect([...new Set(findings.map((finding) => finding.rule))]).toEqual([
      "ai-color-palette",
      "flat-type-hierarchy",
      "low-contrast",
      "overused-font",
      "skipped-heading",
    ]);
    expect([...new Set(findings.map((finding) => finding.file))]).toEqual(["bad.html"]);
  });

  it("reads a clean scan as a scan with nothing in it", () => {
    expect(parseDesignLint(capture("clean-exit-0.json"), "/repo")).toEqual({ kind: "ran", findings: [] });
  });

  it("keeps the absolute path when the file was not under the scan root", () => {
    const outcome = parseDesignLint(
      JSON.stringify([{ antipattern: "overused-font", file: "/elsewhere/x.html", name: "n", snippet: "s" }]),
      "/repo",
    );

    expect(outcome.kind === "ran" && outcome.findings[0]!.file).toBe("/elsewhere/x.html");
  });

  it("names the page the way the caller asked for it, not the way the host resolved it", () => {
    const outcome = parseDesignLint(
      JSON.stringify([{ antipattern: "low-contrast", file: "/private/var/t/x/pages/board.html", name: "n", snippet: "s" }]),
      "/var/t/x",
      ["pages/board.html"],
    );

    expect(outcome.kind === "ran" && outcome.findings[0]!.file).toBe("pages/board.html");
  });

  it("drops a row that names no rule or no page, rather than inventing a key for it", () => {
    const outcome = parseDesignLint(
      JSON.stringify([{ name: "no rule", file: "/repo/a.html" }, { antipattern: "r", name: "no file" }]),
      "/repo",
    );

    expect(outcome).toEqual({ kind: "ran", findings: [] });
  });

  it("says the output was unusable rather than reporting a clean page", () => {
    expect(parseDesignLint("not json", "/repo").kind).toBe("unavailable");
    expect(parseDesignLint('{"findings":[]}', "/repo").kind).toBe("unavailable");
  });
});

describe("runDesignLint", () => {
  it("runs the scan the same way on every host, and never reads the target repository's own config", async () => {
    const scanner = scan({ code: 0, stdout: "[]" });
    await scanner.scan(["pages/board.html", "pages/card.html"]);

    expect(scanner.run).toHaveBeenCalledWith({
      binary: "impeccable",
      args: ["detect", "--json", "--no-config", "pages/board.html", "pages/card.html"],
      cwd: "/repo/docs/prototype",
    });
  });

  it("treats the findings exit code as a scan that ran, because findings never refuse a prototype", async () => {
    const payload = capture("findings-exit-2.json");
    const outcome = await runDesignLint({
      binary: "impeccable",
      root: capturedRoot(payload),
      files: ["bad.html"],
      run: async () => ({ code: 2, stdout: payload, stderr: "" }),
    });

    expect(outcome.kind === "ran" && outcome.findings.length).toBe(9);
  });

  it("says a partial scan is unavailable, so an unread page is not filed as a clean one", async () => {
    const outcome = await (scan({ code: 1, stdout: "[]", stderr: "Warning: cannot access pages/board.html\n" })).scan();

    expect(outcome).toEqual({ kind: "unavailable", reason: "Warning: cannot access pages/board.html" });
  });

  it("says so when the binary is not on this host at all", async () => {
    const outcome = await runDesignLint({
      binary: "impeccable",
      root: "/repo",
      files: ["a.html"],
      run: async () => { throw new Error("spawn impeccable ENOENT"); },
    });

    expect(outcome).toEqual({ kind: "unavailable", reason: "spawn impeccable ENOENT" });
  });

  it("does not start a scan with nothing to scan", async () => {
    const scanner = scan({});
    await expect(scanner.scan([])).resolves.toEqual({ kind: "ran", findings: [] });
    expect(scanner.run).not.toHaveBeenCalled();
  });
});

describe("describeDesignLintFindings", () => {
  it("leads with the rule, because the question these rows answer is which ones keep coming back", () => {
    expect(describeDesignLintFindings([
      { rule: "ai-color-palette", file: "pages/board.html", line: 0, what: "AI palette", detail: "Purple" },
      { rule: "skipped-heading", file: "pages/board.html", line: 12, what: "Skipped heading", detail: "h1 then h4" },
    ])).toEqual([
      "ai-color-palette pages/board.html AI palette: Purple",
      "skipped-heading pages/board.html:12 Skipped heading: h1 then h4",
    ]);
  });
});
