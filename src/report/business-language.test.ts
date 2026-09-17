import { describe, expect, it } from "vitest";
import {
  businessSection,
  lintBusinessLanguage,
  lintHumanSentence,
  renderBusinessLanguageFindings,
} from "./business-language.js";

const BUSINESS = [
  "## What changed",
  "The console now lists the cards a person is waiting on, newest first.",
  "Every scenario in the Story was verified in the browser.",
].join("\n");

describe("lintBusinessLanguage", () => {
  it("accepts a report written for a reader who does not open the code", () => {
    expect(lintBusinessLanguage(BUSINESS)).toEqual([]);
  });

  it("leaves the technical notes section alone", () => {
    const report = `${BUSINESS}\n\n## Technical notes\n\n\`\`\`sh\nnpm test\n\`\`\`\nsrc/console/data.ts:122\n`;
    expect(lintBusinessLanguage(report)).toEqual([]);
    expect(businessSection(report).trim()).toBe(BUSINESS);
  });

  it("rejects a code block in the business section", () => {
    expect(lintBusinessLanguage(`${BUSINESS}\n\n\`\`\`ts\nconst x = 1;\n\`\`\`\n`))
      .toMatchObject([{ what: "a code block" }]);
  });

  it("rejects a file path, a command and a stack frame", () => {
    const findings = lintBusinessLanguage([
      "Delivered.",
      "Changed src/console/libsql-data-source.ts.",
      "Run npm test to see it.",
      "It threw TypeError before the fix.",
    ].join("\n"));
    expect(findings.map((finding) => finding.what)).toEqual([
      "a file path",
      "a shell command",
      "an exception or stack frame",
    ]);
  });

  it("rejects a source line reference", () => {
    expect(lintBusinessLanguage("The whitespace at data-source.ts:122 is gone."))
      .toMatchObject([{ what: "a source line reference" }]);
  });

  it("renders the findings as the rewrite request", () => {
    const rendered = renderBusinessLanguageFindings(lintBusinessLanguage("See src/a/b.ts for details."));
    expect(rendered).toContain("Technical notes");
    expect(rendered).toContain("1. a file path");
  });
});

describe("lintHumanSentence", () => {
  it("passes a Chinese sentence that carries an id and a number", () => {
    expect(lintHumanSentence("场景标题", "保存规则后列表里能看到它 `S-AGENTRULES-01-save`")).toEqual([]);
    expect(lintHumanSentence("说明", "第 5 轮 5 个场景全部通过")).toEqual([]);
  });

  it("refuses an English sentence, because the person reading it did not ask for one", () => {
    const findings = lintHumanSentence("场景标题", "Saving a rule shows it in the list");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.what).toContain("not written in Chinese");
  });

  it("refuses a sentence that explains itself with a file path", () => {
    const findings = lintHumanSentence("原因", "规则没保存，src/config/store.ts 里少了一次写入");
    expect(findings.some((finding) => finding.what.includes("file path"))).toBe(true);
  });

  it("counts a sentence that is mostly handles as written", () => {
    expect(lintHumanSentence("说明", "S-AGENTRULES-01-save 通过")).toEqual([]);
  });
});
