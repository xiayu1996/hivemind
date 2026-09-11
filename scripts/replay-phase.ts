// Runs one phase of one card again, from central state, without touching the
// state machine, the database or Notion. This is how a prompt or gate change
// is tried against a real round before it is trusted: edit prompts/ or
// src/pipeline, replay, and read the artifact — no card is spent on it.
//
//   npx tsx scripts/replay-phase.ts --card-id S-E3OVERVIEW-01 --phase CODE --print-prompt
//   npx tsx scripts/replay-phase.ts --card-id S-E3OVERVIEW-01 --phase CODE --worktree <scratch clone> --provider openai-codex
//
// The worktree given to a writing phase is modified; hand it a scratch clone,
// never the Story's own worktree. Rounds and reentries are not counted.
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigStore } from "../src/config/store.js";
import { PiStoryPhasePort } from "../src/orchestrator/pi-phase-port.js";
import { StoryExecutionStore } from "../src/orchestrator/story-execution-store.js";
import { openDb } from "../src/persistence/client.js";
import { assemblePhasePrompt, roundTasks, type Phase } from "../src/pipeline/phase-input.js";
import { probeProviderReadiness } from "../src/runner/auth-probe.js";
import { defaultModelCatalog } from "../src/runner/catalog.js";
import type { ExplicitContextFile } from "../src/runner/context-files.js";
import { resolveModel } from "../src/runner/model-resolver.js";
import { defaultPiBinary } from "../src/runner/pi-binary.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPLAYABLE = new Set<Phase>(["DESIGN", "CODE", "MERGE", "REGRESSION_FIX"]);

function optional(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function required(name: string): string {
  const value = optional(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function contextFiles(): ExplicitContextFile[] {
  const files: ExplicitContextFile[] = [];
  for (let index = 0; index < process.argv.length; index++) {
    if (process.argv[index] !== "--context" || !process.argv[index + 1]) continue;
    const value = process.argv[index + 1]!;
    const split = value.indexOf("=");
    if (split < 1 || split === value.length - 1) throw new Error("--context must be label=path");
    files.push({ label: value.slice(0, split), path: resolve(value.slice(split + 1)) });
  }
  return files;
}

async function main(): Promise<void> {
  const cardId = required("--card-id");
  const phase = (optional("--phase") ?? "CODE") as Phase;
  if (!REPLAYABLE.has(phase)) throw new Error(`--phase must be one of ${[...REPLAYABLE].join(", ")}`);
  const dbUrl = process.env.HIVEMIND_DB_URL ?? "file:data/hivemind.db";
  const handle = openDb(dbUrl);
  try {
    const store = new StoryExecutionStore(handle.client);
    const story = await store.getStory(cardId);
    const round = Number(optional("--round") ?? story.innerLoopRounds + 1);
    const context = await store.buildPhaseInput(cardId, phase as Parameters<typeof store.buildPhaseInput>[1], round);
    const prompt = assemblePhasePrompt(context);
    const tasks = roundTasks(context);
    console.log(`${cardId} ${phase} round ${round}: prompt ${(prompt.length / 1024).toFixed(1)}KB, ${tasks.length} round task(s)`);
    for (const task of tasks) console.log(`  ${task.tag}`);
    if (process.argv.includes("--print-prompt")) {
      console.log(`\n--- prompt ---\n${prompt}--- end prompt ---`);
    }
    const worktree = optional("--worktree");
    if (!worktree) {
      console.log("\nno --worktree given: the prompt was assembled but no phase was run");
      return;
    }

    const worktreePath = resolve(worktree);
    const provider = optional("--provider") ?? "openai-codex";
    const piBinary = resolve(optional("--pi") ?? defaultPiBinary());
    const readiness = await probeProviderReadiness(piBinary, provider);
    if (!readiness.ready) throw new Error(`provider is not ready: ${provider} (${readiness.reason ?? "unknown reason"})`);
    const model = await resolveModel(defaultModelCatalog(piBinary, worktreePath), provider, required("--model"));
    const config = await ConfigStore.load(handle.client, story.repo ? { repository: story.repo } : {});

    const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
    const replayRoot = resolve(optional("--replay-root") ?? join(homedir(), ".hivemind", "replay", cardId, stamp));
    await mkdir(replayRoot, { recursive: true });
    await writeFile(join(replayRoot, "prompt.md"), prompt);
    const runId = `${cardId}-replay-${phase.toLowerCase()}-${round}-${stamp}`;
    const port = new PiStoryPhasePort({
      binary: piBinary,
      model,
      worktreePath,
      promptRoot: join(ROOT, "prompts"),
      sessionRoot: join(replayRoot, "sessions"),
      evidencePath: join(replayRoot, "evidence"),
      auditPath: join(replayRoot, "tool-audit.jsonl"),
      guardExtension: join(ROOT, "extensions", "hive-guard.ts"),
      canonicalCaptureExtension: join(ROOT, "extensions", "canonical-capture.ts"),
      ...(process.argv.includes("--gate") && phase === "CODE"
        ? {
            codeExit: {
              baseRef: optional("--base-ref") ?? "main",
              projectChecks: config.get("codeExit.projectChecks"),
              maxRounds: config.get("codeExit.maxRounds"),
            },
          }
        : {}),
      contextFiles: contextFiles(),
    });
    const started = Date.now();
    const result = await port.run({
      runId,
      phase: phase as "DESIGN" | "CODE" | "MERGE" | "REGRESSION_FIX",
      round,
      prompt,
      context,
    });
    const seconds = Math.round((Date.now() - started) / 1000);
    for (const artifact of result.artifacts) {
      await writeFile(join(replayRoot, `${artifact.kind}.txt`), artifact.body);
    }
    console.log(`\nreplayed in ${seconds}s · session ${result.sessionId}`);
    console.log(`artifacts and prompt under ${replayRoot}`);
    for (const artifact of result.artifacts) {
      console.log(`\n=== ${artifact.kind}\n${artifact.body.slice(0, 2000)}`);
    }
  } finally {
    handle.close();
  }
}

main().catch((error: unknown) => {
  console.error(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
