# M2 acceptance

> 2026-08-30. The Epic chain is accepted in process, against the real classes
> and a real database, in `src/orchestrator/epic-pipeline.test.ts`. The live run
> on the board is still open, and deliberately so: the approval gate in the
> middle of it is a human step.

## What the acceptance drives

One Epic, three Stories, one of them dependent on the other two, from the
requirement to the review request and past it into the regression loop. Every
step below runs the class the orchestrator runs; only the model session and git
are stood in for.

| Step | What is asserted |
|---|---|
| Decomposition | The Epic reaches `PLAN_APPROVAL`, the plan is queued for the Epic page, and **no Story exists yet** |
| Human gate | Approval moves the Epic to `EXECUTING` and creates three `QUEUED` Stories, each carrying the Epic's repository |
| Footprint plan | The two independent Stories are planned into one batch; the dependent one waits for a second |
| Delayed cut | Each Story's branch is claimed only once its dependencies are delivered |
| Integration | Each Story lands on `epic/M2`; the branch the Epic lives on is recorded the first time |
| Epic review request | With every Story delivered and integrated, nothing is outstanding and the Epic MR is due |
| Regression trigger | Integration cleared what the previous head had verified, so every scenario is due on the next sweep |
| Statistical verdict | One failure raises nothing; the second reproduction of the same signature raises exactly one card |
| Attribution | The break is bisected to the second Story, which alone reopens as `REGRESSION_FIX` at priority 0 |

A second case asserts the unhappy path: a Story whose subset re-verification
fails on the Epic head returns to `CODE`, is not delivered, and its integration
row stays unintegrated.

## What writing it found

Two defects that made the chain unrunnable end to end, both now fixed:

- A Story created by the approval gate inherited no repository, and the
  dispatcher selects by repository, so an approved Story was invisible to it.
- Nothing ever cut a Story's branch. The dependency-aware claim existed and had
  no caller, so every approved Story failed with "does not declare a branch".

Neither would have surfaced from the unit tests: each class was correct on its
own, and the gap was between them.

## What is still open

- **The live run.** The board, real providers and a human approving the plan.
  Everything below the gate is exercised above; what a live run adds is the
  Notion round trip, real model sessions and real cost.
- **Real git conflicts.** The merge flow's conflict path is asserted through its
  port. A rebase that genuinely conflicts, and the CODE agent resolving it in
  the worktree, has not been run.
- **Real bisect probes.** Attribution is asserted over a revision sequence with
  a stubbed probe. Checking out each revision and re-running the scenario is
  wired in `scripts/run-regression.ts` but has not been exercised against a real
  history.
- **Retry-limit drills.** Each ceiling is read from config and the diagnostic
  report is asserted, but no ceiling has been driven to its limit by fault
  injection.

## Commands

```sh
npx vitest run src/orchestrator/epic-pipeline.test.ts   # this acceptance
npx tsx scripts/smoke-story-pipeline.ts                 # one Story, real pi
npm run orchestrator:run -- --repository-path <repo> --repository-id <id>
npm run regression:run -- --pool main --branch main --worktree <path> --scenarios <ids> --model <id>
```
