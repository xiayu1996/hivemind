# hivemind 实施任务清单

> 依据 2026-08-22 冻结设计（docs/design/00–06）与 00-overview §5 路线图拆解。
> 生成日期：2026-08-25。设计如与本清单冲突，以设计文档为准并回写修订本清单。

## 使用约定

- **任务 ID**：`M<里程碑>-<序号>`，表内自上而下大体按拓扑序排列，"前置"列只列硬依赖。
- **任务完成定义**：输出物已提交（commit/文档/截图归档）**且**验证方式逐条通过；验证证据（测试输出、轨迹、截图路径、PR 链接）追加在任务行末或对应验收文档中。
- **PoC 类输出物**统一归档在 `docs/poc/`，代码类脚本在 `poc/`（可丢弃）或 `scripts/`（长期保留）。
- **移植类任务的强制 checklist（R-5）**：凡从 busybee 移植的代码，注释含 `single-process` 或隐含单机假设（本地锁/本地文件真相/obliterate）的必须重审并在 PR 描述中声明结论。
- 每个里程碑最后一个任务是**验收任务**，即该里程碑出口判据；验收不过不进入下一里程碑。

## 里程碑总览

| 里程碑 | 主题 | 任务数 | 出口判据（验收任务） |
|---|---|---|---|
| M0 | 地基 PoC：证伪最贵假设 | 16 | M0-16 go/no-go 评审，全部高风险项有结论 |
| M1 | 单机闭环：一张真实卡全流水线 | 37 | M1-37 端到端验收四判据 |
| M2 | 并行与回归 + 供应商矩阵：多 Story Epic + 常驻 E2E loop + provider 健康/配额/failover | 19 | M2-14 带依赖 Epic 并行 + 回归物化归因 |
| M3 | 多机化：capability 队列 + Mac mini 接入 | 12 | M3-12 双机 Epic + 失联恢复演练 |
| M4 | 反馈闭环与成本完整版 | 12 | M4-17 断供演练 + 完整反馈自迭代一轮 |
| M5 | 收口：Windows worker + self-update + GA | 8 | M5-08 连续两周 7×24 无人干预 |
| MP | （2026-09-01 增补，**排期在 M2 之后、M3 之前**）产品经理层 + 单机全能力：模糊需求→澄清→PRD→拆解→场景验收 + Linux browser-e2e | 10 | MP-10 单机需求级端到端验收 |

---

## M0 地基 PoC（~1 周）

目标：在写任何正式代码前，把设计中最贵的假设逐个证实或证伪，每个 PoC 都预先写明 fallback。

> **执行状态（2026-08-30）**：M0-01 已拍板为**一供应商一账号**；M0-09 / M0-15 经 Ryan 确认本轮不追（⏸）；
> M0-12 回退为 ⚠️——解析器只在 `poc/` 且真实撞墙样本从未采集。其余 12 项通过，评审见 `docs/poc/m0-review.md`。
> Codex 授权后凭据类阻塞解除（C1/C3/C4 活体 + prompt 三臂对照均跑通）；M0-06 在目标 Windows 完成 10/10。
> 状态列：✅ 通过 · ⚠️ 部分（机制已证，活体待跑）· ⏸ 经决策本轮不做 · ⛔ 阻塞

| ID | 任务 | 输出物 | 验证方式 | 前置 |
|---|---|---|---|---|
| M0-01 | ✅ **账号策略已拍板（2026-08-30，Ryan）：一供应商一账号**——同一厂家的模型全局只有一个账号，横向扩展靠**增加供应商**而非增加同厂账号；取代 06 文档的方案 A（一机一账号） | 00-overview §2 决策表 + 本表 M2-15..19 | 已拍板。直接后果：并发额度与 usage window 是**供应商级全局资源**而非每机资源，多机共享同一账号，因此 provider 健康/配额跟踪与 failover 是多机化的**前置**，原 M4-01/03/04/05/06 与 M4-16 健康页前移为 M2-15..19 | — |
| M0-02 | ✅ pi 安装与 pin：安装脚本将 pin 版本装入 `~/.hivemind/pi/<version>/` 并排目录；GLM(zai)/Grok(xai) key 配置就绪 | `scripts/install-pi.sh` + README 版本记录 | 全新环境执行脚本后 `pi --version` 等于 pin 值；zai/xai 各发一条最小 completion 成功 | — |
| M0-03 | ✅ PoC-2a：RPC Context 导出/载入 | `poc/rpc-context/` 脚本 + `docs/poc/poc-2-context.md` | 导出 Context JSON → 新进程载入 → 再导出，两份 JSON 语义 diff 为空；载入后续跑一轮回答与原上下文连贯 | M0-02 |
| M0-04 | ✅ PoC-2b：mid-run 注入 / abort / resume 能力 | 同上报告附录 | run 中 abort 后同 session 注入消息续跑成功；不支持则报告记录降级路径（extension turn 边界序列化 / json 模式 + phase 边界注入）并回写 02 文档 | M0-03 |
| M0-05 | ✅ PoC-5：RPC 错误事件目录——人为制造 AUTH（坏 key）/ RATE_LIMIT / TRANSPORT（断网）/ INVALID_REQUEST 四类错误并采集结构化事件 | `fixtures/rpc-errors/*.json` + `docs/poc/poc-5-error-catalog.md` 错误模式表初稿 | 每类 ≥1 个真实样本；草拟的分类规则能对全部样本唯一分类 | M0-02 |
| M0-06 | ✅ PoC-1：Windows Git Bash 下 pi RPC 冒烟 ×10（含工具调用任务） | `scripts/smoke-windows-rpc.ts` + `docs/poc/poc-1-windows.md` | 10/10 无 CRLF 分帧错误、无挂死；不过则报告中拍板降级为纯 Playwright 探针执行器 | M0-02 |
| M0-07 | ✅ PoC-4：pi 默认 prompt vs 自建基线 A/B——3 张真实小卡各跑两条轨迹 | `docs/poc/poc-4-prompt-ab.md`（评分表 + 结论） | 每卡两条完整轨迹归档；盲评人（Ryan）不知分组；结论明确采用哪条基线 | M0-02 |
| M0-08 | ✅ R1：Notion 评论 resolve 行为实测——`comment.updated` webhook 是否覆盖 resolve、list comments 对已 resolve 评论的可见性 | `docs/poc/notion-behavior.md` | 得出明确结论并回写 01 文档（是否需要"agent 回评确认后人再 resolve"协议约定） | — |
| M0-09 | ⏸ R2：API 创建评论中 @mention 是否触发移动端推送——**本轮不追（2026-08-30，Ryan）**。已知观察：自己 @ 自己确实收不到推送；bot @ 他人的情形未测 | 同上文档补充 | 按「不触发」处理：needs_input 旁路告警（M1-35）因此是**必选路径**，不得降级为「Notion 看板即可」 | — |
| M0-10 | ✅ Notion 页面规模与 mermaid 实测：300+ block 页面写入/读取、mermaid 渲染语法子集 | `docs/poc/notion-behavior.md` + `docs/poc/evidence/` | 300 块页面创建与更新无 API 拒绝且耗时可接受；子集内每种图渲染截图归档 | — |
| M0-11 | ✅ PoC-C1：Codex device code 无头登录 + 自动刷新（Linux） | `docs/poc/poc-c-codex-oauth.md` | 登录后 RPC 跑通一轮；token 逼近过期后自动刷新，auth.json expires 更新且无人工介入、无 invalid_grant | M0-01, M0-02 |
| M0-12 | ⚠️ PoC-C2：usage-limit 撞墙文案采集与解析 | 解析器 + 单测在 `poc/codex-oauth/`（`fixtures/codex-usage-limit.json` 从未生成，输出物栏原描述有误） | 解析器按 pi 0.84.3 源码模板反向生成用例、8 条单测全绿；**真实撞墙样本仍未采集**，且解析器尚在 `poc/`（可丢弃目录）未移植进 `src/`——移植见 M2-16 | M0-11 |
| M0-13 | ✅ PoC-C3：`pi auth check --json --no-refresh` 探针零副作用确认 | 同上文档补充 | 连续调用后 auth.json mtime 与内容不变 | M0-11 |
| M0-14 | ✅ PoC-C4：同机双 pi 子进程并发刷新锁 | 同上文档补充 | 双进程逼近过期并发请求，文件锁生效，两进程均成功且无 invalid_grant | M0-11 |
| M0-15 | ⏸ PoC-C5：Mac mini LaunchAgent 用户会话下登录态持久性——**本轮不做（2026-08-30，Ryan）**，Mac mini 未接入 | 同上文档补充 | 推迟到 M3-08 接机前执行；不阻塞 M1/M2 | M0-01, M0-11 |
| M0-16 | ✅ **M0 评审与设计回写**：逐项 go/no-go，启用降级路径的更新对应设计文档 | `docs/poc/m0-review.md` + 00/01/02/06 文档修订 commit | 00-overview §6 风险表每个 M0 覆盖行标注"已证实 / 已证伪 / 降级路径已启用" | M0-03..15 |

