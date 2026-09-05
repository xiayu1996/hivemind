import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { PiCompletionJudge } from "../src/pipeline/completion-verifier.js";
import { LibsqlPhaseRecorder } from "../src/observability/phase-recorder.js";
import { CANONICAL_CAPTURE_ENV } from "../src/observability/capture-contract.js";
import { migrate } from "../src/persistence/migrate.js";
import { POLICY_ENV_VAR, serializeGuardPolicy, type GuardPolicy } from "../src/guard/policy.js";
import { BlindVerifyStoryPort } from "../src/orchestrator/blind-verify-port.js";
import { PiStoryPhasePort } from "../src/orchestrator/pi-phase-port.js";
import { StoryExecutionStore } from "../src/orchestrator/story-execution-store.js";
import { NotionStoryProjection } from "../src/notion/story-projection.js";
import { SingleStoryWorker } from "../src/orchestrator/story-worker.js";
import { PiModelCatalog, resolveModel } from "../src/runner/model-resolver.js";
import { RpcPiRunner } from "../src/runner/rpc-runner.js";
import { defaultPiBinary } from "../src/runner/pi-binary.js";
import { BlindVerifyExecutor } from "../src/verify/executor.js";
import { GitMrStoryDelivery } from "../src/vcs/story-delivery.js";

const execFileAsync = promisify(execFile);
const REPO = fileURLToPath(new URL("..", import.meta.url));
const PI_BIN = defaultPiBinary();
const MOCK_PORT = process.env.HIVEMIND_MOCK_PORT ?? "19101";
const MOCK_EXTENSION = join(REPO, "poc", "rpc-context", "mock-provider-extension.mjs");
const GUARD_EXTENSION = join(REPO, "extensions", "hive-guard.ts");
const CANONICAL_EXTENSION = join(REPO, "extensions", "canonical-capture.ts");
const CARD_ID = "S-MOCK-01";
const BRANCH = "story/mock-01";

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd, windowsHide: true })).stdout;
}

async function waitForMock(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      if ((await fetch(`http://127.0.0.1:${MOCK_PORT}/v1/models`)).ok) return;
    } catch {
      // The deterministic provider has not bound its port yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("mock provider never became reachable");
}

