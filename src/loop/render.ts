import type { Contract } from "../domain/contract.ts";
import type { Plan } from "../domain/plan.ts";
import type { ItemRow } from "../store/store.ts";

/**
 * Markdown the loop renders itself from state it owns. Deterministic: the same
 * state renders the same bytes, so an unchanged PROGRESS.md never shows up as
 * a change.
 */

/** The acceptance contract as sentences, for the person approving it. */
export function renderContract(contract: Contract): string {
  const lines: string[] = [];
  for (const item of contract.items) {
    lines.push(`## ${item.id} ${item.title} (${item.surface})`, "");
    for (const scenario of item.scenarios) {
      const where = scenario.page ?? scenario.command ?? "";
      lines.push(`- **${scenario.id} ${scenario.title}**${where === "" ? "" : ` \`${where}\``}`);
      lines.push(`  - Given: ${scenario.given}`, `  - When: ${scenario.when}`, `  - Then: ${scenario.then}`);
      const visible = scenario.visible.map((entry) => [entry.role, entry.text === undefined ? undefined : `"${entry.text}"`].filter(Boolean).join(" ")).join("; ");
      if (visible !== "") lines.push(`  - Visible: ${visible}`);
    }
    lines.push("");
  }
  if (contract.outOfScope.length > 0) lines.push("## Out of scope", "", ...contract.outOfScope.map((entry) => `- ${entry}`), "");
  return `${lines.join("\n").trimEnd()}\n`;
}

/** Where the build stands, for the next session and for a person looking at the repository. */
export function renderProgress(plan: Plan, rows: readonly ItemRow[]): string {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const lines = ["# Progress", "", "Written by hivemind after every item; do not edit.", "", "| Item | Kind | Covers | Status | Attempts |", "| --- | --- | --- | --- | --- |"];
  for (const item of plan.items) {
    const row = byId.get(item.id);
    const status = row?.status !== "passed" ? (row?.status ?? "pending") : row.passedSha === null ? "passed" : `passed (${row.passedSha.slice(0, 7)})`;
    lines.push(`| ${item.id}: ${item.title} | ${item.kind} | ${item.covers.join(", ") || "-"} | ${status} | ${row?.attempts ?? 0} |`);
  }
  const failing = plan.items.map((item) => byId.get(item.id)).filter((row): row is ItemRow => row !== undefined && row.status !== "passed" && row.feedback !== null);
  for (const row of failing) {
    const findings: unknown = JSON.parse(row.feedback ?? "[]");
    if (!Array.isArray(findings) || findings.length === 0) continue;
    lines.push("", `## Last findings for ${row.id}`, "", ...findings.map((finding) => `- ${String(finding).split("\n")[0]}`));
  }
  return `${lines.join("\n")}\n`;
}
