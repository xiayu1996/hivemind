// What actually happened in one round of one card, in one screen.
//
// Every round already leaves a full record — the phase run, the session JSONL
// pi wrote, the commits, the verdict, the cost — but spread across a database,
// a worktree and a directory of files nobody can read by hand. Without this the
// only answer to "why did CODE do the smallest possible thing again" is a guess,
// and a guess is what an early product cannot afford to iterate on.
//
//   npx tsx scripts/inspect-round.ts --card-id S-E3OVERVIEW-01
//   npx tsx scripts/inspect-round.ts --card-id S-E3OVERVIEW-01 --round 8 --prompt
//   npx tsx scripts/inspect-round.ts --card-id S-E3OVERVIEW-01 --round 8 --phase CODE --tools
import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { openDb } from "../src/persistence/client.js";

const execFileAsync = promisify(execFile);

function optional(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function required(name: string): string {
  const value = optional(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const flag = (name: string): boolean => process.argv.includes(name);

interface SessionMessage {
  type: string;
  message?: { role: string; content: unknown };
}

interface PromptSection {
  heading: string;
  chars: number;
}

/** The prompt as pi received it: the first user message of the session. */
function firstUserText(path: string): string | null {
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    const entry = JSON.parse(line) as SessionMessage;
    if (entry.type !== "message" || entry.message?.role !== "user") continue;
    return textOf(entry.message.content);
  }
  return null;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part as { type?: string; text?: string }).text ?? "")
    .join("");
}

/**
 * Where the prompt's weight actually went. A section map is the difference
 * between "the answer was in the prompt" and "the answer was one line under
 * 18KB of stale artifacts", and only the second explains a lazy round.
 */
function sectionMap(prompt: string): PromptSection[] {
  const sections: PromptSection[] = [];
  let heading = "(before the first heading)";
  let chars = 0;
  for (const line of prompt.split("\n")) {
    if (line.startsWith("#")) {
      sections.push({ heading, chars });
      heading = line;
      chars = 0;
      continue;
    }
    chars += line.length + 1;
  }
  sections.push({ heading, chars });
  return sections.filter((section) => section.chars > 0 || section.heading.startsWith("#"));
}

function toolCalls(path: string): Array<{ name: string; input: string }> {
  const calls: Array<{ name: string; input: string }> = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    const entry = JSON.parse(line) as SessionMessage;
    if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
    const content = entry.message.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const typed = part as { type?: string; name?: string; toolName?: string; input?: unknown; arguments?: unknown };
      if (typed.type !== "tool_use" && typed.type !== "toolCall") continue;
      calls.push({
        name: typed.name ?? typed.toolName ?? "(unnamed)",
        input: JSON.stringify(typed.input ?? typed.arguments ?? {}).slice(0, 160),
      });
    }
  }
  return calls;
}

/** The model's own last words: what it believed it had done. */
function finalText(path: string): string | null {
  let last: string | null = null;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    const entry = JSON.parse(line) as SessionMessage;
    if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
    const text = textOf(entry.message.content).trim();
    if (text) last = text;
  }
  return last;
}

function sessionFile(sessionRoot: string, runId: string): string | null {
  try {
    const directory = join(sessionRoot, runId);
    const files = readdirSync(directory).filter((name) => name.endsWith(".jsonl")).toSorted();
    const latest = files.at(-1);
    return latest ? join(directory, latest) : null;
  } catch {
    // A phase that never spawned pi (a guard refusal, a dispatch that died
    // before the handshake) has no session directory at all.
    return null;
  }
}

/**
 * VERIFY and the UI review write their sessions into shared directories named
 * by lane, not by run, so the run's sessions are the files pi started inside
 * the run's window. The file name begins with the start time.
 */
function laneSessions(sessionRoot: string, lane: string, startedAt: number, endedAt: number | null): string[] {
  try {
    return readdirSync(join(sessionRoot, lane))
      .filter((name) => name.endsWith(".jsonl"))
      .filter((name) => {
        const stamp = name.slice(0, name.indexOf("_")).replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, "T$1:$2:$3.$4Z");
        const at = Date.parse(stamp);
        return Number.isFinite(at) && at >= startedAt - 60_000 && at <= (endedAt ?? Date.now()) + 60_000;
      })
      .toSorted()
      .map((name) => join(sessionRoot, lane, name));
  } catch {
    // The lane never ran on this card.
    return [];
  }
}