async function main(): Promise<void> {
  const scratch = await mkdtemp(join(tmpdir(), "hivemind-story-pipeline-"));
  const remote = join(scratch, "remote.git");
  const worktree = join(scratch, "worktree");
  const evidence = join(scratch, "evidence");
  const sessions = join(scratch, "sessions");
  const auditPath = join(evidence, "tool-audit.jsonl");
  const mock = (await import("node:child_process")).spawn(
    process.execPath,
    [join(REPO, "poc", "rpc-context", "mock-provider-server.mjs"), "--port", MOCK_PORT],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let client: ReturnType<typeof createClient> | undefined;

  try {
    await waitForMock();
    await execFileAsync("git", ["init", "--bare", remote], { windowsHide: true });
    await execFileAsync("git", ["init", "-b", "main", worktree], { windowsHide: true });
    await git(worktree, "config", "user.name", "Hivemind Smoke");
    await git(worktree, "config", "user.email", "hivemind-smoke@example.invalid");
    await writeFile(join(worktree, "README.md"), "# story pipeline smoke\n", "utf8");
    await git(worktree, "add", "README.md");
    await git(worktree, "commit", "-m", "chore: initialise smoke repository");
    await git(worktree, "remote", "add", "origin", remote);
    await git(worktree, "switch", "-c", BRANCH);
    await git(worktree, "commit", "--allow-empty", "-m", "test(S-MOCK-01-unit): red");
    await git(worktree, "commit", "--allow-empty", "-m", "feat(S-MOCK-01-unit): green");

    client = createClient({ url: `file:${join(scratch, "hivemind.db")}` });
    await migrate(client);
    const store = new StoryExecutionStore(client);
    await store.createStory({
      id: CARD_ID,
      notionPageId: "local-smoke-page",
      title: "Prove the single Story production path",
      requirement: "Run DESIGN, CODE, independent VERIFY, MERGE and branch publication without skipping a gate.",
      repo: "example/hivemind-smoke",
      branch: BRANCH,
    });

    const model = await resolveModel(new PiModelCatalog({
      binary: PI_BIN,
      extensions: [MOCK_EXTENSION],
      cwd: REPO,
    }), "mock", "mock-1");
    const runnerEnvironment = { HIVEMIND_MOCK_PORT: MOCK_PORT };
    const completionJudge = new PiCompletionJudge(() => new RpcPiRunner({
      binary: PI_BIN,
      provider: model.provider,
      model,
      cwd: worktree,
      tools: [],
      extensions: [MOCK_EXTENSION],
      contextFiles: "explicit",
      env: runnerEnvironment,
    }));
    const recorder = new LibsqlPhaseRecorder(client, {
      evidenceRoot: evidence,
      provider: model.provider,
      modelId: model.id,
      hostId: "windows-smoke",
    });
    const phases = new PiStoryPhasePort({
      binary: PI_BIN,
      model,
      worktreePath: worktree,
      promptRoot: join(REPO, "prompts"),
      sessionRoot: sessions,
      evidencePath: evidence,
      auditPath,
      guardExtension: GUARD_EXTENSION,
      canonicalCaptureExtension: CANONICAL_EXTENSION,
      completionJudge,
      extensions: [MOCK_EXTENSION],
      env: runnerEnvironment,
      recordTelemetry: (input) => recorder.record(input),
    });
    const blind = new BlindVerifyExecutor(
      {
        create: (policy: GuardPolicy) => new RpcPiRunner({
          binary: PI_BIN,
          provider: model.provider,
          model,
          cwd: worktree,
          sessionDir: join(sessions, "verify"),
          tools: ["read", "bash"],
          extensions: [MOCK_EXTENSION, GUARD_EXTENSION, CANONICAL_EXTENSION],
          contextFiles: "explicit",
          env: {
            ...runnerEnvironment,
            [POLICY_ENV_VAR]: serializeGuardPolicy(policy),
            [CANONICAL_CAPTURE_ENV]: join(policy.extraWriteRoots[0]!, "provider-requests.jsonl"),
          },
        }),
      },
      { insert: async () => undefined },
    );
    const verifier = new BlindVerifyStoryPort({
      executor: blind,
      worktreePath: worktree,
      evidenceRoot: evidence,
      auditPath,
      allowedHosts: ["localhost", "127.0.0.1"],
      commitMessages: async () => (await git(worktree, "log", "--format=%s", "main..HEAD"))
        .split(/\r?\n/).filter(Boolean),
      recordTelemetry: (input) => recorder.record(input),
    });
    const delivery = new GitMrStoryDelivery({
      create: async () => ({
        url: "https://github.com/example/hivemind-smoke/pull/1",
        provider: "github",
      }),
    }, { worktreePath: worktree });
    const worker = new SingleStoryWorker(store, phases, verifier, delivery, new NotionStoryProjection(client));
    const result = await worker.run(CARD_ID);
    if (result.state !== "DELIVERED") throw new Error(`unexpected Story state: ${result.state}`);
    const story = await store.getStory(CARD_ID);
    if (story.state !== "DELIVERED" || story.innerLoopRounds !== 1 || !story.mrUrl) {
      throw new Error(`central Story state is incomplete: ${JSON.stringify(story)}`);
    }
    const remoteHead = (await execFileAsync("git", ["--git-dir", remote, "rev-parse", `refs/heads/${BRANCH}`], {
      windowsHide: true,
    })).stdout.trim();
    if (!/^[a-f0-9]{40,64}$/i.test(remoteHead)) throw new Error("Story branch was not published");
    const counts = await client.execute(`
      SELECT
        (SELECT COUNT(*) FROM phase_runs WHERE status = 'completed') AS runs,
        (SELECT COUNT(*) FROM phase_artifacts) AS artifacts,
        (SELECT COUNT(*) FROM verify_records WHERE verdict = 'accepted') AS verdicts,
        (SELECT COUNT(*) FROM cost_entries) AS costs
    `);
    const row = counts.rows[0];
    if (Number(row?.runs) !== 4 || Number(row?.artifacts) !== 5 ||
        Number(row?.verdicts) !== 1 || Number(row?.costs) !== 4) {
      throw new Error(`central execution ledger is incomplete: ${JSON.stringify(row)}`);
    }
    console.log("PASS: real pi completed DESIGN, CODE, blind VERIFY and MERGE in fresh sessions");
    console.log("PASS: central libsql recorded 4 runs, 5 artifacts, 1 accepted verdict and 4 phase costs");
    console.log("PASS: exact provider payloads round-tripped through each canonical run log");
    console.log("PASS: the clean Story branch was published before the MR adapter returned");
  } finally {
    client?.close();
    mock.kill("SIGKILL");
    await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

main().catch((error: unknown) => {
  console.error("FAILED:", error);
  process.exit(1);
});
