import { displayTime, layerWords, verdictWord } from "../display-text.js";
import {
  bullet,
  code,
  mermaid,
  paragraph,
  runs,
  t,
  table,
  toggle,
  type Block,
  type RichTextRun,
} from "../rich-text.js";

/** Where a scenario stands, as one character a person reads before the words. */
const STATUS_ICONS: Record<string, string> = {
  passed: "✅",
  failed: "❌",
  pending: "⚪",
  withdrawn: "Ὢb",
};

export interface DesiredSpec {
  id: string;
  seq: number;
  status: string;
  /** What the scenario is called, in the words SHAPE wrote. */
  title: string;
  given?: string | undefined;
  when?: string | undefined;
  then?: string | undefined;
  layers?: string[] | undefined;
}

export interface RoundScenarioRow {
  scenario: string;
  test: string;
  screen: string;
  note: string;
}

export interface DesiredRound {
  round: number;
  /** When the round finished, stamped in the reader's own day. */
  at: number;
  verdict: string;
  passed: number;
  total: number;
  rows: RoundScenarioRow[];
  /** Interface remarks, which never rejected anything and never cost a round. */
  findings?: string[] | undefined;
}

function statusIcon(status: string): string {
  return STATUS_ICONS[status] ?? STATUS_ICONS.pending!;
}

/**
 * The one line a person reads for a scenario: whether it holds, what it is
 * called, and the handle they quote back in a comment. The given/when/then is
 * underneath it, where it costs nothing to skip.
 */
export function specLine(spec: DesiredSpec): string {
  return `${statusIcon(spec.status)} 场景 ${spec.seq} · ${spec.title} ${spec.id}`;
}

export function specRuns(spec: DesiredSpec): RichTextRun[] {
  return runs(t(`${statusIcon(spec.status)} 场景 ${spec.seq} · ${spec.title} `), code(spec.id));
}

export function isWithdrawn(line: string): boolean {
  return line.startsWith(STATUS_ICONS.withdrawn!);
}

/** A scenario a later DoD no longer declares keeps its words and loses its tick. */
export function withdrawnLine(line: string): string {
  const withoutIcon = line.replace(/^\S+\s+/u, "");
  return `${STATUS_ICONS.withdrawn} ${withoutIcon}`;
}

/** The four things a person asks of a scenario, each on its own line. */
export function specDetailBlocks(spec: DesiredSpec): Block[] {
  const lines: Array<[string, string | undefined]> = [
    ["前提", spec.given],
    ["操作", spec.when],
    ["结果", spec.then],
    ["证明方式", spec.layers && spec.layers.length > 0 ? layerWords(spec.layers).join("、") : undefined],
  ];
  return lines
    .filter((line): line is [string, string] => Boolean(line[1]))
    .map(([label, value]) => bullet(t(`${label}：${value}`)));
}

export function roundTitle(round: DesiredRound): string {
  const mark = round.verdict === "accepted" ? "✅" : round.verdict === "inconclusive" ? "⚠️" : "❌";
  return `第 ${round.round} 轮 · ${displayTime(round.at)} · ${round.passed}/${round.total} 通过 ${mark}`;
}

/**
 * What a round says, as a table rather than a paragraph: one row per scenario,
 * one column per lane, so a person finds the scenario they care about without
 * reading the ones they do not.
 */
export function roundBlocks(round: DesiredRound): Block[] {
  const blocks: Block[] = [
    table(
      ["场景", "测试", "走查", "说明"],
      round.rows.map((row) => [row.scenario, row.test, row.screen, row.note]),
    ),
  ];
  if (round.findings && round.findings.length > 0) {
    blocks.push(paragraph(t("界面建议（不影响验收）：")));
    for (const finding of round.findings) blocks.push(bullet(t(finding)));
  }
  return blocks;
}

/** The verdict word a row shows when a lane had nothing to say about it. */
export function laneWord(status: string | undefined): string {
  return status === undefined || status === "" ? "—" : verdictWord(status);
}

/** The folded block a section carries under its own paragraph. */
export function foldedBlocks(title: string, paragraphs: readonly string[], diagram?: string): Block[] {
  const children: Block[] = paragraphs.map((body) => paragraph(t(body)));
  if (diagram) children.push(mermaid(diagram));
  return children.length === 0 ? [] : [toggle(t(title), children)];
}