function describeSession(path: string, label: string, showTools: boolean): void {
  const calls = toolCalls(path);
  const byName = new Map<string, number>();
  for (const call of calls) byName.set(call.name, (byName.get(call.name) ?? 0) + 1);
  console.log(`${label} session ${path.slice(path.lastIndexOf("/") + 1)}`);
  console.log(`  tools: ${[...byName].map(([name, count]) => `${name}×${count}`).join(", ") || "none"}`);
  if (showTools) for (const call of calls) console.log(`    ${call.name} ${call.input}`);
  const said = finalText(path);
  if (said) console.log(`  its own account:\n    ${said.replaceAll("\n", "\n    ").slice(0, 1200)}`);
}

function kb(chars: number): string {
  return `${(chars / 1024).toFixed(1)}KB`;
}

async function main(): Promise<void> {
  const cardId = required("--card-id");
  const phaseFilter = optional("--phase");
  const dbUrl = process.env.HIVEMIND_DB_URL ?? "file:data/hivemind.db";
  const workRoot = optional("--work-root") ?? join("data", "work");
  const handle = openDb(dbUrl);
  try {
    const story = (await handle.client.execute({
      sql: `SELECT state, phase, repo, branch, inner_loop_rounds, phase_reentries, stop_reason
            FROM stories WHERE id = ?`,
      args: [cardId],
    })).rows[0];
    if (!story) throw new Error(`no such Story: ${cardId}`);
    const repositoryId = optional("--repository-id") ?? String(story.repo ?? "").split("/").at(-1) ?? "";
    const sessionRoot = optional("--session-root") ?? join(workRoot, "sessions", repositoryId, cardId);
    const worktree = optional("--worktree") ?? join(workRoot, "worktrees", repositoryId, cardId);

    const round = Number(optional("--round") ?? story.inner_loop_rounds);
    console.log(`${cardId}  state=${String(story.state)}  round=${round}/${Number(story.inner_loop_rounds)}`
      + `  reentries=${Number(story.phase_reentries)}  stop=${String(story.stop_reason ?? "-")}`);

    const runs = (await handle.client.execute({
      sql: `SELECT run_id, phase, status, session_id, failure, started_at, ended_at
            FROM phase_runs WHERE card_id = ? AND round = ? ORDER BY started_at`,
      args: [cardId, round],
    })).rows.filter((row) => !phaseFilter || String(row.phase) === phaseFilter);
    if (runs.length === 0) console.log(`no phase run recorded for round ${round}`);

    for (const run of runs) {
      const runId = String(run.run_id);
      const seconds = run.ended_at ? Math.round((Number(run.ended_at) - Number(run.started_at)) / 1000) : null;
      console.log(`\n=== ${String(run.phase)} round ${round} · ${String(run.status)}`
        + `${seconds === null ? " · still running or killed" : ` · ${seconds}s`}`);
      console.log(`run_id ${runId}`);
      if (run.failure) console.log(`failure: ${String(run.failure)}`);

      const cost = (await handle.client.execute({
        sql: `SELECT COALESCE(SUM(uncached_input_tokens), 0) AS input,
                     COALESCE(SUM(output_tokens), 0) AS output,
                     COALESCE(SUM(cache_read_tokens), 0) AS cache_read,
                     COALESCE(SUM(cost_usd), 0) AS usd
              FROM cost_entries WHERE run_id = ?`,
        args: [runId],
      })).rows[0];
      if (cost) {
        console.log(`tokens in=${Number(cost.input)} out=${Number(cost.output)} cacheRead=${Number(cost.cache_read)}`
          + ` · $${Number(cost.usd).toFixed(4)}`);
      }

      const events = (await handle.client.execute({
        sql: `SELECT type, data FROM event_log
              WHERE run_id = ? AND type NOT LIKE 'rpc.%' ORDER BY seq`,
        args: [runId],
      })).rows;
      for (const event of events) {
        console.log(`event ${String(event.type)}: ${String(event.data ?? "").slice(0, 400)}`);
      }

      const path = sessionFile(sessionRoot, runId);
      if (!path) {
        if (String(run.phase) !== "VERIFY") {
          console.log(`no session file under ${join(sessionRoot, runId)}`);
          continue;
        }
        const startedAt = Number(run.started_at);
        const endedAt = run.ended_at ? Number(run.ended_at) : null;
        const verify = laneSessions(sessionRoot, "verify", startedAt, endedAt);
        const review = laneSessions(sessionRoot, "ui-review", startedAt, endedAt);
        if (verify.length === 0 && review.length === 0) console.log(`no verify or ui-review session started in this run's window`);
        for (const file of verify) describeSession(file, "blind verify", flag("--tools"));
        for (const file of review) describeSession(file, "ui review", flag("--tools"));
        continue;
      }
      const prompt = firstUserText(path);
      if (prompt) {
        console.log(`prompt ${kb(prompt.length)} in ${sectionMap(prompt).length} sections:`);
        for (const section of sectionMap(prompt)) {
          console.log(`  ${kb(section.chars).padStart(7)}  ${section.heading}`);
        }
        // What the round was asked to do is ordinary text in the prompt, so the
        // only way to know it arrived, and where, is to look.
        const marker = "## What this round must do";
        const at = prompt.indexOf(marker);
        console.log(`  ${marker}: ${at < 0 ? "ABSENT" : `at ${kb(at)} of ${kb(prompt.length)}`}`);
        for (const tag of prompt.match(/^- \[(?:answer|rejected|scenario):[^\]]+\]/gm) ?? []) console.log(`    ${tag}`);
      }
      if (flag("--prompt") && prompt) console.log(`\n--- prompt ---\n${prompt}\n--- end prompt ---`);

      const calls = toolCalls(path);
      const byName = new Map<string, number>();
      for (const call of calls) byName.set(call.name, (byName.get(call.name) ?? 0) + 1);
      console.log(`tools: ${[...byName].map(([name, count]) => `${name}×${count}`).join(", ") || "none"}`);
      if (flag("--tools")) for (const call of calls) console.log(`  ${call.name} ${call.input}`);

      const said = finalText(path);
      if (said) console.log(`the model's own account:\n  ${said.replaceAll("\n", "\n  ").slice(0, 1200)}`);

      if (run.ended_at) {
        const log = await execFileAsync("git", [
          "log", "--oneline", "--since", new Date(Number(run.started_at)).toISOString(),
          "--until", new Date(Number(run.ended_at) + 1000).toISOString(),
        ], { cwd: worktree, windowsHide: true }).catch(() => ({ stdout: "" }));
        console.log(`commits in this run: ${log.stdout.trim().replaceAll("\n", " | ") || "none"}`);
      }
    }

    const verify = (await handle.client.execute({
      sql: `SELECT verdict, failed_scenarios FROM verify_records WHERE card_id = ? AND round = ?`,
      args: [cardId, round],
    })).rows[0];
    if (verify) {
      console.log(`\n=== verdict round ${round}: ${String(verify.verdict)}`
        + ` · failed: ${String(verify.failed_scenarios)}`);
      const artifact = (await handle.client.execute({
        sql: `SELECT body FROM phase_artifacts
              WHERE card_id = ? AND phase = 'VERIFY' AND kind = 'verification' AND round = ?
              ORDER BY id DESC LIMIT 1`,
        args: [cardId, round],
      })).rows[0];
      if (artifact) {
        const body = JSON.parse(String(artifact.body)) as {
          reasons?: Array<{ scenarioId: string; reason: string }>;
          uiReview?: {
            acceptance?: Array<{ id: string; status: string; reason?: string }>;
            findings?: Array<{ severity: string; area: string; note: string }>;
          };
        };
        for (const reason of body.reasons ?? []) console.log(`  tests: ${reason.scenarioId}: ${reason.reason}`);
        for (const entry of body.uiReview?.acceptance ?? []) {
          console.log(`  screen: ${entry.id} ${entry.status}${entry.reason ? `: ${entry.reason}` : ""}`);
        }
        for (const finding of body.uiReview?.findings ?? []) {
          console.log(`  finding [${finding.severity}/${finding.area}]: ${finding.note}`);
        }
      }
    }
  } finally {
    handle.close();
  }
}

main().catch((error: unknown) => {
  console.error(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
