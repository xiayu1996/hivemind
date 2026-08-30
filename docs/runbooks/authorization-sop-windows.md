# M0/M1 authorization SOP for Windows

This SOP collects every credential, account decision, browser permission, and external-write authorization needed to finish the remaining M0/M1 live acceptance. Complete it once, then report only readiness states. Never paste a token, password, one-time code, webhook URL, auth file, or screenshot containing those values into chat.

## 1. Security boundary

- Repository code and logs must never contain credentials.
- Project secrets live only in `%USERPROFILE%\.hivemind\secrets.env`.
- pi OAuth credentials live only in `%USERPROFILE%\.pi\agent\auth.json`.
- GitHub CLI keeps its own credential in Windows Credential Manager.
- Browser passwords, MFA prompts, CAPTCHA, purchases, and consent screens are completed by the account owner.
- Do not pass secrets as command-line arguments. Command history and process inspection can expose them.
- Do not use `pi auth --credentials`, `pi auth print-api-key`, or `pi auth print-bearer-token` for acceptance checks.
- IDs such as a Notion page ID or data-source ID are not bearer credentials, but keep them in the same local configuration file so the entire setup remains machine-local.

## 2. Create the Windows secrets file

Open PowerShell as the normal Windows user that will run hivemind, not as Administrator:

```powershell
$hivemindSecretsDir = Join-Path $env:USERPROFILE '.hivemind'
$hivemindSecretsPath = Join-Path $hivemindSecretsDir 'secrets.env'
$currentPrincipal = [Security.Principal.WindowsIdentity]::GetCurrent().Name

New-Item -ItemType Directory -Force -Path $hivemindSecretsDir | Out-Null
if (-not (Test-Path -LiteralPath $hivemindSecretsPath)) {
  New-Item -ItemType File -Path $hivemindSecretsPath | Out-Null
}

icacls.exe $hivemindSecretsDir /inheritance:r /grant:r "${currentPrincipal}:(OI)(CI)(F)"
icacls.exe $hivemindSecretsPath /inheritance:r /grant:r "${currentPrincipal}:(F)"
notepad.exe $hivemindSecretsPath
```

Put this template in the file and fill values locally. Do not add inline comments after values. Configure either Feishu or SMTP; both are allowed.

```dotenv
# Notion
NOTION_TOKEN=
HIVEMIND_NOTION_PARENT_PAGE_ID=
HIVEMIND_NOTION_STORIES_DATA_SOURCE_ID=
NOTION_BOT_USER_ID=
HIVEMIND_NOTION_WEBHOOK_SECRET=

# Feishu, optional when SMTP is configured
FEISHU_WEBHOOK_URL=

# SMTP, optional when Feishu is configured
SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASSWORD=
SMTP_FROM=
SMTP_TO=
```

Leave `HIVEMIND_NOTION_STORIES_DATA_SOURCE_ID`, `NOTION_BOT_USER_ID`, and `HIVEMIND_NOTION_WEBHOOK_SECRET` empty initially. The bootstrap/verification process obtains them after the first two Notion values are available. Remove an unused alert-channel section or leave its values empty.

Verify only the ACL and key names, not values:

```powershell
icacls.exe $hivemindSecretsPath
Get-Content -LiteralPath $hivemindSecretsPath |
  Where-Object { $_ -match '^[A-Z][A-Z0-9_]*=' } |
  ForEach-Object { ($_ -split '=', 2)[0] }
```

## 3. Notion internal connection

### 3.1 Create the connection

The Notion workspace owner performs these steps in the Notion Developer/Creator dashboard:

1. Create an **internal connection** named `hivemind` in the target workspace.
2. Enable the minimum capabilities required by this project:
   - Read content
   - Update content
   - Insert content
   - Read comments
   - Insert comments
   - User information without email addresses
3. Copy the installation access token directly into `NOTION_TOKEN` in the local secrets file.
4. Never send the token through chat, email, screenshots, clipboard-sync software, or a shell command.

The project needs user information without email addresses to distinguish the integration bot from human commenters and to support mentions. Email-address access is not needed.

### 3.2 Grant content access

1. Create a top-level Notion page named `Agent Delivery Hub`.
2. On that page, use **Add connections** and select `hivemind`, or grant the same page in the connection's Content access tab.
3. Grant access only to this page and its descendants, not the whole workspace.
4. Copy the page ID from its URL into `HIVEMIND_NOTION_PARENT_PAGE_ID` locally.

Notion internal connections have no page access until the page is explicitly shared. Sharing the parent grants access to the child databases/pages created beneath it.

