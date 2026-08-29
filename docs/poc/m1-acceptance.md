# M1 end-to-end acceptance

> Status: in progress on Windows, 2026-08-29. This document does not claim the M1 exit gate has passed.

## Verified locally

| Area | Evidence | Result |
|---|---|---|
| Unit and integration suite | `npm test` | 42 files, 321 tests passed |
| Type, lint and builds | `npm run typecheck`; `npm run lint`; `npm run build`; `npm run build:console` | Passed |
| Empty database migration | `HIVEMIND_DB_URL=file:<temporary path> npm run db:migrate` | `0001_init.sql` applied on Windows; the Windows ESM entry-point bug found during this run was fixed |
| Windows pi RPC | Git Bash invocation of `scripts/smoke-windows-rpc.ts` | 10/10 handshakes and real bash tool calls; no framing error or hang |
| Guard | `npx tsx scripts/smoke-guard.ts` | Red lines and five VERIFY write paths blocked; local audit written |
| Context isolation | `npx tsx scripts/smoke-context-isolation.ts` | Ancestor context excluded; explicitly approved context and SHA-256 recorded |
| Completion verifier | `npx tsx scripts/smoke-completion-verifier.ts` | Fresh real pi session returned one fail-closed completion decision |
| Blind VERIFY | `npx tsx scripts/smoke-blind-verify.ts` | Fresh session, read-only guard, observed scenario result in the real pi trajectory |
| Canonical log and cost | `npx tsx scripts/smoke-observability-console.ts` | Rebuilt request matched the actual provider request after JSON normalisation; ledger matched pi `usage.cost` |
| Console | In-app browser against `http://127.0.0.1:3211` | Nodes, task/EventLog/trace, costs and config pages showed database-backed data; read-only Bull Board loaded |

## External acceptance still required

The current machine has no `~/.hivemind/secrets.env`. The no-refresh credential probe also reports `openai-codex` as `not_ready` with `credentials_not_configured`. Therefore these claims remain deliberately unverified:

- M1-17 through M1-22: create the real Notion databases, run three page update rounds, ingest a real comment, verify webhook-off polling, drag a board card, and upload a screenshot.
- M1-35: deliver one real Feishu webhook or SMTP alert.
- M1-37: run one real Notion card unattended through DESIGN, CODE, VERIFY, MERGE and MR creation, then verify all four exit criteria.

M1-30 passed both CLI adapter contract suites and the adapter created [GitHub PR #1](https://github.com/xiayu1996/hivemind/pull/1).

## Exit criteria status

1. Unattended real card: not run.
2. Complete Notion page: not run.
3. EventLog, trace and cost agree: passed on the real local pi smoke run, but not yet on the real Notion card.
4. Guard injection and dual audit: guard smoke passed; the end-to-end card injection is not run.
