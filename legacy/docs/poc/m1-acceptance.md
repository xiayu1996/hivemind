# M1 end-to-end acceptance

> Status: live acceptance executed on Windows, 2026-08-30. Provider: `zai-coding-cn` (zcode coding plan) with `glm-5.2`.

## Verified locally

| Area | Evidence | Result |
|---|---|---|
| Unit and integration suite | `npm test` | 59 files, 363 tests passed |
| Type, lint and builds | `npm run typecheck`; `npm run lint`; `npm run build` | Passed |
| Windows pi RPC | Git Bash invocation of `scripts/smoke-windows-rpc.ts` | 10/10 handshakes and real bash tool calls; no framing error or hang |
| Guard | `npx tsx scripts/smoke-guard.ts` | Red lines and five VERIFY write paths blocked; local audit written |
| Context isolation | `npx tsx scripts/smoke-context-isolation.ts` | Ancestor context excluded; explicitly approved context and SHA-256 recorded |
| Completion verifier | `npx tsx scripts/smoke-completion-verifier.ts` | Fresh real pi session returned one fail-closed completion decision |
| Blind VERIFY | `npx tsx scripts/smoke-blind-verify.ts` | Fresh session, read-only guard, observed scenario result in the real pi trajectory |
| Canonical log and cost | `npx tsx scripts/smoke-observability-console.ts` | Rebuilt request matched the actual provider request after JSON normalisation; ledger matched pi `usage.cost` |
| Single-Story production chain | `npx tsx scripts/smoke-story-pipeline.ts` | Real `pi.exe` completed DESIGN, CODE, independent VERIFY and MERGE; central libsql stored all runs/artifacts/costs |
| zai-coding-cn provider | real pi RPC smoke (handshake, one completion, clean stop) | `auth check` ready (api_key); usage and cost recorded |

## Live Notion acceptance (2026-08-30)

Credentials live in `~/.hivemind/secrets.env` per `docs/runbooks/authorization-sop-windows.md`.

| Criterion | Evidence | Result |
|---|---|---|
| M1-17 bootstrap | `scripts/probe-notion-live.ts`: token valid, bot identity matches, Stories data source carries all 16 properties | Passed |
| M1-18 page delivery | `scripts/live-notion-delivery.ts`: four consecutive rounds on a real page; Spec block ids stable across all rounds; three verification toggles appended append-only | Passed |
| M1-22 media pipeline | Real PNG uploaded through File Upload, attached as an image block under the metadata callout, upload id and block id recorded | Passed |
| M1-37 unattended card | Card `S-VAL-01` armed on the board; the orchestrator ingested it, cut `story/s-val-01` from `main`, ran DESIGN, CODE (TDD, 6 scenario tests), independent blind VERIFY, MERGE report, pushed the branch and created [GitHub PR #2](https://github.com/xiayu1996/hivemind/pull/2) | Passed |
| M1-37 criterion 1 | No manual worker invocation; the service loop picked the card up on its own | Passed |
| M1-37 criterion 2 | Story page carries all five sections, six verification-round toggles, MR/cost/round properties and the sync fingerprint | Passed |
| M1-37 criterion 3 | `cost_entries` 16 rows totalling `$0.66073244` equals the Notion `成本(USD)` property; `event_log` holds the full transition/phase/verdict history; per-run canonical provider captures round-trip | Passed |
| M1-37 criterion 4 | Guard audit channel: 216-entry `tool-audit.jsonl`; VERIFY session bash writes blocked by hive-guard ("shell write is forbidden in VERIFY"); tree-pin unchanged per run | Passed |
| Acceptance review | PR #2 diff reviewed by the acceptance session; CI check passed (26s); merged | Passed |

Self-hosting board: `scripts/seed-notion-tasks.ts` created 4 epics and 50 task cards (M2–M5) with the independent-PR delivery constraint in every requirement; cards stay unarmed until a human moves them to the ready column.

## Remaining gaps

- M1-19: a real human-authored comment has not been ingested (bot comments are filtered by design); waiting for an operator comment on a story page.
- M1-20 webhook live subscription: `HIVEMIND_NOTION_WEBHOOK_SECRET` is still empty, so events fall back to the 60-second active-set poll, which is verified working; tunnel + Notion UI subscription still pending.
- M1-21 drag intent: card transitions were driven by operator recovery scripts through the store, not by a real board drag; the intent path itself is unit-tested and the poller runs live.
- M1-35: no Feishu webhook or SMTP credentials, so no real out-of-band alert was delivered; the router now warns at startup and needs_input surfaces through the Notion board only.
- M1-18/M1-22 archive path (round >8): covered by integration tests, not re-run live.
- Tokens board property is not projected yet (cost and rounds are); fold into a follow-up card.

## Exit criteria status

1. Unattended real card: passed (S-VAL-01, PR #2, merged after review).
2. Complete Notion page: passed (live page verified).
3. EventLog, trace and cost agree: passed (central ledger equals board projection; per-run provider captures archived).
4. Guard injection and dual audit: passed (audit channel live in the real run; five write paths blocked in the VERIFY session).