### 3.3 Bootstrap the databases

From `D:\workspace\xiayu\hivemind`:

```powershell
npx tsx scripts/notion-bootstrap.ts
```

The command creates the Epics and Stories databases and stores `HIVEMIND_NOTION_STORIES_DATA_SOURCE_ID` plus the integration bot ID in the local secrets file. The returned IDs are not bearer tokens, but do not paste the entire command output into chat.

Then complete the board/view steps in `docs/runbooks/notion-bootstrap.md`. Database/view creation is an external write and must be included in the authorization statement at the end of this SOP.

### 3.4 Obtain the bot user ID

No extra credential is required. The bootstrap command calls Notion's authenticated `users.me` endpoint and writes the returned non-secret bot ID to `NOTION_BOT_USER_ID`. Authorize that read in the final statement; do not expose the token while obtaining the ID.

### 3.5 Webhook subscription

Prerequisites: database bootstrap is complete, pi authentication is ready, and no Story card is in the ready column.

1. Start the local orchestrator on loopback with a model ID returned by pi's model list:

   ```powershell
   npm run orchestrator:run -- --repository-path D:\workspace\xiayu\hivemind --repository-id hivemind --model <validated-model-id>
   ```

2. In a second PowerShell window, start the already-installed quick tunnel:

   ```powershell
   & 'C:\Program Files (x86)\cloudflared\cloudflared.exe' tunnel --url http://127.0.0.1:3212
   ```

3. In the Notion connection's Webhooks tab, create a subscription for:

   ```text
   https://<random-tunnel-host>/webhooks/notion
   ```

4. Subscribe to exactly these events:
   - `page.created`
   - `page.properties_updated`
   - `page.content_updated`
   - `comment.created`
5. The first unsigned verification request is accepted only for bootstrap. hivemind atomically stores its `verification_token` as `HIVEMIND_NOTION_WEBHOOK_SECRET` and does not log it.
6. Copy that value from the local file into Notion's Verify dialog. To copy it without printing it in the terminal:

   ```powershell
   $hivemindSecretsPath = Join-Path $env:USERPROFILE '.hivemind\secrets.env'
   $verificationLine = Get-Content -LiteralPath $hivemindSecretsPath |
     Where-Object { $_.StartsWith('HIVEMIND_NOTION_WEBHOOK_SECRET=') } |
     Select-Object -Last 1
   Set-Clipboard ($verificationLine.Substring($verificationLine.IndexOf('=') + 1))
   Remove-Variable verificationLine
   ```

7. Paste into Notion, verify the subscription, clear the clipboard, and restart the orchestrator while leaving the tunnel running:

   ```powershell
   Set-Clipboard ''
   ```

After verification, every event is accepted only when the raw request body matches Notion's `X-Notion-Signature` HMAC. A quick tunnel needs no Cloudflare account authorization. Its hostname is temporary; recreating it requires recreating the Notion subscription. A named persistent tunnel is outside M1 acceptance and should not be authorized unless a real deployment is being prepared.

### 3.6 Notion validation and revocation

Live validation is allowed to create:

- the two bootstrap databases and their views;
- one clearly named disposable Story/Epic;
- comments, status changes, report blocks, one screenshot upload, and one bot-to-user mention;
- one webhook subscription.

Revocation order:

1. Delete the webhook subscription.
2. Remove the `hivemind` connection from `Agent Delivery Hub`.
3. Refresh/revoke the installation token in the connection dashboard.
4. Remove or archive disposable test pages only after evidence has been recorded.
5. Remove the corresponding local secret lines.

