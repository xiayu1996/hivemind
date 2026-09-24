// Whether the service is getting work done, which a pid cannot answer. Prints
// what is stuck and what is waiting, and exits non-zero only for the former,
// so a scheduler or an alert channel can run it unattended.
import { openDb } from "../src/persistence/client.js";
import {
  assessProgress,
  DEFAULT_PROGRESS_THRESHOLDS,
  readProgressSnapshot,
  renderProgressReport,
} from "../src/observability/progress-health.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function minutesOption(name: string, fallback: number): number {
  const raw = argument(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number of minutes`);
  return value * 60_000;
}

async function main(): Promise<void> {
  const handle = openDb(process.env.HIVEMIND_DB_URL ?? "file:data/hivemind.db");
  try {
    const report = assessProgress(await readProgressSnapshot(handle.client), Date.now(), {
      idleWorkingMs: minutesOption("--idle-minutes", DEFAULT_PROGRESS_THRESHOLDS.idleWorkingMs),
      outboxBacklogMs: minutesOption("--outbox-minutes", DEFAULT_PROGRESS_THRESHOLDS.outboxBacklogMs),
      awaitingPersonMs: minutesOption("--waiting-minutes", DEFAULT_PROGRESS_THRESHOLDS.awaitingPersonMs),
    });
    console.log(process.argv.includes("--json")
      ? JSON.stringify(report)
      : renderProgressReport(report));
    if (!report.healthy) process.exitCode = 1;
  } finally {
    handle.close();
  }
}

main().catch((error: unknown) => {
  console.error(`HEALTH CHECK FAILED: ${(error as Error).message}`);
  process.exit(2);
});
