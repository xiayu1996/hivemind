# M2 self-hosting progress

> Status: 2026-08-30. hivemind develops its own M2 roadmap from the seeded
> Notion board; this session acted as the acceptance party (review + merge).
> Provider history: `zai-coding-cn` (zcode plan, exhausted balance), then
> `openai-codex` `gpt-5.6-terra` (usage window reached).

## Delivered and merged

| Card | PR | Content | Notes |
|---|---|---|---|
| S-VAL-01 | [PR #2](https://github.com/xiayu1996/hivemind/pull/2) | `src/util/format.ts` + 6 scenario tests | M1-37 acceptance card; full unattended pipeline first proven here |
| S-M2-01 | [PR #3](https://github.com/xiayu1996/hivemind/pull/3) | DECOMPOSE artifact validation + business-language lint | Pure functions; CN+EN implementation-vocabulary lint |
| S-M2-02 | [PR #4](https://github.com/xiayu1996/hivemind/pull/4) | PLAN_APPROVAL gate: epic plans, approval events, dispatch intents | Wired into the real Notion sync coordinator after one rejected round |
| S-M2-03 | [PR #5](https://github.com/xiayu1996/hivemind/pull/5) | Footprint scheduler: topology + intersection + hotspots + cycles | One round |
| S-M2-04 | [PR #6](https://github.com/xiayu1996/hivemind/pull/6) | Hotspot registry as config asset | One MERGE re-entry |
| S-M2-05 | [PR #7](https://github.com/xiayu1996/hivemind/pull/7) | Epic integration branch, merge flow, subset re-verification | Inner loop round 2 accepted |
| S-M2-06 | [PR #8](https://github.com/xiayu1996/hivemind/pull/8) | Epic single MR + daily branch freshness + 9-story split notice | Red/green commits per scenario visible in history |

Every PR passed CI, was reviewed by the acceptance session, and was merged
manually — the independent-PR constraint from the board's delivery rule held.

## Pipeline hardening done during the run (all merged to main)

- Windows: `.cmd` shims need `shell: true`; repo-wide LF pinning via
  `.gitattributes` so story worktrees never diverge in line endings.
- Structured-output tolerance: JSON payloads wrapped in prose, code fences or
  `<think>` remnants are located before schema validation; every no-payload
  path still fails closed. Nested DoD objects and object-form acceptance
  criteria are flattened to the contracted string forms.
- Verify evidence channel: real pi RPC `message_update`/`message_end`
  toolResult events are read (the fixture shape alone saw nothing), ANSI
  stripped before scenario-id matching, plus a runner-native fallback matcher.
- Recovery semantics: failed phase attempts are superseded by delete+insert
  (their artifacts cascade); a completed result its own consumer rejects is
  invalidated once and regenerated; VERIFY/MERGE parking and human resume via
  the store; DESIGN/CODE/MERGE re-entry in the worker and dispatcher.
- Completion judge: observable tool-evidence digest plus per-phase contracts;
  the judge's veto reasons feed the next attempt ("why earlier attempts were
  rejected" section in the phase prompt).
- Orchestrator: dispatch filtered to the checkout's origin slug; archived
  Notion pages drop out of the sync active set on 404; initial daemon cycle
  survives failures.

## S-M2-07, delivered by hand after the block

Both providers stayed quota-blocked, so the acceptance session took the card
over and delivered it under the same TDD rule the pipeline follows: five
scenarios, each a red commit followed by a green one, on `story/s-m2-07`.

| Scenario | What it fixes |
|---|---|
| `S-M2-07-record` | The epic fast-forward captures the directories the Story really changed, before the merge, and applies them only after it |
| `S-M2-07-store` | The capture table is durable across a crash, a re-merge supersedes a stale capture, and recovery applies only captures whose Story revision already landed |
| `S-M2-07-deviation` | Prediction deviation as a pure function: directories touched without a prediction, predictions never touched, pooled rate and the share of Stories that under-predicted |
| `S-M2-07-stats` | `/api/stats` and a console statistics page carry the rate |
| `S-M2-07-live` | The live delivery path records the footprint too, so the metric is real before Epic execution exists |

The pipeline had left an uncommitted implementation in its worktree and a red
test whose ordering assertion compared a global mock invocation counter against
an index into a different array, so it could never pass. The assertion was
corrected to express the contract it meant.

## Independent audit of the run

Three reviews covered every commit of the day; the findings, the twelve defects
fixed in response and the ranked backlog are in
[docs/reviews/2026-08-30-m2-audit.md](../reviews/2026-08-30-m2-audit.md). The
headline: the stories produced sound pure functions with real tests, but most
are not reachable from any production path, and S-M2-06 had removed merge
request creation from the pipeline entirely.

## Current blocker

Both configured providers are quota-blocked: `zai-coding-cn` returns 429 code
1113 (balance exhausted), and `openai-codex` reports its usage limit reached
(`xai` has no credentials). S-M2-07 is parked in NEEDS_INPUT with
`retry_limit_exceeded` after three attempts.

Recovery once a provider is available:

```sh
npx tsx scripts/resume-parked-story.ts --card-id S-M2-07
npm run orchestrator:run -- --repository-path "D:\workspace\xiayu\hivemind" --repository-id hivemind --provider openai-codex --model gpt-5.6-terra
```

Then arm the next card with `npx tsx scripts/notion-arm-card.ts --task-id S-M2-07`
is not needed (it is already armed); subsequent cards follow the same
arm → pipeline → review → merge cycle.

## Known follow-ups

- Tokens board property is not projected (cost and rounds are).
- Codex usage-limit parsing (M0-12 regex) is not yet wired into the runner's
  failover path — the manual provider switch done here is M4-05/M4-06's job to
  automate.
- Board view grouping is still a manual Notion UI step from the bootstrap
  runbook.
