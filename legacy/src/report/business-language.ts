/**
 * The business half of a delivery report is the only part most people read, so
 * it is held to business language by code rather than by asking the phase
 * prompt nicely. Everything technical belongs under the technical-notes
 * heading, which readers can leave folded.
 */
const TECHNICAL_HEADING = /^\s*#{0,6}\s*(?:technical notes|technical detail|技术细节|技术证据)\b.*$/im;

interface Rule {
  what: string;
  pattern: RegExp;
}

const RULES: readonly Rule[] = [
  { what: "a code block", pattern: /^\s*```/m },
  { what: "an indented code block", pattern: /^ {4,}\S+\(.*\)\s*$/m },
  // A Chinese sentence puts its punctuation right against the path, so the
  // boundary has to admit it; otherwise the rule only ever fires in English.
  { what: "a file path", pattern: /(?:^|[\s，、（(])(?:\.{0,2}\/)?[\w.-]+\/[\w./-]+\.[A-Za-z]{1,5}(?=$|[\s,;:).，、。）])/m },
  { what: "a shell command", pattern: /(?:^|[\s，、（(])(?:npm|npx|git|pnpm|yarn|docker|curl|sudo|python|node)\s+[a-z-]/m },
  { what: "an exception or stack frame", pattern: /\b[A-Z]\w*(?:Error|Exception)\b|\bTraceback\b|\bat [\w$.]+\([^)]*:\d+\)/m },
  { what: "a source line reference", pattern: /\b[\w.-]+\.[A-Za-z]{1,5}:\d+\b/m },
];

export interface BusinessLanguageFinding {
  what: string;
  /** The offending text, so the rewrite knows what to move. */
  excerpt: string;
}

/** Splits the report at the technical-notes heading; the tail is unconstrained. */
export function businessSection(report: string): string {
  const match = TECHNICAL_HEADING.exec(report);
  return match ? report.slice(0, match.index) : report;
}

export function lintBusinessLanguage(report: string): BusinessLanguageFinding[] {
  const section = businessSection(report);
  const findings: BusinessLanguageFinding[] = [];
  for (const rule of RULES) {
    const match = rule.pattern.exec(section);
    if (match) findings.push({ what: rule.what, excerpt: match[0].trim().slice(0, 120) });
  }
  return findings;
}

/**
 * The words a person reads have to be their own words. An id, an inline code
 * span, a number, a branch or a URL is a handle rather than a word, so it is
 * removed before the ratio is taken; what is left is the sentence itself.
 */
const HANDLES = /`[^`]*`|\b[SRE]-[A-Za-z0-9-]+\b|https?:\/\/\S+|[\d\s\p{P}\p{S}]+/gu;
const CJK = /[\u4e00-\u9fff]/u;

export function cjkRatio(text: string): number {
  const letters = [...text.replaceAll(HANDLES, "")];
  if (letters.length === 0) return 1;
  return letters.filter((letter) => CJK.test(letter)).length / letters.length;
}

export interface SentenceRule {
  /** How much of the sentence has to be Chinese for it to read as Chinese. */
  minCjk?: number;
}

/**
 * One sentence written for a person: the Story's scenario titles, its design
 * summary, a round's reason. The agent is asked for Chinese business language
 * in the prompt and held to it here, because a prompt is the weakest of the
 * three layers (design 03 section 9).
 */
export function lintHumanSentence(field: string, text: string, rule: SentenceRule = {}): BusinessLanguageFinding[] {
  const findings: BusinessLanguageFinding[] = [];
  const trimmed = text.trim();
  if (trimmed === "") return [{ what: `${field} is empty`, excerpt: "" }];
  if (cjkRatio(trimmed) < (rule.minCjk ?? 0.6)) {
    findings.push({ what: `${field} is not written in Chinese`, excerpt: trimmed.slice(0, 120) });
  }
  for (const technical of lintBusinessLanguage(trimmed)) {
    findings.push({ what: `${field} carries ${technical.what}`, excerpt: technical.excerpt });
  }
  return findings;
}

/** The rewrite request handed back to the DESIGN session, verbatim. */
export function renderDesignSummaryFindings(findings: readonly BusinessLanguageFinding[]): string {
  return [
    "设计摘要是这张卡上唯一给人读的设计内容，必须用中文业务语言写：做完之后用户能做什么、看到什么，不出现实现词汇、文件路径或英文段落。技术方案写进 technical_notes，那一段不受这条限制。请重写后把完整结果再返回一次：",
    ...findings.map((finding, index) => `${index + 1}. ${finding.what}：${finding.excerpt}`),
  ].join("\n");
}

/** The rewrite request handed back to the MERGE session, verbatim. */
export function renderBusinessLanguageFindings(findings: readonly BusinessLanguageFinding[]): string {
  return [
    "The business section of the delivery report still carries technical detail. Rewrite it so a reader who does not open the code can follow it, and move the detail under a 'Technical notes' heading:",
    ...findings.map((finding, index) => `${index + 1}. ${finding.what}: ${finding.excerpt}`),
  ].join("\n");
}