Official references: [Notion internal connections](https://developers.notion.com/guides/get-started/internal-connections), [connection capabilities](https://developers.notion.com/reference/capabilities), and [webhook verification](https://developers.notion.com/reference/webhooks).

## 4. pi and OpenAI authorization

The project runs pi's `openai-codex` provider. This is not the same credential cache as the official Codex CLI:

- pi: `%USERPROFILE%\.pi\agent\auth.json`
- official Codex CLI: `%USERPROFILE%\.codex\auth.json`

Do not copy either auth file between machines. Each worker machine must perform its own interactive authorization.

### 4.1 Account strategy decision

Choose one and report only `A` or `B`:

- **A — one worker machine, one independently authorized ChatGPT account (recommended and already designed):** best isolation for refresh rotation, quota windows, and 7x24 risk. Every always-on machine logs in locally; credential files are never copied.
- **B — single-account broker:** not implemented in M0/M1 and changes the architecture. Choosing it allows this Windows single-machine acceptance but blocks multi-machine acceptance until the broker exists.

Purchasing a subscription, changing billing, or creating an OpenAI API key is never delegated. The account owner performs those actions directly.

### 4.2 Interactive pi login on Windows

Run:

```powershell
$piBin = Join-Path $env:USERPROFILE '.hivemind\pi\0.84.3\pi\pi.exe'
& $piBin
```

Inside pi:

1. Enter `/login openai-codex`.
2. Choose **Browser login** on this Windows machine. Use **Device code login (headless)** only on a machine where the browser callback cannot work.
3. Complete the OpenAI browser consent and MFA yourself.
4. Return to pi and wait for success.
5. Enter `/exit` or press Ctrl+C.

Do not paste a browser one-time code into chat. Do not give the account password or MFA code to Codex.

### 4.3 Protect and probe the pi credential

```powershell
$piAuthPath = Join-Path $env:USERPROFILE '.pi\agent\auth.json'
$currentPrincipal = [Security.Principal.WindowsIdentity]::GetCurrent().Name
icacls.exe $piAuthPath /inheritance:r /grant:r "${currentPrincipal}:(F)"

$probeJson = & $piBin auth check --provider openai-codex --json --no-refresh
$probe = $probeJson | ConvertFrom-Json
if ($probe.status -ne 'ready') {
  throw "pi provider is not ready: $($probe.reason)"
}
$probe | Select-Object status, provider, authType
```

The `--no-refresh` probe is mandatory: it is read-only and does not consume or rotate the refresh token. pi returns exit code 0 even for `not_ready`, so validation must parse `status` exactly as above.

List only valid model IDs after login:

```powershell
& $piBin --offline --list-models openai-codex
```

OpenAI supports ChatGPT subscription login and API-key usage-based login for its own Codex clients; browser login returns credentials to the local client, and local auth files must be treated like passwords. For this repository, use pi's interactive `/login` flow because pi owns a separate, incompatible cache. See [OpenAI Codex authentication](https://developers.openai.com/codex/auth).

### 4.4 Logout/revocation

pi login/logout is an interactive TUI operation. Use pi's account/provider UI to remove the `openai-codex` credential, then confirm the no-refresh probe returns a non-ready state. If an OpenAI session itself must be revoked, use the account's official security/session controls. Do not manually edit or copy token fields.

## 5. GitHub authorization

This Windows environment is already authenticated through GitHub CLI and uses SSH for Git operations. No GitHub credential needs to be added to `secrets.env`.

For a fresh machine, the account owner runs:

```powershell
gh auth login --hostname github.com --git-protocol ssh --web
gh auth status --hostname github.com
git ls-remote origin HEAD
```

Minimum project scope is repository read/write and pull-request creation for `xiayu1996/hivemind`. Do not grant organization administration, package deletion, billing, or unrelated repository access. Add `workflow` scope only if a later task must modify workflow files and GitHub explicitly requires it.

The M0/M1 external-write authorization should explicitly allow:

- pushing only the `codex/m0-m1-windows` branch and later task branches;
- updating the existing pull request;
- reading CI status and PR metadata;
- never pushing directly to the default branch and never merging without a separate request.

Local logout:

```powershell
gh auth logout --hostname github.com
```

For full revocation, also revoke the GitHub CLI OAuth authorization in GitHub account settings. SSH keys are revoked separately.

## 6. Out-of-band alert authorization

At least one alert channel is required because a Notion mention alone is not accepted as the only blocking-question path.

### 6.1 Feishu custom bot

1. Create or choose a private Feishu group for hivemind operators.
2. Add a custom bot with permission only to post to that group.
3. Copy its incoming webhook URL directly into `FEISHU_WEBHOOK_URL` locally.
4. Do not paste the webhook URL into chat or a shell command.
5. Authorize one real P0 smoke message to that group.

The current adapter supports the webhook URL. If workspace policy mandates an additional Feishu signing secret, use SMTP for M1 acceptance or authorize a separate implementation change; do not weaken the workspace policy.

Revoke by deleting/rotating the bot webhook and removing the local line.

### 6.2 SMTP

Use a dedicated app password or SMTP credential, never the mailbox's primary password. Fill:

- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_SECURE` (`true` for implicit TLS, commonly port 465; otherwise `false`, commonly STARTTLS on 587)
- `SMTP_USER`
- `SMTP_PASSWORD`
- `SMTP_FROM`
- `SMTP_TO` (comma-separated recipients are supported)

Authorize one real P0 smoke email to the configured recipients. Revoke by deleting the app password/SMTP credential and removing the local lines.

### 6.3 Smoke check

After configuring one or both channels:

```powershell
npx tsx scripts/smoke-alert.ts
```

The script reports only delivered channel names. If both channels are configured, it sends through both.

## 7. Browser and Windows GUI authorization

Credentials are not the same as permission to control a signed-in browser. If you want Codex to finish Notion setup in the existing Chrome session, explicitly authorize all of the following that apply:

- control the currently signed-in Chrome window for Notion only;
- open the Notion Creator dashboard and target workspace;
- create/configure the internal connection and webhook subscription;
- create the Agent Delivery Hub databases/views and disposable test cards;
- read non-secret IDs from the UI and store them locally;
- never read, reveal, change, or store the Notion account password or MFA secret;
- never change billing, workspace membership, SSO, security policy, or unrelated pages.

Keep the Notion session signed in. When a password, MFA, CAPTCHA, or irreversible consent screen appears, the account owner completes it.

## 8. Phone notification authorization for M0-09

No phone credential or phone number is required.

1. Sign in to the Notion mobile app with the intended human operator account.
2. Enable Notion notifications at both OS and app level.
3. Temporarily disable Focus/Do Not Disturb for the test window.
4. Authorize hivemind's Notion bot to create one test comment mentioning that account.
5. Report only `received` or `not received`, plus the receive time if available.
6. If evidence is a screenshot, store it locally under the project evidence directory after checking that it contains no token, email address, private notification, or unrelated workspace content.

The test must be bot-to-human. A self-mention made through a connector is not valid evidence.

## 9. Mac mini authorization for M0-15

M0-15 cannot be completed on Windows. It requires the actual Mac mini user session and one reboot.

The Mac owner should:

1. Make the intended worker account a normal macOS user and log in to its GUI session.
2. Install the pinned pi build with `scripts/install-pi.sh` from the repository checkout.
3. Run pi interactively in that same user session and complete `/login openai-codex`; use device-code login if needed.
4. Do not copy Windows/Linux `auth.json` to the Mac.
5. Protect `~/.pi/agent/auth.json` with mode 600.
6. Install the project LaunchAgent under that user, not a root LaunchDaemon.
7. Explicitly authorize a single controlled Mac reboot for the persistence test.
8. After reboot and GUI login, run `pi auth check --provider openai-codex --json --no-refresh` and require `status: ready`.

If remote access is used, enable macOS Remote Login only for the worker user and authenticate with a dedicated SSH public key. Send only the Mac hostname/IP and username through chat; never send a password, private key, recovery key, or device-code token. Disable remote access or remove the dedicated public key after acceptance if it is no longer required.

If no Mac mini is currently available, report `Mac mini unavailable`; M0-15 remains explicitly deferred to M3 rather than being simulated on Windows.

## 10. External side-effect authorization

Credentials alone do not authorize external mutations. To finish the live run in one pass, grant or deny these scopes explicitly:

- create/update the scoped Notion connection resources, databases, pages, properties, blocks, comments, files, and webhook;
- create disposable test Story/Epic records and archive/delete only those clearly marked as test resources;
- send one Notion mention and one Feishu and/or SMTP P0 smoke alert;
- control the existing signed-in Chrome session within the Notion scope described above;
- push task branches and update the existing GitHub PR, but do not push the default branch or merge;
- reboot the Mac mini once, only if M0-15 is being executed now;
- install project-required local dependencies (already granted separately);
- exclude purchases, billing changes, account-password changes, workspace membership changes, and unrelated external resources.

## 11. One-time completion reply

After all locally available setup is complete, reply with this template and no credential values:

```text
本地凭据：已按 SOP 放置
Notion connection/page access：已完成
Notion 浏览器会话：已登录
pi openai-codex：ready
账号策略：A / B
GitHub：沿用当前登录
告警通道：飞书 / SMTP / 两者
手机通知：已准备
Mac mini：可用 / 当前不可用

外部写入授权：允许按 SOP 创建、更新和清理测试资源
Chrome 控制授权：允许，仅限 SOP 的 Notion 范围
测试消息授权：允许发送一次 Notion mention 和一次 P0 告警
GitHub 授权：允许推送任务分支并更新现有 PR；禁止直接推默认分支和合并
Mac 重启授权：允许一次 / 不允许 / Mac 当前不可用
```

After that reply, readiness checks will inspect only presence/status and will redact values. Any missing item will be reported together after the complete audit, not requested one by one.
