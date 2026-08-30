# M1 live acceptance on Windows

This runbook executes only after all credentials are available together. Never put token values in commands, repository files, screenshots, terminal transcripts or chat.

## Required local configuration

Store credentials in `~/.hivemind/secrets.env`, readable only by the current Windows user:

- `NOTION_TOKEN`
- `HIVEMIND_NOTION_PARENT_PAGE_ID`
- `HIVEMIND_NOTION_STORIES_DATA_SOURCE_ID` after bootstrap
- `HIVEMIND_NOTION_WEBHOOK_SECRET`, captured automatically during webhook subscription verification
- either `FEISHU_WEBHOOK_URL`, or all SMTP values described in `scripts/smoke-alert.ts`

Provider authentication remains in `~/.pi/agent/auth.json`. GitHub CLI authentication is probed separately and is never copied into the secrets file.

## Notion bootstrap

1. Run `npx tsx scripts/notion-bootstrap.ts --parent <parent-page-id>`.
2. Persist the returned Stories data-source ID as `HIVEMIND_NOTION_STORIES_DATA_SOURCE_ID`.
3. Complete the board-view steps in `notion-bootstrap.md`.

## Webhook bootstrap

1. Start the local orchestrator on loopback. It can start without a webhook secret and will accept only the one-time verification payload on the unsigned path.
2. In a second terminal, start the installed tunnel:

   ```powershell
   & 'C:\Program Files (x86)\cloudflared\cloudflared.exe' tunnel --url http://127.0.0.1:3212
   ```

3. Create the Notion connection webhook subscription for `<tunnel-url>/webhooks/notion`, using API version 2025-09-03 and the four events consumed by the service.
4. The route stores the received verification token as `HIVEMIND_NOTION_WEBHOOK_SECRET` and logs only that capture succeeded. Complete verification in the Notion UI without copying the token into a terminal or chat.
5. Restart the orchestrator while leaving the tunnel running. Subsequent events require the exact raw-body HMAC signature.

The handshake follows the [official Notion webhook verification protocol](https://developers.notion.com/reference/webhooks).

## Unattended Story

Start the service from the hivemind checkout:

```powershell
npm run orchestrator:run -- --repository-path D:\workspace\xiayu\hivemind --repository-id hivemind --model <validated-model-id>
```

Create one small Story in the bootstrapped board with a unique task ID, repository, target branch and a non-empty requirement section, then move it to the ready column. Do not invoke the worker manually. The service must ingest the card, create an isolated worktree, run DESIGN, CODE, independent VERIFY and MERGE, publish the Story branch, create the MR, and converge both properties and page blocks from central libsql.

## Evidence

Record only non-secret evidence:

- all four M1-37 exit criteria;
- three visible verification rounds with stable Spec block IDs;
- webhook-on latency and a webhook-off 60-second fallback cycle;
- one ingested real comment and one screenshot upload;
- one delivered Feishu or SMTP alert;
- EventLog, canonical trace, exact provider-payload round trip, phase costs, guard audit and MR URL agreement.
