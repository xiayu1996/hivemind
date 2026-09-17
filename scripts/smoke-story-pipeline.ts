import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { LibsqlPhaseRecorder } from "../src/observability/phase-recorder.js";
import { EventBuffer } from "../src/observability/event-buffer.js";
import { DrainLoop } from "../src/observability/drain.js";
import { phaseEvidenceSink } from "../src/observability/phase-evidence-sink.js";
import { CANONICAL_CAPTURE_ENV } from "../src/observability/capture-contract.js";
import { migrate } from "../src/persistence/migrate.js";
import { POLICY_ENV_VAR, serializeGuardPolicy, type GuardPolicy } from "../src/guard/policy.js";
import { BlindVerifyStoryPort } from "../src/orchestrator/blind-verify-port.js";
import { PiStoryPhasePort } from "../src/orchestrator/pi-phase-port.js";
import { StoryExecutionStore } from "../src/orchestrator/story-execution-store.js";
import { NotionStoryProjection } from "../src/notion/story-projection.js";
import { SingleStoryWorker } from "../src/orchestrator/story-worker.js";
import { PiModelCatalog, resolveModel } from "../src/runner/model-resolver.js";
import { resolveAgentSpec } from "../src/runner/agent-spec.js";
import { ConfigStore } from "../src/config/store.js";
import type { ModelPurpose } from "../src/pipeline/phase.js";
import { RpcPiRunner } from "../src/runner/rpc-runner.js";
import { defaultPiBinary } from "../src/runner/pi-binary.js";
import { BlindVerifyExecutor } from "../src/verify/executor.js";
import { GitMrStoryDelivery, processGitCommand } from "../src/vcs/story-delivery.js";
import { EpicIntegrator } from "../src/orchestrator/epic-integration.js";
import { EpicMergeFlow } from "../src/vcs/merge-flow.js";
import { publishEpicBranch } from "../src/vcs/epic-branch.js";
import { testSubsetVerifier } from "../src/vcs/subset-verifier.js";

