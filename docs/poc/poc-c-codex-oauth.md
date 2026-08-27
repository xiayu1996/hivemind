# PoC-C1–C5：Codex（ChatGPT 订阅 OAuth）机制核实

> 执行日期 2026-08-27 · pi 0.84.3 · 结论：**机制面全部核实（含两处设计修正）；活体登录项待 M0-01 决策后执行**

## 为什么没有直接跑活体登录

登录需要用 Ryan 本人的 ChatGPT 账号在浏览器完成授权，属账号级动作；且"用哪个账号、要不要
再买一份订阅"正是 M0-01 待决策项。因此本轮只做**不触碰账号的机制核实**：从 0.84.3 的
发行二进制里读出真实实现，而不是依赖文档措辞。

## 修正一：没有 `pi auth login`，登录只在 TUI 里

06 文档写的是"pi 内置 device code 无头登录"。实际 CLI 只有三个 auth 子命令：

```
pi auth print-api-key      [--provider <p>] [--model <m>]
pi auth print-bearer-token [--provider <p>] [--model <m>] [--min-expiry <d>]
pi auth check              [--provider <p>] [--model <m>] [--json] [--credentials] [--no-refresh]
```

登录是**交互式 TUI 的 `/login` 斜杠命令**。device code 确实存在，但作为 `/login` 里
openai-codex 的一个登录方式选项（二进制内字面量：`{ id: "device_code", label: "Device code login (headless)" }`）。

**运维含义不变但步骤要改**：无头机器上仍可登录，方式是 ssh 进去跑一次交互式 `pi`、
执行 `/login` 选 device code、拿 user_code 去浏览器授权。这是**一次性带外手工步骤**，
不能脚本化、不能进 ansible/systemd 首启流程。新机器接入手册必须显式包含这一步。

## 修正二：`pi auth check` 的退出码不可用于判定

```
$ pi auth check --provider openai-codex --json     # 无凭据时
{"status":"not_ready","provider":"openai-codex","reason":"credentials_not_configured"}
$ echo $?
0
```

**not_ready 时退出码仍是 0**。凭据探针必须解析 JSON 的 `status` 字段，
任何 `if pi auth check; then` 形式的健康检查都会永远判定为健康。

## 核实通过的机制

| 项 | 证据 | 结论 |
|---|---|---|
| C1 device code 登录存在 | 二进制内 `OPENAI_CODEX_DEVICE_CODE_LOGIN_METHOD = "device_code"` + `"Device code login (headless)"` | 存在，入口在 TUI |
| C3 探针零副作用 | `--no-refresh` 明确阻止刷新（`auth --help`：Checks refresh expired OAuth credentials by default; --no-refresh prevents this） | 参数语义确认；mtime 不变待活体复测 |
| C4 同机并发刷新锁 | `proper-lockfile.lock(this.authPath, …)` — 对 auth.json 加文件锁 | **同机**并发安全成立；跨机无效（文件锁不跨主机），一机一账号结论不变 |
| 凭据路径 | `authPath: join(agentDir, "auth.json")` | `~/.pi/agent/auth.json`，与 `~/.codex/auth.json` 相互独立 |
| usage-limit 不被自动重试 | `attempt < maxRetries && … && !lastError.message.includes("usage limit")` | pi 自己就不重试配额撞墙，不会出现静默空转 |

`~/.pi/agent/auth.json` 与 `~/.codex/auth.json` 是**两套独立凭据**，由各自的登录流程签发。
因此在本机给 pi 登录**不会**弄坏已有的 codex CLI 登录态（两条 refresh token 链互不相干）。
真正会互踩的是"把同一份 auth.json 复制到多台机器"——refresh token 轮换会让先刷新的一方
让另一方失效。**一机一账号的结论保持不变**，但理由要精确到"不复制凭据文件"，
而不是"一台机器上只能有一个 OAuth 客户端"。

## C2：usage-limit 文案解析 —— 解析器已完成并单测通过

文案模板不靠撞墙猜测，直接从 0.84.3 二进制读出构造逻辑：

```js
const plan = err.plan_type ? ` (${err.plan_type.toLowerCase()} plan)` : "";
const mins = err.resets_at ? Math.max(0, Math.round((err.resets_at * 1000 - Date.now()) / 60000)) : undefined;
const when = mins !== undefined ? ` Try again in ~${mins} min.` : "";
friendlyMessage = `You have hit your ChatGPT usage limit${plan}.${when}`.trim();
```

解析器 `poc/codex-oauth/usage-limit-parser.mjs` + 8 条单测（`usage-limit-parser.test.mjs`，全绿），
用例由同一模板反向生成，因此不会与 pi 实际产出漂移。覆盖：有/无 plan、有/无窗口、
0 分钟钳位、被外层文本包裹、非配额错误不误判、≤15min 走 defer 与 >15min 走 failover 的分界。

**一个必须记住的坑**：`resets_at` 是绝对时间戳，但 pi 在生成字符串那一刻就把它折算成了
"还有几分钟"。所以解析出来的分钟数**必须锚定到该事件自身的时间**，
不能锚定到"我们读到它的时间"——事件在 outbox 里积压过就会算错窗口。

## 待活体执行（M0-01 决策后）

| 项 | 判据 | 阻塞原因 |
|---|---|---|
| C1 活体 | device code 登录 → RPC 跑通一轮 → 过期后自动刷新且 auth.json expires 更新 | 需账号授权 |
| C2 活体 | 真实撞墙一次，确认 errorMessage 与模板一致 | 需订阅账号且需真的耗尽窗口 |
| C3 活体 | 连续 `auth check --no-refresh` 后 auth.json mtime 不变 | 需已登录状态 |
| C4 活体 | 双 pi 子进程逼近过期并发刷新，均成功且无 invalid_grant | 需已登录状态 |
| C5 | Mac mini LaunchAgent 会话下重启后登录态仍有效 | 需 Mac mini（本机非目标节点，未组网不可达） |
