# Codex（ChatGPT 订阅 OAuth）集成机制设计

> 2026-08-25 增补。基于两路实证调研：cumora 的 CodexAdapter（codex CLI app-server 路线）与 pi v0.84.3 的 openai-codex provider 源码（hivemind 实际走的路线）。

## 1. 两条集成路线与 hivemind 的选择

| | cumora 路线 | pi 路线（hivemind 采用） |
|---|---|---|
| 进程形态 | spawn 官方 `codex app-server --listen stdio://`，JSON-RPC thread | pi 内置 openai-codex provider，直连 `chatgpt.com/backend-api`（Responses API，SSE+WebSocket） |
| OAuth 归属 | **零介入**：用户每台机器人工 `codex` 登录，凭据由 codex CLI 在 `~/.codex` 自管自刷 | pi 自管：`/login` 流程 + `~/.pi/agent/auth.json` + 自动刷新 |
| reasoning effort | 无通道（只能改 `~/.codex/config.toml`） | 原生支持 `:minimal…:xhigh/:max` 档位 |
| 对 hivemind 的价值 | 运维教训（GUI 会话/keychain、僵尸进程、多机无配额协调） | 直接使用的机制本体 |

hivemind 走 pi 路线（provider 抽象、成本、reasoning 档位都齐），cumora 的教训作为加固清单吸收（§7）。

## 2. pi 的 OAuth 机制（v0.84.3 源码核实）

- **client_id 复用官方 Codex CLI**（`app_EMoamEEZ73f0CkXaXp7hrann`），且**不伪装**：authorize URL 带 `originator=pi`，请求头 `originator: pi` + pi 的 User-Agent——OpenAI 完全识别 pi 流量并照常服务。
- **两种登录**（`/login` 是 TUI 交互命令，**RPC 协议没有 auth 命令**→ 登录必须是带外人工步骤）：
  1. Browser 流：本地 1455 端口回调（PKCE S256）；SSH 场景可把最终重定向 URL 整段粘回终端；
  2. **Device code 流（headless，已内置）**：终端显示 user code → 任意设备访问 `auth.openai.com/codex/device` 输入，15 分钟超时。
- **token 落盘** `~/.pi/agent/auth.json`（0600；`PI_CODING_AGENT_DIR` 可改目录）：`{type:"oauth", access:<JWT>, refresh, expires:<epoch 毫秒>, accountId}`。**与官方 `~/.codex/auth.json` 格式不兼容**（复用官方登录结果需手工字段映射）。
- **自动刷新**：剩余 <5min 触发，双检锁（proper-lockfile 文件锁，锁内二次检查 + 写回）——**跨进程有效但仅限同机同文件系统**；v0.84.3 已修并发启动锁竞争误报（pi#1871）。
- **⚠️ refresh token rotation（一次性）**：每次刷新换发新 refresh token，旧的立即作废（codex#10332 实证）。**这是多机方案的决定性约束。**

## 3. 请求形态与模型

- endpoint `chatgpt.com/backend-api`，头带 `Authorization: Bearer <JWT>` + `chatgpt-account-id`（请求时从 JWT 现场解出）；`store:false`；请求体 zstd 压缩；`session-id` 头做 prompt cache 亲和。
- transport `auto`（SSE / WebSocket / websocket-cached，含 60min 连接上限前主动轮换）；`websocket_connection_limit_reached` → 降级 `sse` 重试。
- 现役 model（v0.84.3 catalog）：`gpt-5.6-sol`（旗舰）/ `gpt-5.6-terra`（中档）/ `gpt-5.6-luna`（低价）272K ctx，仅 5.6 系支持 `:max`；`gpt-5.5` / `gpt-5.4` / `gpt-5.4-mini`。**模型分层表（02 文档 §5.1）的 codex 列据此落位：大脑=gpt-5.6-sol:xhigh，中脑=gpt-5.6-terra:medium**；小脑仍走 GLM/Grok（不占订阅窗口）。cumora 实测教训：ChatGPT 账号下小模型名不能想当然（`gpt-5-mini` 被拒、`gpt-5.4-mini` 可用），model id 全部走动态配置。

## 4. 配额与错误分诊

- **pi 不解析 5h 窗口配额头**（官方 codex CLI 读 `x-codex-primary-*` 画进度条，pi 没做）——拿不到"窗口还剩多少"，只能撞墙时得知。撞墙文案（结构被揉进文案，`resets_at` 已丢）：
  `You have hit your ChatGPT usage limit (plus plan). Try again in ~57 min.`
- **hivemind 错误分诊表**（进 run-failure 分类器，正则 + 优先 RPC 结构化字段）：