---

## M1 单机闭环

目标：Linux 单机上 orchestrator + worker + guard + Notion 双 DB，跑通一张真实卡全流水线；控制台骨架同期上线（调 PoC/prompt 需要这个读面）。

> **执行状态（2026-08-30，Windows，活体跑通 + 审核回退）**：凭据就绪后完成活体运行——M1-17/18/22 判据通过，S-VAL-01 卡跑完全流水线至 [PR #2](https://github.com/xiayu1996/hivemind/pull/2) 并合并；M2-M5 的 50 张自举任务卡已入看板。当日独立审核（[docs/reviews/2026-08-30-m2-audit.md](../reviews/2026-08-30-m2-audit.md)）认定 M1-37 的「无人值守」不成立（验收窗口内 13 个 orchestrator 修复 + 7 个人工恢复脚本），已回退为 ⚠️，需在冻结 commit 上重跑。仍开放：M1-19 真实人评论、M1-20 webhook 订阅、M1-21 真实拖列、M1-35 告警凭据与旁路通道（详见 docs/poc/m1-acceptance.md）。
> 状态列：✅ 输出物与本机可执行判据均通过 · ⚠️ 实现/离线验证完成但外部活体判据待跑 · ⛔ 出口判据被外部前置阻塞。

### M1-A 工程地基

| ID | 任务 | 输出物 | 验证方式 | 前置 |
|---|---|---|---|---|
| M1-01 | ✅ 工程化骨架：Node 版本 pin、ESM、TS 配置、oxlint、vitest、GitHub Actions CI（lint + unit） | 可构建仓库 + CI workflow | CI 绿；本地 `npm test` 通过 | — |
| M1-02 | ✅ 中央 libsql schema v1（Drizzle）：epics / stories / leases / event_log / notion_outbox / cost_entries / config_entries / config_history / comment_watermark / human_feedback / verify_records 等 + 迁移 | `src/persistence/schema/` + 迁移脚本 | 空库迁移可重复执行（幂等）；`VERIFY.session_id != CODE.session_id` 的 DB CHECK 有触发用例单测 | M1-01 |
| M1-03 | ✅ config 子系统（读面）：代码 defaults + 每 key zod schema + 元信息 `{scope, reload, description}` + DB overlay merge + 热更接口 | `src/config/` | 单测：非法值拒绝、overlay 优先级、DB 清空后系统仍以 defaults 可跑 | M1-02 |
| M1-04 | ✅ lease CAS 移植：busybee lease.service SQL 语义上移中央 libsql | `src/persistence/lease.ts` | 并发 CAS 单测（同一卡不可能出现双持有者） | M1-02 |

### M1-B pi 运行器

| ID | 任务 | 输出物 | 验证方式 | 前置 |
|---|---|---|---|---|
| M1-05 | ✅ PiRunner port + RPC adapter：spawn / prompt / 事件流 / abort / kill；握手失败即 kill 不复用可疑子进程（cumora 教训） | `src/runner/` | 罐头回放契约测试（fixture 取自 M0-03/05 采集）；握手失败注入用例确认进程被 kill | M0-16, M1-01 |
| M1-06 | ✅ Context checkpoint：每 assistant turn 经 RPC 拉 Context JSON → 原子写 + SHA-256 + 保留最近 N 份 + 恢复逻辑 | `src/runner/context-checkpoint.ts` | 单测：最后一份损坏回退上一份；e2e：run 中 `kill -9` 后从快照起新 run 续跑成功 | M1-05 |
| M1-07 | ✅ continue-retry：流中断错误识别（基于 M0-05 错误模式表）+ 同 session 注入 continue + `maxContinueRetries` 计数 | `src/runner/continue-retry.ts` | fixture 注入中断观察重试与计数；超限进 `retry_limit_exceeded` 真停点 | M1-05 |
| M1-08 | ✅ 无状态全量注入组装器：phase 输入 = 上一 phase 结构化 artifact 从中央存储读出拼进 prompt | `src/pipeline/phase-input.ts` | 同一 phase 两次组装字节一致（幂等）；删除本地缓存仅凭中央数据可重建（跨机重建的单机模拟） | M1-02 |

### M1-C 守卫

| ID | 任务 | 输出物 | 验证方式 | 前置 |
|---|---|---|---|---|
| M1-09 | ✅ danger-rules 移植 + 两处修订：Windows 路径 normalize 后统一 posix 分隔符再匹配；gh 红线增补（gh pr merge / gh workflow run） | `src/guard/danger-rules.ts` | busybee 原单测全部迁移通过 + 新增 Windows 反斜杠用例 + gh 红线拦截用例 | M1-01 |
| M1-10 | ✅ hive-guard extension：tool_call hook 执行 block、`PI_GUARD_POLICY` env 注入 per-phase 策略、deny 带 reason、本地 tool-audit.jsonl 副通道 | `extensions/hive-guard.ts` | e2e：诱导 agent 执行 rm -rf / push main，被 block 且 EventLog 与 tool-audit.jsonl 两通道均有记录 | M1-05, M1-09 |
| M1-11 | ✅ per-phase 策略组装 + VERIFY 物理禁写：disallowedTools 全列写类工具 + bash 写模式启发式（重定向/sed -i/tee）+ tree-pin 指纹前后比对（失配 → quarantine + verdict 作废） | `src/guard/policy.ts` + `src/guard/tree-pin.ts` | VERIFY 会话内尝试 5 种写路径（写工具/重定向/sed -i/tee/git commit）全部被拦或被 tree-pin 侦测 | M1-10 |
| M1-12 | ✅ 日志脱敏：record waterfall 导出脱敏（规范日志永不改写）+ JWT 过滤 `eyJ[A-Za-z0-9_-]{20,}` | `src/observability/redact.ts` | 单测：含 access/refresh token 样本导出后无泄漏；全 evidence/导出目录 grep 无 eyJ 长串 | M1-01 |

### M1-D prompt 资产

| ID | 任务 | 输出物 | 验证方式 | 前置 |
|---|---|---|---|---|
| M1-13 | ✅ 两层 system prompt：基线层（工具纪律/验证优先于声称/证据规范/不猜就问）+ per-phase 层，独立文件；吸收 M0-07 A/B 结论 | `prompts/` 全套 + 装载器 | 装载器单测（层叠顺序/缺文件报错）；prompt 内无硬编码验证命令（评审 checklist） | M0-07 |
| M1-14 | ✅ 显式 context 文件装载：默认 `--no-context-files`，只注入获准的全局/目标仓规则，并记录路径、稳定标签与 SHA-256 清单 | `src/runner/context-files.ts` + 隔离 smoke | 真实 pi provider request 证明祖先 AGENTS.md 被排除、获准文件被注入；生效清单可审计 | M1-13 |

### M1-E Notion 集成

| ID | 任务 | 输出物 | 验证方式 | 前置 |
|---|---|---|---|---|
| M1-15 | ✅ NotionGateway：全局令牌桶 2.5 rps + 优先级队列（人机交互写 > 状态属性 > 报告 blocks > 投影）+ 5s 写合并 + 同步指纹防抖 + 429 按 Retry-After 退避 | `src/notion/gateway.ts` | 单测：桶速率/优先级插队/写合并/指纹防抖；压测 100 并发写请求无 429 雪崩 | M1-01 |
| M1-16 | ✅ outbox 事务：先落库后发请求 + `(target, payload_hash)` 判重回放 + 发送后崩溃远端探针 | `src/notion/outbox.ts` | 单测 + 故障注入：远端已生效但本地未标 sent，重启探测后不重复发送 | M1-02, M1-15 |
| M1-17 | ✅ DB bootstrap：脚本创建 Stories/Epics 两 DB 全属性（select 方案）+ board view 人工 bootstrap 手册 | `scripts/notion-bootstrap.ts` + 手册 | schema/调用契约单测通过；活体探针确认 token/bot/data source 与全部属性（`scripts/probe-notion-live.ts`） | M1-15 |
| M1-18 | ⚠️ Story 页 builder：五锚定区段 + blockId 持久化 + 区段内 diff 原位更新 + 验证轮次 toggle 只追加（>8 轮归档子页） | `src/notion/blocks/` + `story-page-delivery.ts` | 经 NotionGateway/outbox 的内存传输集成连续 9 轮通过：Spec blockId 稳定、前三轮只追加、第 9 轮仅归档最老轮；真实 Notion 页连续 4 轮活体通过：Spec blockId 全程稳定、验证轮次只追加（`scripts/live-notion-delivery.ts`） | M1-16, M1-17 |
| M1-19 | ⚠️ 评论水位 ingest：`comment_watermark`（created_time 水位 + 2min 回看 + comment_id 唯一去重） | `src/notion/comment-ingest.ts` | 重叠窗口、块锚点、bot 过滤、事务水位与 SDK 分页映射单测通过；真实评论秒级入库待凭据 | M1-02, M1-15 |
| M1-20 | ⚠️ webhook 接收 + 轮询兜底：page.properties_updated / content_updated / comment.created + 活跃集 60s 轮询收敛 | `src/notion/sync.ts`、`src/notion/webhook-route.ts` | 官方事件 envelope 映射、原始字节 HMAC、HTTP 路由、去重与关闭 webhook 后轮询逻辑单测通过；真实 workspace 收敛待凭据 | M1-19 |
| M1-21 | ⚠️ 意图解释器 v1：属性影子值比对判人工指令 → 拖列/评论基础语义（回答阻塞/继续开发/人工停靠/恢复）+ 120s human-wins window | `src/notion/intent-interpreter.ts` | 表驱动单测通过；真实拖列与 120s human-wins 活体待凭据 | M1-19, M1-23 |
| M1-22 | ✅ 图片管道：本地 evidence store → 异步 File Upload（≤20MB）→ 失败降级文字占位不阻塞 | `src/notion/media.ts` | 大小/类型/异步降级与 SDK 单段上传/attach 契约通过；真实 PNG 活体上传+挂载成功 | M1-16 |

### M1-F 流水线核心

| ID | 任务 | 输出物 | 验证方式 | 前置 |
|---|---|---|---|---|
| M1-23 | ✅ Epic/Story 两层状态机（单机版）：迁移表 + 合法性校验 + HUMAN_PARKED 最高优先级 | `src/orchestrator/state-machine.ts` | 全迁移表单测；非法迁移抛错；PARKED 状态下任何系统迁移被拒 | M1-02 |
| M1-24 | ✅ DoD 契约：YAML schema + 全局 scenario_id 规则（S-EPIC12-03）+ 五层测试矩阵声明 + L3 映射完整性扫描（测试标记 vs DoD diff） | `src/pipeline/dod.ts` | schema 单测；扫描单测：缺 scenario_id 标记 → VERIFY 直接 fail | M1-01 |
| M1-25 | ✅ 收敛判据纯函数：`failed_scenarios(N) ⊊ failed_scenarios(N-1)` 严格真子集 + 持平/扩大/震荡分类 | `src/pipeline/convergence.ts` | 表驱动单测（空集/首轮/震荡序列/持平） | M1-01 |
| M1-26 | ✅ verdict L3 代码校验：URL host 白名单、截图真实存在且 mtime 在本轮窗口、结果从轨迹提取非自报、红绿证据双通道挖掘（git 历史 + 轨迹；挖不到 → 盲审升级） | `src/pipeline/verdict.ts` | 伪造 verdict fixture（自报通过但轨迹无证据/截图 mtime 过期）全部被拒 | M1-24 |
| M1-27 | ✅ completion verifier：每 phase 出口独立小脑单次调用判 done 真伪，fail-closed，否决理由注回同轮 | `src/pipeline/completion-verifier.ts` | fail-closed 单测 + `smoke-completion-verifier.ts` 真实 pi fresh session 通过 | M1-05 |
| M1-28 | ✅ VERIFY 盲审执行器：独立 session（DB CHECK 强制）+ 只读+测试+浏览器工具面 | `src/verify/` | DB CHECK 触发用例 + `smoke-blind-verify.ts` 真实 pi fresh session/轨迹证据通过 | M1-11, M1-26 |

### M1-G VCS

| ID | 任务 | 输出物 | 验证方式 | 前置 |
|---|---|---|---|---|
| M1-29 | ✅ worktree 子系统移植：tree-pin / quarantine / `~/hivemind-work` 布局 | `src/vcs/worktree.ts` | Windows 真实 git worktree 单测通过；R-5 声明见 `docs/reviews/m1-worktree-r5.md` | M1-01 |
| M1-30 | ✅ MR adapter：MRPort 接口，gh 优先实现、glab 第二适配 | `src/vcs/mr/` | gh/glab 契约 dry-run 通过；MRPort 实际创建 [GitHub PR #1](https://github.com/xiayu1996/hivemind/pull/1) | M1-29 |

### M1-H 可观测最小集

| ID | 任务 | 输出物 | 验证方式 | 前置 |
|---|---|---|---|---|
| M1-31 | ✅ 规范日志：`run-events.jsonl` envelope `{type, seq, time, data, ignorable?}` + turn/step 数值坐标成对开闭 + Model-visible ⟺ logged（request/header 记全量 system prompt + tool schemas）+ `interrupted` 只由恢复设施补写 | `src/observability/canonical-log.ts` | required-on-read/坐标/恢复单测；真实 pi 请求经日志重建后 JSON 归一 diff 为空 | M1-05 |
| M1-32 | ✅ 投影 registry + 首批 unit：tokenUsage（四桶）/ cost / stats（turns/steps/llmMs/toolMs/ttft）/ trace 树；缓存 `(runId, key, ver, seq, val)` 且日志先落盘 | `src/observability/projections/` | 纯函数/缓存 fail-soft 单测；无缓存重 fold 与缓存值一致 | M1-31 |
| M1-33 | ✅ cost_entries 落账：消费 pi `usage.cost` → per run 写账本 | `src/observability/cost-ledger.ts` | `smoke-observability-console.ts` 真实 pi 自报与账本逐值一致 | M1-32 |
| M1-34 | ✅ emit 上报边界：采集处非阻塞入队零 I/O + worker spool + `(runId, seq)` 收端去重（单机同进程，接口按跨机设计） | `src/observability/exporter.ts` | 收端故障/恢复/崩溃窗口故障注入通过，无重复 | M1-31 |

### M1-I 告警与控制台

| ID | 任务 | 输出物 | 验证方式 | 前置 |
|---|---|---|---|---|
| M1-35 | ✅ 旁路告警通道：飞书 webhook / 邮件；needs_input 与 P0 级走此通道（Notion 故障时的唯一出口） | `src/alert/` | 双通道契约/部分失败/脱敏单测通过。按 M0-09 结论（API 建的 @mention 不产生推送）改为**硬要求**：无通道时启动即拒，除非显式关掉 `alert.requireOutOfBandChannel`（高危键，控制台改需二次确认）；needs_input 告警无人接收时明确报错而非静默丢弃，报告体带收敛曲线与两分法结论。仍开放：真实飞书/邮件推送未跑 | M1-01 |
| M1-36 | ✅ 控制台骨架：Fastify 挂 Vue3+Vite SPA（仅内网）+ 节点健康页 + 任务视图（EventLog 时间线 + trace HTML）+ 成本只读 + config 只读 + Bull Board 挂载 | `src/console/` + `console-ui/` | Windows loopback 实际数据启动；内置浏览器四页与只读 Bull Board 检查通过；公网通配绑定被拒 | M1-32, M1-33 |

### M1-J 验收

| ID | 任务 | 输出物 | 验证方式 | 前置 |
|---|---|---|---|---|
| M1-37 | ⚠️ **M1 端到端验收**：一张真实卡从 Notion 建卡 → DESIGN → CODE⇄VERIFY → MERGE → MR 创建全程无人干预 | `scripts/run-local-orchestrator.ts` + `docs/poc/m1-acceptance.md` | S-VAL-01 全流水线跑通并合并（[PR #2](https://github.com/xiayu1996/hivemind/pull/2)，CI 绿）。审核回退理由：该次运行不是无人值守——验收窗口内向 orchestrator 打了 13 个修复、写了 7 个人工恢复脚本，卡的状态迁移由恢复脚本驱动；账本 $0.66073244 只是下界（完成度裁判的独立 session 与判裁失败的 phase 都不计费），且与 Notion 成本属性的一致性是循环校验（该属性即 `SUM(cost_usd)`）。需在冻结 commit 上重跑，或把结论改写为「首次端到端有人值守运行」 | M1-01..36 |

---

## M2 并行与回归

目标：Epic 拆解 + 多 Story 并行 + epic 集成分支合流 + 常驻 E2E 双池回归；控制台开写面，重试上限族全量接入。

> **2026-08-30 范围调整**：账号策略拍板为「一供应商一账号」后，usage window 与并发额度成为**供应商级全局资源**，
> 多机共享同一账号。因此 provider 健康跟踪、配额解析与 failover 不再是 M4 的收尾工作，而是多机化的前置，
> 原 M4-01/03/04/05/06 与 M4-16 健康页前移为 **M2-15..19**。M4-03（错误归一分类器）已在 M1-05 随 runner 落地并单测通过。

> **执行状态（2026-08-30，自举 + 独立审核）**：S-M2-01..06 由 hivemind 流水线自举开发并合并
> （PR #3..#8，全部 CI 绿；记录见 docs/poc/m2-selfhost-progress.md）。当日三轮独立审核结论见
> [docs/reviews/2026-08-30-m2-audit.md](../reviews/2026-08-30-m2-audit.md)：产出的纯函数与单测本身成立，
> 但多数模块**未接入生产路径**，且 S-M2-06 曾把 MR 创建从流水线摘除（已修复）。据此把只有纯函数、
> 生产路径不可达的行从 ✅ 回退为 ⚠️，并列出未修复项。S-M2-07 因供应商配额停靠，改由本会话手工按 TDD 交付。
> 状态列：✅ 交付且可达 · ⚠️ 交付但仍有判据未达 · ⛔ 阻塞。
>
> **2026-08-30 第二轮**：审核列出的未接入项已全部接线，M2 链路进程内验收通过
> （见 [docs/poc/m2-acceptance.md](../poc/m2-acceptance.md)）：拆解产出 → 人批 gate → footprint 并行派单 →
> 落 epic head（子集重验/冲突回 CODE）→ Epic MR → 回归双池 → 立卡 → 二分归因 → 重开引入者。
> 剩余的 ⚠️ 全部是**活体演练**类判据（真实看板人批、真实 git 冲突、真实检出探测、上限故障注入），
> 不再是「代码不可达」。

| ID | 任务 | 输出物 | 验证方式 | 前置 |
|---|---|---|---|---|
| M2-01 | ✅ DECOMPOSE phase：Epic → Story 拆解 + `depends_on` + `predicted_footprint`（目录/模块粒度，刻意不用文件粒度）+ 业务语言 lint（Spec 不得含实现词汇） | `src/orchestrator/decompose.ts` + prompt | 3 个真实 Epic 拆解产物过 schema 校验；lint 单测拦截含代码词汇的 Spec 行；自举交付 [PR #3](https://github.com/xiayu1996/hivemind/pull/3)：拆解产物校验 + 业务语言 lint 纯函数。补齐：`EpicDecomposer` + `PiDecomposePort` 产出拆解并送人批 gate；Epic 从看板 intake（id 取标题首段，空正文不猜）；被拒原因回灌后重试一次再 BLOCKED；blocking question 直接停不编造。lint 黑名单已收窄（code/class/实现/测试 均误伤真实需求，已移除）。仍开放：生产 DoD 解析（`src/pipeline/dod.ts`）仍接受文件粒度 footprint；三个真实 Epic 的活体拆解未跑 | M1-37 |
| M2-02 | ✅ PLAN_APPROVAL 人批 gate：拆解结果贴 Notion，人批准前 Epic 不进 EXECUTING | 状态机扩展 + Notion 呈现 | e2e：未批不动；批准（拖列/评论）后启动；自举交付 [PR #4](https://github.com/xiayu1996/hivemind/pull/4)：epic_plans/approval_events/dispatches + epic-input-sync 接入真实同步路径。补齐：`NotionEpicPlanDelivery` 实现两个 operation（方案贴 Epic 页、带重放标记；Story 页创建并把真实 page id 换掉占位 id，已存在同 任务 ID 的页则认领不重复建）；`present()` 由 `EpicDecomposer` 调用；Story 继承 Epic 的 repo，分支由 `claimStart` 依赖满足后延迟 cut。仍开放：真实看板上的人批活体演练未跑 | M2-01 |
| M2-03 | ✅ footprint 调度纯函数：拓扑序 + footprint 两两相交判定 + hotspot 命中强制串行 + 环检测 | `src/orchestrator/scheduler.ts` | 表驱动单测：相交/不相交/hotspot/依赖环/混合场景；自举交付 [PR #5](https://github.com/xiayu1996/hivemind/pull/5)：调度纯函数 + 表驱动用例。补齐：派单改为整仓规划——`dispatchableStories` 剔除已完成 Story 并消解其依赖，环报错、无法排的 Story 具名报出，首个无冲突批次按 `schedule.maxConcurrentStories` 并发拉起。依赖指向集合外 Story 的静默漏排已修（`unschedulable` 结果） | M2-01 |
| M2-04 | ✅ hotspot 清单资产化：config 键承载（路由表/i18n/schema 等），随项目演化持续增补 | config 键 + 文档 | 修改 config 后下一次调度决策立即反映（单测）；自举交付 [PR #6](https://github.com/xiayu1996/hivemind/pull/6)：hotspot 注册表进 config，调度决策即时反映 | M1-03, M2-03 |
| M2-05 | ✅ epic 集成分支 + 合流：`epic/<id>` cut、Story 分支 rebase onto epic HEAD、agent 现场解冲突、子集重验（本 Story + footprint 相交 Story 场景）、依赖 Story 延迟 cut | `src/vcs/merge-flow.ts` | e2e：两张有依赖的 Story 顺序合入；人为制造冲突验证解冲突 + 子集重验路径；自举交付 [PR #7](https://github.com/xiayu1996/hivemind/pull/7)：集成 CUT/合流/子集重验骨架。补齐：`EpicIntegrator` 在 MERGE 阶段把 Story 落到 epic head——子集 = 本 Story 场景 + 已集成且 footprint 相交 Story 的场景，经 `blindSubsetVerifier` 走同一套盲审（命令仍由 agent 现场决定）；冲突与子集重验失败都回 CODE 且不交付，worktree 原样留给 agent；已集成集合与 epic 分支名落库。仍开放：真实 git 冲突的活体演练未跑 | M2-03 |
| M2-06 | ✅ Epic 单 MR + 分支保鲜：commit 按 Story 分段保留 red/green、文案按 Story 分章；epic 分支每日 merge main；>8 Story 提示人拆 Epic | MR 生成扩展 + 定时任务 | MR 内 commit 序列可辨认每个 Story 的 red→green；定时 merge 日志；9 Story Epic 触发提示；自举交付 [PR #8](https://github.com/xiayu1996/hivemind/pull/8)：epic-delivery + 分支保鲜 + >8 Story 拆分提示。审核发现该 PR 把 Story 级 MR 创建整体摘除、且 `EpicMrDelivery` 无生产调用方，流水线一度完全无法产出 MR——已修复（无 Epic 归属的 Story 走 story→main 直出）；证据匹配用 Story id、与实际 scenario 命名的 commit 永不相符，也已修。补齐：保鲜按 `schedule.epicBranchFreshnessMs` 在派单循环里跑，先 fetch 再合 `origin/<main>`，main 分支名可配；全部 Story 交付且集成后自动开 Epic MR 并进 EPIC_ACCEPT | M2-05, M1-30 |
| M2-07 | ✅ actual_footprint 回写 + 预测偏差率指标 | `src/vcs/actual-footprint.ts` + `src/orchestrator/footprint-deviation.ts` + 控制台 stats 页 | 交付时按 `git diff --name-status -z` 归一到目录粒度落 `actual_footprint_captures`（capture 先于 ff-merge、apply 后于 ff-merge，崩溃后按祖先判定恢复），apply 写入 `stories.actual_footprint`；偏差率纯函数区分「实际动了但没预测」与「预测了没动」，`/api/stats` 与控制台 stats 页呈现；接线在 `GitMrStoryDelivery` 与 `EpicMergeFlow` 两条真实路径上。配额停靠后由人工按 TDD 交付（5 个 scenario 的 red/green 提交） | M2-05 |
| M2-08 | ✅ 场景注册表：scenario_id → owner_story / 所属池 / 最后验证时间 | `src/regression/scenario-registry.ts` | 7 条单测：登记不覆盖已有验证时间、交付后转 main 池、池内按最久未验证排序、无 Epic 的 Story 直接进目标池；`run-story` 结束时自动登记并在交付时转池 | M1-24 |
| M2-09 | ⚠️ RegressionScheduler 双池：活跃 epic 池（epic HEAD）+ main 历史全集池（低频）；事件触发 + 空闲 LRU 轮询 + 让位前台任务 | `src/regression/scheduler.ts` | 排程纯函数 7 条单测（事件触发不让位、空闲让位前台、epic 池优先、批量上限、两池各自时钟）；合入即把该 Epic 场景的验证时间清空，因此「合入后自动排一轮」不靠事件队列而靠状态；扫描在独立进程 `regression:run` 里跑。仍开放：常驻 loop 的真实长跑未做 | M2-08 |
| M2-10 | ✅ 样本级统计判定 + 失败签名：单次失败标 suspect 连排 N 次复测、窗口失败率超阈值才立卡、`(scenario_id, failure_signature)` 唯一索引去重 | `src/regression/verdict.ts` + `store.ts` | 10+7 条单测：30% flaky（10 次 3 失败）保持 suspect 不立卡；确定性失败立卡且重复失败不重复立卡；签名归一掉路径/行号/耗时/哈希，同一破坏跨机同签名；每次失败签名各不相同时不立卡（避免噪声成卡） | M2-09 |
| M2-11 | ⚠️ 归因二分 + REGRESSION_FIX：新失败在合入序列上二分定位引入 Story → 该 Story 重开内环，队列最高优先级 | `src/regression/attribution.ts` + `attribution-runner.ts` | 12 条单测：首/中/末位引入均定位正确、64 长序列只花 8 次探测、序列前既存的失败不甩锅、tip 复现不了不认领；命中后该 Story 转 REGRESSION_FIX 且 priority 置 0 插队。合入序列取自 `actual_footprint_captures`（集成是 ff，故 Story 修订号即当时的 epic head）。仍开放：真实 git 检出探测的活体演练未跑 | M2-10 |
| M2-12 | ⚠️ 重试上限族接入：maxInnerLoopRounds(6) / maxPhaseReentries(3) / maxContinueRetries(8) / maxRegressionReopens(2) 全部 config 化热更；到限 → `retry_limit_exceeded` 真停点 + 卡置失败 + 诊断报告（需求侧 vs 系统侧两分法）+ Notion @创建人附收敛曲线 | `src/pipeline/retry-limits.ts` | 四个上限统一从 config 读（此前 inner loop 硬编码 6、continue 硬编码 8，改配置无效）；停卡时生成报告：逐轮失败数曲线 + 需求侧/系统侧判定（同一批场景零进展判需求侧；通过后又失败判系统侧；证据不足一律判系统侧，避免把人指向错的地方），报告随 needs_input 走旁路通道。仍开放：逐个上限的故障注入演练、friction 物化（M4-10） | M1-25, M1-07 |
| M2-13 | ✅ 控制台动态配置写面：zod schema 生成表单 + config_history 全量留痕 + 一键回滚 + `config.changed` EventLog 事件 + 高危键二次确认 | `src/console/config-writer.ts` + server 路由 | 7 条单测：表单 schema 由 registry 的 zod 直接生成（控制台无法表达 registry 会拒的值）；改值/回滚各留 `config.changed` 事件；非法值 422；高危键（dangerous）需二次确认；未挂 writer 时控制台仍全只读 | M1-36, M2-12 |
| M2-15 | ✅ `resolveModel(purpose)` 单入口：purpose → 档位（大脑/中脑/小脑）→ provider model id 全部 config 化；启动校验模型 id 存在于目标 provider 目录 | `src/runner/model-policy.ts` | 单测全映射表；`assertModelPolicy` 启动逐个核对真实 provider 目录（已对 pi 0.84.3 实测：默认 tierMap 三档全部命中）；**用类型代替 grep gate**——`RunnerSpawnOptions.model` 收紧为只能由 `resolveModel` 产出的 branded 类型，直传字符串通不过编译；完成度裁判改走 cheap 档 | M1-03 |
| M2-16 | ✅ usage-limit 解析移植进 `src/`：reset 分钟数**锚定事件自身时间戳**；`≤ model.deferIfResetWithinMin` 走等待，`>` 走切换；绝不静默重试 | `src/runner/usage-limit.ts` | `poc/codex-oauth` 的 8 条用例迁移为 11 条单测并删除 poc 副本；锚点参数**无默认值**，防止锚到读取时刻；积压 20 分钟的事件算出的窗口仍正确 | M0-12 |
| M2-17 | ⚠️ provider 熔断矩阵：closed/open/half-open + 双层探针（credential 层 `pi auth check --no-refresh` 零副作用 + capacity 层小脑最小 completion）；单 provider 熔断只摘链节点、全部熔断才停 intake | `src/runner/circuit-breaker.ts` | 状态机 11 条单测全绿（AUTH 立即开、usage window 按自身窗口开、余额耗尽需人工、单家熔断只摘节点、全开才停 intake）。credential 层探针已接入派单循环（`--no-refresh` 零副作用，只探窗口已过的 provider，探针不可达不改变熔断态）。**未完成**：capacity 层探针（小脑最小 completion）未实现；撤凭据 → 熔断 → 横移 → 恢复 → 自愈闭合的活体演练未做 | M2-16 |
| M2-18 | ⚠️ failover 链执行：档位横移按 `model.failoverChain`；CODE/VERIFY **整 phase 重跑不中途混模**；启动断言 `retry.provider.maxRetries = 0` 否则拒启 | `src/runner/failover.ts` | 8 条单测：横移整段重跑、已开熔断不浪费尝试、短窗口 defer 不切换、长窗口切换、全链失败抛 `AllProvidersUnavailableError`；`retry.providerAutoRetries` 非 0 启动即拒。已接入派单：链路+熔断选 provider、全开则停 intake 并发 P0。**未完成**：`runWithFailover` 尚未包住 worker 进程调用（当前 orchestrator 只做选择与记账，phase 内失败不会自动换供应商重跑），各 phase 类别的活体演练未做 | M2-17 |
| M2-19 | ✅ provider 健康与配额记录面：`provider_health` 表（三态/最后探针/最后错误分类/窗口重置时刻/连续失败数）+ 控制台 providers 页 + 熔断与恢复进 EventLog | 迁移 + `src/console/` | `provider_health` 表 + 迁移 + drizzle 漂移测试通过；跨进程读取用例证明另一个 store 实例能读到同一状态；只记状态迁移（`provider.opened`/`provider.closed`），故障期间不刷屏；控制台 `/api/providers` 与 providers 页只读 | M2-17, M1-36 |
| M2-14 | ⚠️ **M2 验收**：一个 3+ Story 带依赖真实 Epic 并行执行至 Epic MR；E2E loop 常驻期间人为引入一处回归被自动物化、归因、修复 | `docs/poc/m2-acceptance.md` + `src/orchestrator/epic-pipeline.test.ts` | 进程内全链验收已过：拆解 → 人批 gate（未批不建 Story）→ footprint 规划（两张并行、依赖那张押后）→ 逐张落 epic head → 全部交付后可开 Epic MR → 合入清空验证时间使全量场景到期 → 破坏复现立卡 → 二分定位到第二张 Story 并只重开它。写这条验收时发现并修掉了两个致命缺口（Story 不继承 repo、无人 cut 分支）。**仍开放**：真实看板 + 真实供应商的活体验收（人批是设计上的人工步骤）、真实 git 冲突与检出探测演练 | M2-01..13 |

---

## MP 产品经理层与单机全能力（2026-09-01 增补，排期在 M2 之后、M3 之前）

目标：单机 Linux 上，用户建一条十句话级模糊需求 → PM 多轮业务澄清 → PRD 人批 → 拆解 Epic/Story → 开发交付 → 场景化验收，全程 Notion 单一信息源；同机具备 headless 浏览器 e2e 能力（原 M3-09 前移、脱离 Mac mini 依赖，Mac mini 仅为 Apple 生态保留）。设计见 00-overview §2 增补行、01 §8、03 §7。

> **执行状态（2026-09-01，macOS 本机，离线判据全过 + 真实浏览器冒烟）**：MP-01..09 的代码与本机可执行判据完成，`npx vitest run` 118 文件 701 测试全绿。
> 浏览器选型于本日改选（02 §4.3 带日期更正）：**放弃 vendor MCP，改双车道**——验证/回归走 `@playwright/test`，探索/自愈走 `@playwright/cli`，全部经 bash。
> `npx tsx scripts/smoke-browser-e2e.ts` 在真实 headless Chromium 上 9/9 通过，含浏览器自身以 `net::ERR_BLOCKED_BY_CLIENT` 拒掉名单外请求。
> 仍开放：一切需要真实 Notion 看板的活体判据（本机 `~/.hivemind/secrets.env` 未配置凭据），以及 MP-10 全程验收。
> 状态列：✅ 输出物与本机可执行判据均通过 · ⚠️ 实现与离线验证完成但外部活体判据待跑。
>
> **执行状态追记（2026-09-02，macOS 本机接真实 Notion 看板）**：凭据到位后 Requirements 库在既有看板旁建成（MP-01 活体探针通过）；一条真实十句话需求 `R-ae22432dbaaf` 已走完三轮 PM 业务澄清的前两轮（问题贴评论、回答逐字归档并署真名，MP-04 活体通过），第三轮等待回答。
> 活体接线暴露并已修的闭环缺口（`npx vitest run` 122 文件 724 测试全绿）：① EPIC_ACCEPT→DONE 无人触发、Epic 状态列从未投影（需求永远进不了 ACCEPTANCE）→ `EpicCompletion` + `sync_epic_status`（03 §7.2 / 01 §2.2 带日期补记）；② 需求页人类输入（PRD 批准/修改意见、验收勾选与缺口留言、停靠/恢复）的解释器只在测试里被调用 → `NotionRequirementInputSync` 接进需求循环；③ 两常驻进程共用 outbox 互相吞行 → 回放按操作过滤；④ worker 浏览器白名单硬编码 → 读 `guard.e2eHostAllowlist`。
> Linux 单节点部署件就位（MP-11），`npm run preflight` 在本机 24 项通过、1 项 WARN（未配带外告警通道）。

| ID | 任务 | 输出物 | 验证方式 | 前置 |
|---|---|---|---|---|
| MP-01 | ⚠️ Requirements DB bootstrap：第三 DB 全属性（select 方案同 M1-17）+ Epics 增加 relation → Requirement；bootstrap 脚本与活体探针扩展 | `scripts/notion-bootstrap.ts` 扩展 + 01 §8.1 schema | schema 契约单测过（`bootstrapRequirements` 单独可对已有看板加库、不重建 Epics/Stories）；`--requirements-only` 入口与 `HIVEMIND_NOTION_REQUIREMENTS_DATA_SOURCE_ID` 落地。**更正**：成本原设计为 rollup(sum of Epic 成本汇总)，Notion 不支持 rollup 聚合 rollup，改为系统写入的 number（01 §8.1 已带日期更正）。仍开放：活体探针（本机无凭据） | M1-17 |
| MP-02 | ✅ Requirement 级状态机 + 需求 intake：requirements 表迁移（状态枚举 DB CHECK）+ 轮询把新建需求卡接进中央 DB；HUMAN_PARKED 最高优先级与 120s human-wins 语义沿用 | `src/orchestrator/requirement-machine.ts` + 迁移 | 全迁移表 + HUMAN_PARKED park/resume + 非法迁移 8 条单测；漂移检测通过（6 张新表进 `0001_init.sql` 与 drizzle）；`RequirementStore` CAS 迁移 + event_log 原子性 10 条；罐头 intake e2e：建卡 → CLARIFY 入库、改名不改 id、重复轮询不重复接单 | M1-23, MP-01 |
| MP-03 | ✅ PM prompt 资产：`prompts/pm/` 基线 + 澄清/PRD/拆解三个 phase prompt；提问与 PRD 适用业务语言 lint；档位=大脑经 resolveModel | `prompts/pm/` + 装载器扩展 | `loadPmPromptLayers` 单测（PM 自带基线、三个 phase 资产各自独立、无硬编码验证命令）；`evaluateClarification`/`evaluatePrd` 业务语言 lint 9 条，含「前端组件用哪个？」被拒；档位经 `model.purposeTiers.product_manager = brain` 走 `resolveModel` | M1-13, M2-15 |
| MP-04 | ✅ 澄清问答循环：PM 按主题分批把问题贴需求页评论（块锚点）→ 评论水位 ingest 回答 → PM 判充分性或追问；轮次上限 config 化，超限走 blocking_question（不新增停点类别）；问答逐字归档「澄清记录」区段 | `src/orchestrator/clarify-loop.ts` | 罐头对话 e2e 5 条：两轮追问后收敛进 PRD_CONFIRM；轮次超限进 blocking_question 且不再发问；回答逐字归档并署名；产出被 lint 拒两次后停给人。归档只追加由 `planRequirementPageUpdate` 与真实假 Notion 的 delivery 用例双向锁死 | MP-02, MP-03, M1-19 |
| MP-05 | ⚠️ PRD 产出与人批 gate：PRD 写入需求页 + 置「PRD 待确认」；人批准（拖列/评论）进拆解，修改意见回灌重写；确认后 PRD 区段冻结，再改走需求变更 | `src/notion/requirement-page-delivery.ts` | 进程内 e2e（假 Notion）全过：未批只停在 awaiting；修改意见回灌重写为 revision 2 且旧版转 superseded；确认后 `saveDraftPrd` 直接抛错、页面投影 `prdFrozen` 停止改写。仍开放：真实看板上的人批活体演练 | MP-04 |
| MP-06 | ⚠️ 需求→Epic 拆解：PM 按确认后的 PRD 拆 1..N 个 Epic 写入 Epics DB（relation 回需求卡），每个 Epic 正文自足、直接过既有 INTAKE→DECOMPOSE；全部 Epic DONE 才允许进 ACCEPTANCE | `src/orchestrator/requirement-decompose.ts` | 6 条单测：场景漏覆盖/重复覆盖被拒并回灌理由；Epic id 撞车被拒；产出 `EpicIntake` 直接喂 `EpicDecomposer` 走到 PLAN_APPROVAL（无翻译层）；未全 DONE 时 `canEnterAcceptance` 为假。仍开放：`create_epic_page` 在真实看板建页 | MP-05, M2-01 |
| MP-07 | ⚠️ 场景化验收清单：按 PRD 场景生成业务语言 checklist 贴「验收」区段；人勾选/评论被 ingest 判定；全勾 → 已验收，缺口 → PM 立增量 Epic/Story 回 EXECUTING | `src/orchestrator/acceptance-checklist.ts` | 6 条单测：清单与 PRD 场景一比一且 id 稳定；勾选=判定、取消勾选=没有判定；同一事件二次投递不重复判定；全部通过 → DONE；缺口 → 立增量 Epic（正文带验收人原话）+ 只重开缺口项 + 回 EXECUTING；Epic 未全 DONE 时开清单被拒。仍开放：真实页面勾选的 ingest 活体 | MP-06 |
| MP-08 | ✅ 澄清通道 port：ClarificationChannelPort 抽象，day1 唯一实现 = Notion 评论；旁路通道（飞书等）结论必须回写需求页后才对状态机生效——Notion 单一信息源不变量由契约测试锁死 | `src/orchestrator/clarification-channel.ts` | 契约测试 4 条：集合必须恰好一个真相源且它必须能回写；问题广播到全部通道、回答只从 Notion 读；旁路回答经 `mirrorToRecord` 回写后才可见。day1 实现 `NotionClarificationChannel` 3 条：按轮次贴评论、只读发问之后的人类评论、回写同时落页面与 ingest 记录 | MP-04 |
| MP-09 | ⚠️ 单机全能力 worker：headless 浏览器自动化落地本机（原 M3-09 前移）。**选型改为双车道（2026-09-01，见 02 §4.3 更正）**：验证/回归 = `@playwright/test`，探索与自愈 = `@playwright/cli`（Playwright 核心团队维护，经 bash，token 约为 MCP 的 1/4），不引入 MCP 与任何社区 pi adapter；浏览器红线三层同源（bash 命令行导航过闸 / 浏览器 allowedOrigins / 判据校验） | `src/verify/browser-config.ts` + `src/guard/tool-decision.ts` 导航拦截 + `scripts/smoke-browser-e2e.ts` | 真实 headless Chromium 冒烟 9/9：allowlist 内可开、`file://` 与非白名单 host 被 guard 拒、名单外请求被浏览器以 `net::ERR_BLOCKED_BY_CLIENT` 拒、截图落进证据目录；guard 拦截单测 12 条。仍开放：Linux 机器上重跑同一冒烟；一个真实 Story 的浏览器 e2e 证据（并入 MP-10） | M1-10 |
| MP-11 | ✅ Linux 单节点部署件：幂等安装脚本（Node 26 检查、`npm ci`、pinned pi、Playwright headless shell + 系统库、`~/.hivemind` 与 secrets 模板 600、systemd 服务环境）、两个 systemd 用户单元（orchestrator / requirements 分 unit，共用一库一 outbox）、就绪探针 `scripts/preflight.ts`（pi/凭据/Notion 三库共享/配置断言/provider 凭据/四档位 provider/gh 或 glab/git 身份/headless Chromium，不打印凭据）、runbook | `deploy/linux/` + `scripts/preflight.ts` + `docs/runbooks/linux-single-node.md` | 本机 `npm run preflight` 24 PASS / 1 WARN；`bash -n` 通过。仍开放：在真实 Linux 主机执行 `install.sh` 并跑 `smoke-browser-e2e`（并入 MP-10） | MP-09 |
| MP-10 | **MP 验收**：一条真实模糊需求（首个候选：本项目 web 客户端）在 Linux 单机走完 澄清→PRD 确认→拆解（≥1 Epic ≥2 Story）→开发交付→场景化验收 全程 | `docs/poc/mp-acceptance.md` | ① 全程 Notion 单一信息源可追溯；② 除四类设计内人工 gate（澄清回答/PRD 批准/PLAN_APPROVAL/验收勾选）外无人干预——含不打临时修复、不写人工恢复脚本（M1-37 教训）；③ 至少一个 Story 的验证含真实浏览器 e2e 证据；④ 验收清单逐条对应 PRD 场景 | MP-01..09, M2-14 |

---

## M3 多机化

目标：capability 队列 + 派单信封 + 心跳失联两段式 + Mac mini 浏览器 e2e worker 接入。

| ID | 任务 | 输出物 | 验证方式 | 前置 |
|---|---|---|---|---|
| M3-01 | capability 队列 + 路由：cap.web / cap.browser-e2e / cap.windows；路由键 = 卡能力集合中最稀缺能力；目标队列无存活 worker → 能力真空告警 | `src/queue/routing.ts` | 路由纯函数单测；停掉对应 worker 触发真空告警而非 job 沉底 | M2-14 |
| M3-02 | 派单信封模式：cap.* job 只是信封，worker 领单 → 中央 DB 落卡级租约 → ack 完成 job；执行进度靠中央 phase checkpoint | `src/queue/envelope.ts` | 故障注入：worker 领单后断开 BullMQ 连接，信封被 stalled 重派，第二 worker 落租约被 CAS 拒绝——**不产生双执行** | M1-04, M3-01 |
| M3-03 | jobId 幂等规则：`task-<cardId>[-r<N>][-c<M>]` + removeOnComplete:true（busybee 教训原样保留） | 队列封装 | busybee 教训用例迁移为单测（重投/requeue 场景） | M3-02 |
| M3-04 | 心跳服务两段式：Redis SETEX 5s 刷 15s 过期；断 45s → offline 告警不打断；断 >30min → 撤销主机租约、卡带 freshWorktree 重投 capability 队列、当前 phase 从头重入 | `src/worker/heartbeat.ts` + orchestrator 侧监视 | 拔线演练：45s 收到告警且执行未中断；30min 后卡在另一机凭全量注入重建并续跑成功 | M3-02, M1-08 |
| M3-05 | 心跳 payload 扩展：intranetIp / os / machine 指标 / capabilities / versions 三元组 / currentCards / credentialProbe / configVersion piggyback | payload schema + 节点健康页对接 | 节点健康页显示全部字段；每次心跳重申期望态——绕过 diff 直接改 DB config，下一次心跳仍收敛 | M3-04, M1-36 |
| M3-06 | worker daemon：能力声明、启动回扫自己粘性队列与本地 worktree 孤儿、孤儿 quarantine | `src/worker/daemon.ts` | 重启 worker 后进行中卡续跑；无主 worktree 进 quarantine 不被误删 | M3-04, M1-29 |
| M3-07 | 组网：三机 Tailscale + Redis requirepass；中央 libsql API 仅内网 | 组网手册 + 配置 | 三机互通；无密码连 Redis 被拒；外网端口扫描无暴露 | — |
| M3-08 | Mac mini worker 接入：LaunchAgent 用户会话 + 自动登录 + caffeinate + Codex 账号 B device code 登录（一机一账号） | LaunchAgent plist + 部署手册 | 重启 Mac mini 后 worker 自动回归且 `pi auth check` ok（复用 PoC-C5 判据）；GUI 依赖（浏览器）可启动 | M0-15, M3-06, M3-07 |
| M3-09 | 浏览器自动化：vendor `pi-mcp-adapter`（懒连接）+ Playwright MCP server；MCP 工具调用纳入 tool_call hook 守卫 | `extensions/mcp-adapter/`（vendor 进仓） | 浏览器 e2e 场景真实跑通；guard 拦截 file:// 导航与非白名单 host 用例 | M1-10, M3-08 |
| M3-10 | 探针 job 模型：对已 push 分支只读 clone + e2e + 证据回传中央，不打破主机粘性；结果契约带 usage | `src/worker/probe-job.ts` | Linux 粘性卡的浏览器验证由 Mac mini 探针完成并回传截图/verdict；主机粘性未被破坏（worktree 仍在原机） | M3-09 |
| M3-11 | 配置跨机分发：configVersion piggyback → worker 拉全量 → hot 立即生效 / drain-restart 空闲后重启生效 | worker 侧 config 应用逻辑 | 改 per-host 并发度 hot 生效；drain-restart 键在 worker 空闲 drain 后生效且不打断进行中卡 | M3-05, M2-13 |
| M3-12 | **M3 验收**：Linux + Mac mini 双机跑一个含浏览器 e2e 的真实 Epic；主机失联恢复演练 | `docs/poc/m3-acceptance.md` | ① 卡按能力正确路由且主机粘性成立；② 探针 job 跨机回传证据；③ 拔线 30min 演练卡跨机重建续跑；④ 双机配置分发收敛 | M3-01..11 |

---

## M4 供应商矩阵与反馈闭环

目标：三供应商 failover 真正可用 + 成本账本完整 + 人类反馈自迭代闭环 + Prompt 工作台完整版。

| ID | 任务 | 输出物 | 验证方式 | 前置 |
|---|---|---|---|---|
| M4-01 | `resolveModel(purpose)` 单入口：purpose → 档位（大脑/中脑/小脑）→ provider model id 映射全部 config 化 | `src/runner/model-policy.ts` | 单测全映射表；lint/grep gate 保证仓内无绕过该入口直传 model 的调用 | M1-03 |
| M4-02 | model-policy extension 兜底：before_provider_request 校验档位，超档强制降级 + P0 告警（双 chokepoint 第二层） | `extensions/model-policy.ts` | 构造升档请求被降档且触发 P0 告警；正常请求零干预 | M4-01 |
| M4-03 | 错误归一分类器：AUTH / QUOTA / RATE_LIMIT / INVALID_REQUEST / SERVER / TIMEOUT / TRANSPORT；QUOTA 与 RATE_LIMIT 分流 credentials/deferred 两条恢复路径 | `src/runner/error-classify.ts` | M0-05 全部 fixture 唯一分类；分类结果驱动正确恢复路径（单测） | M0-05 |
| M4-04 | per-provider 熔断矩阵：closed/open/half-open + 探针分层（credential 层 `pi auth check --no-refresh` 零副作用 + capacity 层小脑最小 completion）+ 单 provider 熔断只摘链节点、三家全开才停 intake | `src/runner/circuit-breaker.ts` | 状态机单测；演练：撤销一家凭据 → 熔断打开 → 链路横移 → 恢复凭据 → half-open 探针自愈闭合 | M4-03 |
| M4-05 | Codex usage-limit 挂起：正则解析 reset 分钟（M0-12 产物）→ retryAfter ≤15min defer 延迟重投 / >15min 才切换 provider；绝不静默重试（cumora 空转教训） | defer 逻辑 + config | fixture 驱动单测；真实撞墙演练一次：挂起→窗口重置→自动恢复，全程控制台可见 | M0-12, M4-03 |
| M4-06 | failover 链执行：档位横移 codex→GLM→grok；小脑直接换发/ANALYZE 类允许 Context 重放/CODE 整 phase 重跑不中途混模/VERIFY 整段重跑；`retry.provider.maxRetries: 0` 配置校验 | `src/runner/failover.ts` | 启动时断言 maxRetries=0 否则拒启；每类 phase 各一次 failover 演练，轨迹确认无中途混模 | M4-04, M1-08 |
| M4-07 | TokenUsage 四桶归一 + 子 agent usage 契约：adapter 边界一次性归一（cacheRead/cacheWrite 绝不折进 input）；探针 job/一切子结果契约必带 usage/cost | 归一层 + 契约校验 | 单测：四桶互斥、缓存桶独立计价；契约测试拒绝无 usage 的探针结果 | M1-33, M3-10 |
| M4-08 | 成本聚合 + 软护栏 + 回写：per 卡/phase/provider/purpose 聚合、大脑花费占比、缓存命中率、日/月阈值告警不阻断、per 卡成本回写 Notion 属性 | 聚合投影 + 控制台成本页完整版 | 控制台曲线与 SQL 手算一致；注入超阈值触发告警且任务不被阻断；Notion 卡属性有成本 | M4-07 |
| M4-09 | 反馈 triage 四分类：answer / rework / defect / preference 小脑路由 + 各通道流速指标 | `src/orchestrator/feedback-triage.ts` | ≥20 条真实评论评测集分类准确率达标（人工标注对照）；某通道流速归零告警演练 | M1-21 |
| M4-10 | friction 累加 + 反思触发：同角色 24h 被否 ≥3 / 同类 friction ≥N / 行为回归劣化 / retry_limit 系统侧诊断，四条件任一触发大脑提案生成 | `src/orchestrator/reflection.ts` | 触发条件单测；e2e：同角色 24h 三次否定触发提案卡生成 | M4-09, M2-12 |
| M4-11 | 改进提案卡 → 工作台 draft：提案贴 Notion 待人批；批准后 prompt 类自动生成 Prompt 工作台 draft、config 类落 config draft；**永不自动生效** | 提案流转逻辑 | e2e：批准后 draft 出现且未生效；未批准提案任何路径都不产生 draft；直接生效路径不存在（代码评审确认） | M4-10, M4-13 |
| M4-12 | memory 子系统移植 + 投影：distiller 单次纯文本调用（provider 无关）+ SQLite 唯一真相 + Notion「Agent 记忆」整页重建投影 + 调查报告/逐场景 verdict 强制进料 + 进料流速指标 | `src/memory/` | busybee memory 单测迁移全过；整页重建后人对记忆页的评论经同一 ingest 回流 e2e；流速指标出现在统计页 | M1-19, M1-32 |
| M4-13 | Prompt 工作台完整版：`prompt_overlay(prompt_key, version, content, status, created_by, source)` + 灰度指定卡试跑 + 行为回归对比 + 发布/回滚 + 每次 run 规范日志记 prompt 版本 + overlay/repo diff 数首页提示 | 控制台工作台模块 + runner 对接 | e2e 全流程：编辑→draft→灰度 2 张卡→对比报告→发布→回滚；任一 run 的规范日志含 prompt 版本号；回沉提示出现 | M2-13, M1-31 |
| M4-14 | 行为回归统计框架：固定样本集 N trials 通过率置信区间，nightly 运行，不 gate PR | `src/pipeline/behavior-regression.ts` + nightly 任务 | 对一个已知劣化 prompt 样本能检出统计显著差异；对无变化样本不误报 | M4-13 |
| M4-15 | repeat-tool 循环检测 + invariants 注册表：链 key=(工具名, canonical 参数) 阈值 [3,5,8] 递进提醒纯建议不否决；per-module invariant companion（turn/step 配对、tool call/result 配对、状态机迁移合法、outbox 单调、lease 唯一） | `src/observability/guards.ts` + `invariants.ts` | 循环模拟触发递进提醒且 tool/result 保持原样；每条 invariant 有违反构造用例抛带包名的 InvariantError | M1-31 |
| M4-16 | 供应商健康页 + 运行统计页完整版：熔断三态/探针历史/错误分类分布/failover 事件流 + 闭环流速指标面板（memory 蒸馏量/footprint 偏差率/triage 流量/双 outbox 深度/429 率/turn_end.reason 比率，断流告警可视化） | 控制台两页 | M4-04/05/06 演练的全部事件在页面可见；任一流速指标注入归零触发告警并在面板标红 | M4-04, M4-08 |
| M4-17 | **M4 验收**：断供演练 + 完整反馈自迭代一轮 | `docs/poc/m4-acceptance.md` | ① 撤 Codex 凭据 24h，GLM/Grok 接管全部档位继续交付，恢复后自动回切，成本账本无缺账；② 一轮完整闭环：人评论 → friction 累计 → 提案卡 → 人批 → 灰度 → 行为回归对比 → 发布，全程留痕 | M4-01..16 |
| M4-18 | （2026-09-01 增补，列于验收行之后、不改变 M4-17 出口判据）定期代码优化单：周期扫描 friction 累计/footprint 偏差率/回归失败率/lint 静态债，超阈值自动立「优化卡」进看板走标准 Story 流水线（无特殊路径）；频率与阈值 config 化；同源问题按签名去重不重复立卡——支撑「代码质量由自动化管控、人只做场景验收」（03 §7.2） | `src/orchestrator/optimization-cards.ts` + config 键 | 注入超阈值数据触发立卡；同一签名不重复立卡；优化卡与普通 Story 走完全相同流水线（代码评审确认无旁路） | M4-10, M2-07 |

---

## M5 收口

目标：Windows worker、三平台 self-update、行为回归基线、GA。

| ID | 任务 | 输出物 | 验证方式 | 前置 |
|---|---|---|---|---|
| M5-01 | Windows 探针 worker：登录计划任务 + 看门狗（不用 nssm，规避 Session 0 隔离）+ pi 强制 Git Bash 环境；只接 cap.windows 探针 job | 部署脚本 + 手册 | 重启 Windows 后 worker 自动回归；有头浏览器可启动；完成一次真实 windows 探针 job | M0-06, M3-10 |
| M5-02 | Windows 降级路径（若 M0-06 判失败则替代 M5-01 的 pi 部分）：纯 Playwright 探针执行器 | `src/worker/playwright-probe.ts` | 无 pi 进程情况下完成一次 windows 探针 job 并回传证据 | M0-06 |
| M5-03 | self-update 滚动升级：控制台发布目标版本 → worker 空闲自查 → 自 drain → 升级 → SHA handshake 上报；同时只升一台、Linux 最后；pi 版本纳入同机制先单机灰度 | `src/self-update/`（busybee 骨架 + 跨平台 relaunch 抽象） | 三机滚动升级一轮无任务丢失无双版本并跑；注入坏版本 handshake 失败 → 停止推进并告警；pi 新版本单机灰度流程走通 | M3-12 |
| M5-04 | 行为回归统计基线固化：基线样本集入库 + nightly 常态化 | 基线集 + 报告存档 | 连续 7 天 nightly 报告生成且无误报 | M4-14 |
| M5-05 | 运行周报页：Notion 单页投影（吞吐/成本/friction/回归趋势） | 周报生成器 | 一期真实周报生成，Ryan 认可可读性 | M4-16 |
| M5-06 | 文档纪律：每个注入模型上下文的模块（prompt 片段/工具/skill）README 声明 Token effect 与 KV cache effect + CI 检查 | README 补齐 + CI 规则 | CI 对缺声明的新模块报错；存量模块全部有声明 | M4-13 |
| M5-07 | 安全收口复查：盘加密/内网隔离确认、审计双通道抽查、全量红线用例回归、脱敏规则复扫 | 安全 checklist 归档 | checklist 逐项打勾；红线用例回归全绿；全日志导出目录复扫无凭据泄漏 | M5-03 |
| M5-08 | **M5 验收 / GA**：连续两周 7×24 无人干预运行 | `docs/poc/m5-acceptance.md` + 运行统计 | 两周内所有停点均为合法三类（blocking_question / verify_loop_exceeded / retry_limit_exceeded）；无静默断流告警未处置；周报连续两期产出 | M5-01..07 |

---

## 贯穿性事项（不属于单一里程碑）

| 事项 | 约束 |
|---|---|
| R-5 移植重审 | 每个移植 PR 必须声明 single-process 假设重审结论（见使用约定） |
| 设计偏离回写 | 实现与 00–06 设计偏离时，先改设计文档再改代码，同 PR 提交 |
| fixture 资产累积 | M0 起采集的 RPC 错误/usage-limit/Notion 行为 fixture 全部入仓，契约测试永续使用 |
| 验证证据归档 | 每个验收任务的轨迹/截图/SQL 核对记录归档 `docs/poc/`，清单行末回填链接 |
| 一机一账号纪律 | 任何时候不复制 auth.json 跨机（refresh token rotation 会互踩报废）；新机器接入一律 device code 重新登录 |