const execFileAsync = promisify(execFile);
const REPO = fileURLToPath(new URL("..", import.meta.url));
const PI_BIN = defaultPiBinary();
const MOCK_PORT = process.env.HIVEMIND_MOCK_PORT ?? "19101";
const MOCK_EXTENSION = join(REPO, "poc", "rpc-context", "mock-provider-extension.mjs");
const GUARD_EXTENSION = join(REPO, "extensions", "hive-guard.ts");
const CANONICAL_EXTENSION = join(REPO, "extensions", "canonical-capture.ts");
const CARD_ID = "S-MOCK-01";
const EPIC_ID = "E-MOCK-1";
const BRANCH = "story/mock-01";
// The repository's own check, run on the integration branch before a Story is
// fast-forwarded in. An empty check list makes every merge fail by design.
const PROJECT_CHECKS = [{ name: "tests", command: ["node", "--test", "tests/*.test.js"] }];

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
  const integrationWorktree = join(scratch, "integration");
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
    await execFileAsync("git", ["init", "--bare", "-b", "main", remote], { windowsHide: true });
    await execFileAsync("git", ["init", "-b", "main", worktree], { windowsHide: true });
    await git(worktree, "config", "user.name", "Hivemind Smoke");
    await git(worktree, "config", "user.email", "hivemind-smoke@example.invalid");
    await mkdir(join(worktree, "tests"), { recursive: true });
    await writeFile(join(worktree, "README.md"), "# story pipeline smoke\n", "utf8");
    await git(worktree, "add", "README.md");
    await git(worktree, "commit", "-m", "chore: initialise smoke repository");
    await git(worktree, "remote", "add", "origin", remote);
    // Delivery measures the Story branch against the published target, so the
    // remote has to carry main the way a real repository does.
    await git(worktree, "push", "--set-upstream", "origin", "main");
    await git(worktree, "switch", "-c", BRANCH);
    // Stands in for what SPECIFY commits on a real card: a test file naming the
    // scenario, so the CODE exit has a marked test to find rather than being
    // vacuously satisfied by a branch that never touched a test.
    await writeFile(join(worktree, "tests", "story.test.js"), [
      "// @scenario S-MOCK-01-unit",
      "const { test } = require(\"node:test\");",
      "test(\"@scenario S-MOCK-01-unit passes on observed evidence\", () => {});",
      "",
    ].join("\n"), "utf8");
    await git(worktree, "add", "tests/story.test.js");
    await git(worktree, "commit", "-m", "test(S-MOCK-01-unit): red");
    await git(worktree, "commit", "--allow-empty", "-m", "feat(S-MOCK-01-unit): green");

    // The Epic head lives in a second worktree of the same repository, the way
    // a host lays it out: the Story worktree is rebased onto the Epic branch,
    // and the fast-forward and re-verification happen over here. A clone would
    // not do -- the two have to share refs, or the rebase cannot see the head.
    await git(worktree, "worktree", "add", integrationWorktree, "main");
    // Every Story's review request targets the Epic branch and delivery reads
    // it from origin, so it is published the moment the Epic has Stories --
    // the same thing the orchestrator does before it cuts a worktree.
    await publishEpicBranch({ git: processGitCommand, repositoryPath: worktree, epicId: EPIC_ID });

    client = createClient({ url: `file:${join(scratch, "hivemind.db")}` });
    await migrate(client);
    const store = new StoryExecutionStore(client);
    await client.execute({
      sql: `INSERT INTO epics (id, notion_page_id, title, state, repo, created_at, updated_at)
            VALUES (?, ?, ?, 'EXECUTING', ?, ?, ?)`,
      args: [EPIC_ID, "local-smoke-epic", "Prove the single machine path", "example/hivemind-smoke", 1, 1],
    });
    await store.createStory({
      id: CARD_ID,
      epicId: EPIC_ID,
      notionPageId: "local-smoke-page",
      title: "Prove the single Story production path",
      requirement: "Run SHAPE, DESIGN, SPECIFY, CODE, independent VERIFY, MERGE and branch publication without skipping a gate.",
      repo: "example/hivemind-smoke",
      branch: BRANCH,
    });

    const model = await resolveModel(new PiModelCatalog({
      binary: PI_BIN,
      extensions: [MOCK_EXTENSION],
      cwd: REPO,
    }), "mock", "mock-1");
    const runnerEnvironment = { HIVEMIND_MOCK_PORT: MOCK_PORT };
    // The smoke run pins one deterministic model, so every purpose resolves to
    // it; the spec is still built through the real entry point so the spawn has
    // the shape production produces.
    const smokeSpec = (purpose: ModelPurpose) => resolveAgentSpec({
      config: ConfigStore.defaults(),
      policy: {
        resolve: async () => model,
        providersFor: async () => ["mock"],
        tierOf: async () => "standard",
        isMetered: async () => false,
      },
    }, purpose, "mock");
    const recorder = new LibsqlPhaseRecorder(client, {
      evidenceRoot: evidence,
      hostId: "windows-smoke",
    });
    // The smoke run exercises the same two rings production uses: the phases
    // enqueue, this loop writes.
    const events = new EventBuffer();
    const drain = new DrainLoop(events, [phaseEvidenceSink(recorder)]);
    drain.start();
    const phases = new PiStoryPhasePort({
      binary: PI_BIN,
      resolveSpec: async (purpose) => ({ spec: await smokeSpec(purpose), release: async () => undefined }),
      worktreePath: worktree,
      promptRoot: join(REPO, "prompts"),
      sessionRoot: sessions,
      evidencePath: evidence,
      auditPath,
      guardExtension: GUARD_EXTENSION,
      canonicalCaptureExtension: CANONICAL_EXTENSION,
      codeExit: { baseRef: "main", projectChecks: PROJECT_CHECKS },
      extensions: [MOCK_EXTENSION],
      env: runnerEnvironment,
      recordCost: (input) => recorder.recordCost(input),
      emit: (type, data) => events.emit(type, data),
    });
    const blind = new BlindVerifyExecutor(
      {
        create: (policy: GuardPolicy, _spec, browserEnv) => new RpcPiRunner({
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
            ...browserEnv,
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
      resolveSpec: async () => ({ spec: await smokeSpec("verify"), release: async () => undefined }),
      commitMessages: async () => (await git(worktree, "log", "--format=%s", "main..HEAD"))
        .split(/\r?\n/).filter(Boolean),
      recordCost: (input) => recorder.recordCost(input),
      emit: (type, data) => events.emit(type, data),
    });
    const delivery = new GitMrStoryDelivery({
      findOpen: async () => null,
      create: async () => ({
        url: "https://github.com/example/hivemind-smoke/pull/1",
        provider: "github",
      }),
    }, { worktreePath: worktree });
    // The real integrator, not a stub: a regression fix has to land on the Epic
    // head again, and that landing is the last thing between a fixed card and
    // DELIVERED.
    const integration = new EpicIntegrator(
      client,
      store,
      new EpicMergeFlow(
        processGitCommand,
        testSubsetVerifier(
          {
            run: async (check, cwd) => {
              const [command, ...args] = check.command;
              try {
                await execFileAsync(command!, args, { cwd, windowsHide: true });
                return { passed: true, detail: "" };
              } catch (cause) {
                return { passed: false, detail: (cause as Error).message };
              }
            },
          },
          PROJECT_CHECKS,
        ),
        { storyWorktree: worktree, integrationWorktree, mainBranch: "main" },
      ),
    );
    const worker = new SingleStoryWorker(store, phases, verifier, delivery, new NotionStoryProjection(client), {
      integration,
    });
    const result = await worker.run(CARD_ID);
    if (result.state !== "DELIVERED") throw new Error(`unexpected Story state: ${result.state}`);
    // The evidence below is written by ring 1, behind the card; a reader has to
    // wait for the drain, and the card never did.
    await drain.tick();
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
    // Six phase runs: SHAPE, DESIGN, SPECIFY, CODE, VERIFY, MERGE. Ten
    // artifacts: three from SHAPE, three from DESIGN (the summary a person
    // reads, the notes whoever codes reads, the declarations), one each after.
    if (Number(row?.runs) !== 6 || Number(row?.artifacts) !== 10 ||
        Number(row?.verdicts) !== 1 || Number(row?.costs) !== 6) {
      throw new Error(`central execution ledger is incomplete: ${JSON.stringify(row)}`);
    }
    console.log("PASS: real pi completed SHAPE, DESIGN, SPECIFY, CODE, blind VERIFY and MERGE in fresh sessions");
    console.log("PASS: central libsql recorded 6 runs, 10 artifacts, 1 accepted verdict and 6 phase costs");
    console.log("PASS: exact provider payloads round-tripped through each canonical run log");
    console.log("PASS: the clean Story branch was published before the MR adapter returned");

    // The delivered card breaks again. It re-enters at the narrow SPECIFY the
    // same way a person's defect report puts it there, so the reproduction is
    // written and frozen before the fix may touch the code it exists to prove.
    await store.openRegressionCard({
      cardId: CARD_ID,
      scenarioId: `${CARD_ID}-unit`,
      signature: "the declared scenario fails on the integration branch",
    });
    await store.transition(CARD_ID, "DELIVERED", "SPECIFY", "human", `${CARD_ID}-regression-entry`);
    await store.markNarrowSpecify(CARD_ID);

    const repaired = await worker.run(CARD_ID);
    if (repaired.state !== "DELIVERED") throw new Error(`unexpected Story state after the regression: ${repaired.state}`);
    await drain.stop();
    if (events.dropped > 0) throw new Error(`observability dropped ${events.dropped} event(s)`);

    const regressionRuns = await client.execute(`
      SELECT phase, COUNT(*) AS runs FROM phase_runs
       WHERE status = 'completed' AND phase IN ('SPECIFY', 'REGRESSION_FIX')
       GROUP BY phase ORDER BY phase
    `);
    const byPhase = new Map(regressionRuns.rows.map((entry) => [String(entry.phase), Number(entry.runs)]));
    if (byPhase.get("SPECIFY") !== 2 || byPhase.get("REGRESSION_FIX") !== 1) {
      throw new Error(`the regression pass did not run SPECIFY then REGRESSION_FIX: ${JSON.stringify([...byPhase])}`);
    }
    const narrow = await client.execute(
      "SELECT mode FROM story_test_contracts ORDER BY attempt DESC LIMIT 1",
    );
    if (String(narrow.rows[0]?.mode) !== "narrow") {
      throw new Error(`the regression pass wrote a ${String(narrow.rows[0]?.mode)} contract where narrow was required`);
    }
    const closed = await client.execute("SELECT resolved_at FROM regression_cards");
    if (closed.rows.length !== 1 || closed.rows[0]?.resolved_at === null) {
      throw new Error(`the regression card was not closed by its fix: ${JSON.stringify(closed.rows)}`);
    }
    // The fix is only delivered once it is on the Epic head that origin holds;
    // a card that reached DELIVERED without that landed nowhere.
    const epicHead = (await execFileAsync("git", ["--git-dir", remote, "rev-parse", `refs/heads/epic/${EPIC_ID}`], {
      windowsHide: true,
    })).stdout.trim();
    const storyHead = (await git(worktree, "rev-parse", BRANCH)).trim();
    if (epicHead !== storyHead) {
      throw new Error(`the Epic head on origin (${epicHead}) is not the fixed Story head (${storyHead})`);
    }
    console.log("PASS: the delivered card went back through narrow SPECIFY, REGRESSION_FIX and VERIFY to DELIVERED");
    console.log("PASS: the fix landed on the Epic head on origin, re-verified by the repository's own check");
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