| errorMessage 匹配 | 含义 | 动作 |
|---|---|---|
| `hit your ChatGPT usage limit`（解析 `~(\d+) min`） | 5h/周窗口撞墙 | 该 worker 的 codex 通道**挂起到重置时间**（真实 reset 分钟数，取代固定 15min 阈值猜测）；卡按 02 §5.3 defer 或 failover 横移 |
| `OAuth refresh failed for openai-codex` | refresh token 失效 | **P0 告警**，该机 codex 下线，需人工 `/login` 重登 |
| `No API key found for openai-codex` | 凭据缺失（或锁竞争误报） | 先 `pi auth check --json --no-refresh` 确认真假 |
| `websocket_connection_limit_reached` | 同账号 WS 连接超限 | 降级 `transport: sse` 重试 |

- **settings.json 硬性要求**：`retry.provider.maxRetries: 0`（官方警告：>0 会让 SDK 层吞掉 usage-limit 错误把 agent 挂死到配额重置），agent 层 `retry {enabled, maxRetries:3, baseDelayMs:2000}`。usage-limit 文案在 pi 的可重试分类里两边都不匹配 → 快速失败不烧配额（正确行为，保持）。
- **事件消费**：以 `agent_settled` 为一轮真正终态（`agent_end` 后可能还有 retry/compaction）。

## 5. 多机凭据方案

### 决定性约束

refresh token rotation：N 台机器复制同一份 auth.json → 谁先刷新谁存活，其余全部 `invalid_grant` 报废。pi 的文件锁只保同机。cumora 侧印证：多机就是每台独立登录，**没有任何跨机配额协调**（三台共用一个账号时三个 pacer 互相看不见）。

### 方案 A（推荐）：一机一账号，本地自治

```
Linux worker   → ChatGPT 账号 1 → 本机 ~/.pi/agent/auth.json（唯一副本）
Mac mini worker → ChatGPT 账号 2 → 同上
Windows worker  → 不跑 pi CODE（探针二等公民），不需要 codex 凭据
```

- 同机多 pi 子进程**共享同一份 auth.json**（靠 pi 内建文件锁串行刷新）；**绝不 per-worker 设 `PI_CODING_AGENT_DIR` 复制副本**（rotation 互踩）。
- 登录：每机一次性人工 device code 流；后续刷新全自动。
- 保活：worker daemon 内定时（30–40min）`pi auth print-bearer-token --provider openai-codex --min-expiry 1h`，失败即告警。
- 优点：规避 rotation；每账号 5h 窗口独立，**跨机配额协调问题消失大半**；避开"单账号当共享基础设施"的风控画像。成本 ≈ 每账号一份 Plus 订阅，远低于封号申诉的停摆成本。

### 方案 B（仅在无法多开账号时）：中心 token broker

orchestrator 唯一持有 refresh token，定时（40min，须显著短于 access TTL）刷新并把 access token 推到各 worker 的 auth.json（refresh 字段置假值）。**很脆**（依赖精确定时；推迟即全线 `OAuth refresh failed`）且单账号多机并发仍是风控红旗。不推荐。

### 方案 C（未来）：Codex PAT

pi 生态有 `pi-codex-token` extension（`CODEX_ACCESS_TOKEN` 环境变量非交互认证，专为 headless 设计）——但 PAT 是 **Business/Enterprise 特性**，个人 Plus/Pro 签不出来。若未来升级计划，这是最干净的多机方案。

### 兜底供应商凭据（day1 配好）

GLM/Grok（api_key 类）用 pi 的 `!command` 动态取密（`"!op read ..."` 或本地密管），凭据不落盘——**该机制仅对 `type: api_key` 生效，OAuth 字段永远不会被当命令解析**；`!command` 结果按进程生命周期缓存，轮换后需重启 pi 子进程。

## 6. 健康探测与控制台集成

- **探活命令**（只读不写盘、**不消耗 refresh token**）：`pi auth check --provider openai-codex --json --no-refresh` → `{status: ready|not_ready|invalid, reason}`。
- 接入既有设计：worker 心跳 payload 的 `credentialProbe` 字段（05 文档 §5）就用这个命令的结果；`status != ready` → CredentialHealth per-provider 熔断（02 文档 §5.4）+ 控制台节点健康页红条 + 告警文案直接给出该机的重登指引（cumora 模式："去那台机器上刷新登录"）。
- **usage 窗口可视化**：pi 不暴露窗口余量 → 控制台的"Codex 订阅窗口观测"退化为**撞墙事件史 + reset 倒计时**（从 usage-limit 文案解析），并按账号（=机器）分列。
- **日志脱敏**：auth.json、`print-bearer-token` 输出、pi debug log 均含明文 JWT——观测导出的 record waterfall（04 文档 §2.3）必须内置 `eyJ[A-Za-z0-9_-]{20,}` 过滤规则；规范日志本地留全量但 EvidenceStore/Notion 出口一律过滤。

## 7. 从 cumora 吸收的加固清单

