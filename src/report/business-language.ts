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
  { what: "a file path", pattern: /(?:^|\s)(?:\.{0,2}\/)?[\w.-]+\/[\w./-]+\.[A-Za-z]{1,5}(?=$|[\s,;:).])/m },
  { what: "a shell command", pattern: /(?:^|\s)(?:npm|npx|git|pnpm|yarn|docker|curl|sudo|python|node)\s+[a-z-]/m },
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

/** The rewrite request handed back to the MERGE session, verbatim. */
export function renderBusinessLanguageFindings(findings: readonly BusinessLanguageFinding[]): string {
  return [
    "The business section of the delivery report still carries technical detail. Rewrite it so a reader who does not open the code can follow it, and move the detail under a 'Technical notes' heading:",
    ...findings.map((finding, index) => `${index + 1}. ${finding.what}: ${finding.excerpt}`),
  ].join("\n");
}