| # | 教训 | hivemind 落点 |
|---|---|---|
| 1 | app-server 握手失败后进程不退，naive 存活检查复用僵尸 → agent 静默永久死亡（cumora 最贵教训） | PiRunner：RPC 初始化/首响应失败视为 session 级致命，**杀进程重建**，绝不复用可疑子进程；invariants 注册"spawn→首事件"配对检查 |
| 2 | Codex 持久 session 无 turn 超时 | 不加 wall-clock 上限（设计原则），靠 StallWatchdog 静默检测 + 循环检测兜底（已有） |
| 3 | usage limit 打在 stdout 而非 stderr | 探针与错误采集同时扫两条流；pi 路线下主要靠结构化 errorMessage，但自研探针脚本保留此注意点 |
| 4 | `usage limit` 被归入"临时限流"静默重试，订阅真耗尽时表现为空转、用户不知情 | 分诊表把 usage-limit 独立成类：挂起 + 控制台可见 + reset 倒计时，**不静默** |
| 5 | macOS 凭据依赖 GUI 会话 keychain | Mac mini 用 LaunchAgent（用户会话）——与 02 文档 §6.1 既有决策一致，此处补充了"为什么" |
| 6 | 跨机无配额协调 | 方案 A（一机一账号）从根上消解；若走方案 B 则 orchestrator 必须维护全局窗口状态 |

## 8. 风险评估（修订 00-overview R0）

- **官方态度：明确背书**。OpenAI 的 Codex for OSS 计划点名支持 pi（公开表态 pi+opencode 已占 Codex 流量约 10%）；pi 不伪装身份仍被照常服务——比任何"没被封"传闻更有说服力。未发现 pi/cumora 用户被封的公开案例。
- **但背书是"容忍"不是"合同"**：ToS 保留随时终止权；对无人值守自动化、跨机共享零承诺。**Anthropic 先例**：2026-02 起禁止订阅 OAuth 用于第三方工具、2026-04 强制按 token 计费——同样的事 OpenAI 随时可做，这是 day1 押注 Codex 的最大战略风险。
- 风控画像共识："单账号 + 多机 + 24x7 重度自动化"叠加最危险——方案 A 同时是风控缓解。
- **缓解**：failover 链（GLM/Grok 可整体接管）day1 配好 + 凭据探针最早发现 + 成本账本让"切 API 计费"的备选随时可算账。

## 8.5 M0 实测修订（2026-08-27）

完整记录见 `docs/poc/poc-c-codex-oauth.md`。三点必须落到实现与手册：

1. **没有 `pi auth login` CLI**。auth 子命令只有 `print-api-key` / `print-bearer-token` / `check`。
   device code 登录确实存在（二进制内 `"Device code login (headless)"`），但入口是**交互式 TUI 的 `/login`**。
   无头机器的登录方式是：ssh 进去跑一次交互式 `pi` → `/login` 选 device code → 拿 user_code 去浏览器授权。
   这是**一次性带外手工步骤**，不可脚本化，新机器接入手册必须显式包含。

2. **`pi auth check` 的退出码不可信**：无凭据时输出
   `{"status":"not_ready","reason":"credentials_not_configured"}` 而 **exit code 仍为 0**。
   凭据探针必须解析 JSON `status` 字段，`if pi auth check; then` 形式会永远判定为健康。

3. **一机一账号的理由要精确化**。`~/.pi/agent/auth.json` 与 `~/.codex/auth.json` 是两套独立凭据，
   由各自登录流程签发——在同一台机器上给 pi 登录**不会**弄坏已有的 codex CLI 登录态。
   真正互踩的是**把同一份 auth.json 复制到多台机器**：refresh token 轮换会让先刷新方使另一方失效。
   pi 对 auth.json 用 `proper-lockfile` 加文件锁，同机并发刷新安全，但文件锁不跨主机。
   → 结论不变（不复制凭据文件、每台跑 pi 的机器独立登录），但"是否需要第二个 ChatGPT 账号"
   取决于同一账号在两台机器上并发 24x7 使用的风控画像，而非技术上的凭据冲突。

4. **usage-limit 窗口是相对值**：文案里的分钟数是 pi 生成字符串那一刻由 `resets_at` 折算的，
   必须锚定**事件自身的时间戳**；事件在 outbox 积压后再解析会算错恢复窗口。
   解析器与单测见 `poc/codex-oauth/usage-limit-parser.mjs`。

## 9. PoC 增补（并入 M0）

| # | 验证内容 | 判据 |
|---|---|---|
| PoC-C1 | device code 登录 → RPC 跑通一轮 → 断网/过期后自动刷新 | auth.json expires 更新、无人工介入 |
| PoC-C2 | usage-limit 撞墙实测 | errorMessage 可被分诊正则解析出 reset 分钟数 |
| PoC-C3 | `auth check --no-refresh` 探针 | 不改变 auth.json mtime（确认零副作用） |
| PoC-C4 | 同机双 pi 子进程并发刷新 | 文件锁生效，无 invalid_grant |
| PoC-C5 | Mac mini LaunchAgent 会话下登录态持久性 | 重启后 auth 仍有效 |
