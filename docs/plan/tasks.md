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
| MQ+IT | （2026-09-09 增补，排期在 MP 之后）主流程收敛：内环只保留一个 LLM 判定 + 轮次烧掉的归因修复 | 10+22 | MQ-10 两张卡无人干预走完全程 |
| MR | （2026-09-14 增补，**排期在 MQ/IT 收尾之前**）TDD 脊柱与 Agent 运行时解耦：SHAPE/SPECIFY 两阶段 + 阶段契约注册表 + Agent 规格分表 + 缓存三件套 + 三通道人在环 + 观测三环 | 39 | MR-38 十条判据端到端 |

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
| M0-02 | ✅ pi 安装与 pin：安装脚本将 pin 版本装入 `~/.hivemind/pi/<version>/` 并排目录；GLM(zai)/Grok(xai) key 配置就绪 | `scripts/install-pi.sh`，pin 唯一来源 `package.json` `hivemind.piVersion`（`src/runner/pi-binary.ts` 读取） | 全新环境执行脚本后 `pi --version` 等于 pin 值；zai/xai 各发一条最小 completion 成功 | — |
| M0-03 | ✅ PoC-2a：RPC Context 导出/载入 | `poc/rpc-context/` 脚本 + `docs/poc/poc-2-context.md` | 导出 Context JSON → 新进程载入 → 再导出，两份 JSON 语义 diff 为空；载入后续跑一轮回答与原上下文连贯 | M0-02 |
| M0-04 | ✅ PoC-2b：mid-run 注入 / abort / resume 能力 | 同上报告附录 | run 中 abort 后同 session 注入消息续跑成功；不支持则报告记录降级路径（extension turn 边界序列化 / json 模式 + phase 边界注入）并回写 02 文档 | M0-03 |
| M0-05 | ✅ PoC-5：RPC 错误事件目录——人为制造 AUTH（坏 key）/ RATE_LIMIT / TRANSPORT（断网）/ INVALID_REQUEST 四类错误并采集结构化事件 | `fixtures/rpc-errors/*.json` + `docs/poc/poc-5-error-catalog.md` 错误模式表初稿 | 每类 ≥1 个真实样本；草拟的分类规则能对全部样本唯一分类 | M0-02 |
| M0-06 | ✅ PoC-1：Windows Git Bash 下 pi RPC 冒烟 ×10（含工具调用任务） | `docs/poc/poc-1-windows.md`（冒烟脚本随原生 Windows 路径退役删除，2026-09-05） | 10/10 无 CRLF 分帧错误、无挂死；不过则报告中拍板降级为纯 Playwright 探针执行器 | M0-02 |
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
| M1-25 | ✅ 收敛判据纯函数：`failed_scenarios(N)` 不得与此前任一轮相同（2026-09-17 由严格真子集放宽，见 MT-01）+ 持平/扩大/震荡分类 | `src/pipeline/convergence.ts` | 表驱动单测（空集/首轮/震荡序列/持平） | M1-01 |
| M1-26 | ✅ verdict L3 代码校验：URL host 白名单、截图真实存在且 mtime 在本轮窗口、结果从轨迹提取非自报、红绿证据双通道挖掘（git 历史 + 轨迹；挖不到 → 盲审升级） | `src/pipeline/verdict.ts` | 伪造 verdict fixture（自报通过但轨迹无证据/截图 mtime 过期）全部被拒 | M1-24 |
| M1-27 | ⛔️ 已撤销（MQ-04，见 03 §8.1）completion verifier：每 phase 出口独立小脑单次调用判 done 真伪，fail-closed，否决理由注回同轮 | `src/pipeline/completion-verifier.ts` | fail-closed 单测 + `smoke-completion-verifier.ts` 真实 pi fresh session 通过 | M1-05 |
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
| M1-36 | ⚠️ 控制台骨架：Fastify 只读 API（节点健康 / 任务视图 EventLog 时间线 + trace HTML / 成本 / config） | `src/console/` | Windows loopback 实际数据启动；公网通配绑定被拒。**2026-09-17：前端 SPA（`console-ui/`）连同 `build:console` 一并删除**——它由 hivemind 自己按新需求重做，服务端在 `serveUi` 为假时只提供 `/api/*`，与写面（M2-13）都保留 | M1-32, M1-33 |

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
| M2-12 | ⚠️ 重试上限族接入：maxInnerLoopRounds(3，2026-09-17 由 6 收紧) / maxPhaseReentries(3) / maxContinueRetries(8) / maxRegressionReopens(2) 全部 config 化热更；到限 → `retry_limit_exceeded` 真停点 + 卡置失败 + 诊断报告（需求侧 vs 系统侧两分法）+ Notion @创建人附收敛曲线 | `src/pipeline/retry-limits.ts` | 四个上限统一从 config 读（此前 inner loop 硬编码 6、continue 硬编码 8，改配置无效）；停卡时生成报告：逐轮失败数曲线 + 需求侧/系统侧判定（同一批场景零进展判需求侧；通过后又失败判系统侧；证据不足一律判系统侧，避免把人指向错的地方），报告随 needs_input 走旁路通道。仍开放：逐个上限的故障注入演练、friction 物化（M4-10） | M1-25, M1-07 |
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
> 活体接线暴露并已修的闭环缺口（`npx vitest run` 122 文件 724 测试全绿）：① EPIC_ACCEPT→DONE 无人触发、Epic 状态列从未投影（需求永远进不了 ACCEPTANCE）→ `EpicCompletion` + `sync_epic_status`（03 §7.2 / 01 §2.2 带日期补记）；② 需求页人类输入（PRD 批准/修改意见、验收勾选与缺口留言、停靠/恢复）的解释器只在测试里被调用 → `NotionRequirementInputSync` 接进需求循环；③ 两常驻进程共用 outbox 互相吞行 → 回放按操作过滤；④ worker 浏览器白名单硬编码 → 读 `guard.e2eHostAllowlist`；⑤ VERIFY 会话既不知道也拿不到 `playwright-cli`（prompt 无浏览器车道、PATH 无 CLI、`prompts/phases/verify.md` 从未装载）→ 白名单非空时 prompt 注入浏览器车道说明（只含 host 列表与卡 id，跨机逐字节相同）、hivemind 自己的 `node_modules/.bin` 进 VERIFY/回归会话 PATH、VERIFY 系统提示装载基线+verify.md；⑥ Epic 拆解的阻塞问题不上看板、BLOCKED 无出口 → 问题以评论投到 Epic 页，人的评论即回答并回到 DECOMPOSE；⑦ 两常驻进程共用库文件读到 `SQLITE_BUSY` → 连接级 `busy_timeout` + WAL。活体进度：PRD 已人批冻结，拆出 3 个 Epic，其中 2 个已呈现 Story 拆解方案等人批准，1 个在等阻塞问题的回答。
> Linux 单节点部署件就位（MP-11），`npm run preflight` 在本机 24 项通过、1 项 WARN（未配带外告警通道）。
> **Linux 实跑（2026-09-02，本机 colima 虚拟机内干净 Ubuntu 24.04 arm64 容器，不放任何凭据）**：`deploy/linux/install.sh` 全程跑通（npm ci、pinned pi 直连下载并校验、headless shell + 系统库、目录权限、service.env、单元渲染）；`npx vitest run` 121 文件 726 测试全绿；`smoke-browser-e2e` **9/9 通过**（MP-09 的 Linux 判据关闭）；preflight 12 PASS，其余 FAIL 全为容器内无凭据的预期项。实跑暴露并修掉三处部署缺陷：`install-pi.sh` 依赖已登录的 `gh`（首装时尚未登录）→ 直连公开 release；arm64 Node 缺 `libatomic1` → runbook 前置；Ubuntu 23.10+ AppArmor 限制用户命名空间使 Chromium 沙箱起不来 → preflight 检查 + runbook 首选 sysctl 修法 + `verify.chromiumSandbox` 显式开关（默认开、标 dangerous）。
> **执行状态追记（2026-09-05，macOS 本机接真实 Notion，Ryan 授权代理人以本人身份做人工 gate）**：三个 Epic 的拆解方案获批、E2RESULTS 阻塞问题得到回答，12 个 Story 入库建页；S-E2RESULTS-01 与 S-E1ACTION-01 各有一轮盲审 accepted，后者的证据目录含真实 headless 浏览器截图（判据③的证据形态已出现，交付未完成）。接线 Epic→Story 这条边暴露 20 项缺口（投影早于建页、分支切自尚不存在的 epic 分支、DESIGN 前读 DoD、NEEDS_INPUT 无法回 QUEUED、调度饿死、VERIFY 写模式启发式误拦箭头函数与所有重定向、verdict 无理由、judge 只看尾部工具结果、供应商故障混入卡预算、用量撞墙熔断被凭据探针关回、Story 页重复插入、关停不 drain 等），已全部修复并有单测；逐条见 `docs/poc/mp-acceptance.md` 当日表。当日 17:02 Codex 用量窗口撞墙，流水线等待窗口恢复。

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
| MP-09 | ⚠️ 单机全能力 worker：headless 浏览器自动化落地本机（原 M3-09 前移）。**选型改为双车道（2026-09-01，见 02 §4.3 更正）**：验证/回归 = `@playwright/test`，探索与自愈 = `@playwright/cli`（Playwright 核心团队维护，经 bash，token 约为 MCP 的 1/4），不引入 MCP 与任何社区 pi adapter；浏览器红线三层同源（bash 命令行导航过闸 / 浏览器 allowedOrigins / 判据校验） | `src/verify/browser-config.ts` + `src/guard/tool-decision.ts` 导航拦截 + `scripts/smoke-browser-e2e.ts` | 真实 headless Chromium 冒烟 9/9：allowlist 内可开、`file://` 与非白名单 host 被 guard 拒、名单外请求被浏览器以 `net::ERR_BLOCKED_BY_CLIENT` 拒、截图落进证据目录；guard 拦截单测 12 条。Linux 判据已关（2026-09-02 干净 Ubuntu 24.04 arm64 容器 9/9）。仍开放：一个真实 Story 的浏览器 e2e 证据（并入 MP-10） | M1-10 |
| MP-11 | ✅ Linux 单节点部署件：幂等安装脚本（Node 26 检查、`npm ci`、pinned pi、Playwright headless shell + 系统库、`~/.hivemind` 与 secrets 模板 600、systemd 服务环境）、两个 systemd 用户单元（orchestrator / requirements 分 unit，共用一库一 outbox）、就绪探针 `scripts/preflight.ts`（pi/凭据/Notion 三库共享/配置断言/provider 凭据/四档位 provider/gh 或 glab/git 身份/headless Chromium，不打印凭据）、runbook | `deploy/linux/` + `scripts/preflight.ts` + `docs/runbooks/linux-single-node.md` | 本机 `npm run preflight` 24 PASS / 1 WARN；干净 Ubuntu 24.04 arm64 容器内 `install.sh` 全程跑通、单测 726 全绿、浏览器冒烟 9/9、preflight 正确报出内核沙箱限制。仍开放：带凭据的真实 Linux 主机上起两个 systemd 单元（并入 MP-10） | MP-09 |
| MP-10 | **MP 验收**：一条真实模糊需求（首个候选：本项目 web 客户端）在 Linux 单机走完 澄清→PRD 确认→拆解（≥1 Epic ≥2 Story）→开发交付→场景化验收 全程 | `docs/poc/mp-acceptance.md` | ① 全程 Notion 单一信息源可追溯；② 除四类设计内人工 gate（澄清回答/PRD 批准/PLAN_APPROVAL/验收勾选）外无人干预——含不打临时修复、不写人工恢复脚本（M1-37 教训）；③ 至少一个 Story 的验证含真实浏览器 e2e 证据；④ 验收清单逐条对应 PRD 场景 | MP-01..09, M2-14 |

## MQ 主流程收敛（2026-09-09 增补，排期在 MP 之后、M3 之前）

目标：让一张垂直切片 Story 在无人干预下稳定走完 DESIGN→CODE→VERIFY→合流→draft MR。设计见 03 §8；断点分析见 `docs/design/diagrams/story-main-flow-as-built.html`。切入点：S-E3OVERVIEW-01（分支代码已完成、单测 22/22 通过，卡在流程）。

> 前置动作：2026-09-05 会话的 41 个文件修复（P1–P31）已提交（`fix: close the gaps that stalled Story cards mid-flow`）。
>
> 开跑前置：CODE 出口与合流复验都跑「仓库自己声明的门禁命令」，本仓库要先写进 config——
> `codeExit.projectChecks = [{"name":"npm run lint","command":["npm","run","lint"]},{"name":"npm run typecheck","command":["npm","run","typecheck"]},{"name":"npm test","command":["npm","test"]}]`
> （per-repo 作用域，空清单时合流复验会拒绝把未检查的合流算通过）。

| ID | 任务 | 输出物 | 验证方式 | 前置 |
|---|---|---|---|---|
| MQ-01 | ✅ 供应商故障不进预算：QUOTA/RATE_LIMIT/TRANSPORT/TIMEOUT/AUTH 只进熔断，卡原地等待，不计内环与重入、不产生停点；熔断开合写 event_log；探测改用凭据探针；usage limit 无窗口时指数退避 | `src/runner/circuit-breaker.ts`、`scripts/run-local-orchestrator.ts` | 单测：每类故障后 `phase_reentries` 与 `inner_loop_rounds` 不变、`stop_reason` 为空；真实 fixture（"The usage limit has been reached"）进 `fixtures/rpc-errors/` 并有测试保证不被漏掉 | — |
| MQ-02 | ✅（smoke-crash-recovery 待真实 pi 跑） CODE 超时改为 checkpoint 续跑：prompt 超时不判失败，走 continue-retry；`maxContinueRetries` 耗尽才算一次失败；超时阈值 config 化 | `src/orchestrator/pi-phase-port.ts`、`src/config/registry.ts` | 单测：超时后 checkpoint 被载入续跑；`smoke-crash-recovery` 通过 | MQ-01 |
| MQ-03 | ✅ OAuth 刷新单点化：orchestrator 持文件锁刷新，worker 只读；修好前 `schedule.maxConcurrentStories` 默认 1 | `src/runner/auth-*.ts` | 并发测试：两个 runner 同时启动只发生一次刷新 | — |
| MQ-04 | ✅（S-E3OVERVIEW-01 实跑待配额恢复） CODE 出口确定性检查替代 completion judge：树干净且有提交、每场景红绿轨迹、`@scenario` 标记覆盖 DoD、format/lint/typecheck/全量测试；不过不计预算，清单喂回 CODE；撤销 MERGE judge | `src/pipeline/code-exit-gate.ts`（替换 completion-verifier 的调用位） | 单测覆盖四项各自失败的清单文案；S-E3OVERVIEW-01 分支上实跑一次全过 | — |
| MQ-05 | ✅ MERGE 只写报告：删去门禁语义；报告业务区 regex lint | `prompts/phases/merge.md`、`src/notion/...` | MERGE 无 `git diff --check` 失败路径；lint 单测 | MQ-04 |
| MQ-06 | ✅ 合流复验确定性化：rebase 后只跑本 Story 与 footprint 相交 Story 的测试（含 e2e 脚本），通过即 ff-merge；盲审归回归 loop，失败开 regression 卡；修 `scripts/run-story.ts` 盲审 cwd 与 HEAD 断言 | `src/vcs/subset-verifier.ts`、`src/vcs/merge-flow.ts` | 单测：复验只调用测试执行器不调用 BlindVerifyExecutor；集成测试：两张相交 Story 顺序合入 | MQ-04 |
| MQ-07 | ✅ 收敛判据只吃代码层失败：环境类 fail 记 `inconclusive`，不进 failed 集合、不消耗轮次；连续两次 inconclusive 物化 friction | `src/pipeline/convergence.ts`、`src/verify/executor.ts` | 单测：服务 404 类理由不触发 expanded | MQ-06 |
| MQ-08 | ✅（真实 gh 实跑待配额恢复） Story draft MR：DELIVERED 时开 story→epic 的 draft MR，链接回写 Notion MR 属性；Epic MR 仍为最终入口 | `src/vcs/story-delivery.ts` | 单测 + 真实 gh 实跑一次 | MQ-06 |
| MQ-09 | ✅ DECOMPOSE 垂直切片约束：每张 Story 声明用户可见入口与独立验证路径；Epic 内 Story 数上限 config 化（默认 4）；水平切分打回重拆 | `prompts/phases/decompose.md`、`src/orchestrator/epic-decompose*.ts` | 单测：六张同页面验收条目的拆解被拒；现有 E1ACTION 拆解按新约束重拆 | — |
| MQ-10 | **MQ 验收**：S-E3OVERVIEW-01 在无人干预下从当前 NEEDS_INPUT 恢复后走完 CODE 出口检查→VERIFY→合流→draft MR；随后重拆的第二张 Story 从 QUEUED 走完全程 | `docs/poc/mp-acceptance.md` 追记 | 两张卡各自 event_log 中无 retry_limit_exceeded；供应商故障期间 `stop_reason` 始终为空 | MQ-01..09 |
| IT-01 | ✅ DoD schema 扩展：scenario `examples`（shows/excludes）与 `source`（含 e2e/ui 层必填）；`acceptance_criteria` 每条挂 `scenarios` 或 `constraint`；顶层 `out_of_scope`、`relies_on`；层归属由系统固定（unit/integration/snapshot→CODE，e2e/ui→VERIFY）；DESIGN prompt 同步 | `src/pipeline/dod.ts`、`prompts/phases/design.md` | dod 单测：旧形态 DoD 被拒并点名原因 | — |
| IT-02 | ✅ CODE 出口「逐条回应」：每个注入 tag 需 `addressed <tag>:` 一行，缺则 finding 喂回同一 session | `src/pipeline/code-exit-gate.ts`、`src/orchestrator/pi-phase-port.ts` | gate 单测 | IT-06 |
| IT-03 | ✅ 走查否决回指 DoD：`failed` 必带 `cites` 且真存在；引不到降为 finding + DoD 修订建议写 Notion；`out_of_scope`/`relies_on` 随 prompt 下发 | `src/verify/ui-review.ts`、`src/orchestrator/ui-reviewed-verify-port.ts` | ui-review 单测 | IT-01 |
| IT-04 | ✅ VERIFY 屏幕证据校验：e2e/ui 场景需独有截图 + 到达页面，缺则 inconclusive（环境类） | `src/pipeline/verdict.ts`、`src/verify/executor.ts` | verdict 单测；smoke-browser-e2e | IT-01 |
| IT-05 | ✅ 环境失败补类：「route not found / 看到旧页面 / 无法复现 worktree UI」归环境 | `src/pipeline/failure-classification.ts` | classification 单测 | — |
| IT-06 | ✅ prompt 结构：`## What this round must do` 置顶带 tag；只注入每 (phase, kind) 最新产物；从最新验证产物提取逐场景原因 | `src/pipeline/phase-input.ts`、`src/orchestrator/story-execution-store.ts` | phase-input / store 单测 | — |
| IT-07 | ✅ 人的回答回写 Notion：「已应用的回答」（谁、何时、针对哪条、原文、用于第几轮），代答诚实署名 | `src/notion/story-projection.ts` | projection 单测 | — |
| IT-08 | ✅ `scripts/inspect-round.ts` 转正：一轮一屏；VERIFY/走查 session 按时间窗口定位 | `scripts/inspect-round.ts` | 对 S-E3OVERVIEW-01 第 7 轮实跑 | — |
| IT-09 | ✅ `scripts/replay-phase.ts`：用存下的轮次输入单跑一个 phase，不写库不动状态机 | `scripts/replay-phase.ts` | 脚本按 `--card-id/--phase/--print-prompt` 实跑过；原判据点名的 S-E3OVERVIEW-01 已随 2026-09-18 的建库重置删除，无法再对它复跑 | IT-06 |
| IT-10 | ✅ 每轮 prompt 全文落盘到 session 目录；prompt 文件版本 sha 记入 `phase_runs` | `src/orchestrator/pi-phase-port.ts` | 单测 | — |
| IT-11 | ✅ Notion 验证记录可读：accepted 轮写「N 个场景都验证通过（…）」，rejected 轮逐场景写两条道原因与所依据的 DoD 句子，列出 DoD 修订建议 | `src/notion/story-projection.ts` | projection 单测 | IT-03 |
| IT-12 | ✅ 轮次账本展示：`Budget x/6` 按 `last_human_action_at` 之后被拒轮数计；round 流水号不重置 | `src/notion/story-projection.ts` | projection 单测 | — |
| IT-13 | ~~**IT 验收**：S-E3OVERVIEW-01 重置到 DESIGN 重跑；对照旧 8 轮~~ **判据在 2026-09-14 重写并并入 MR-38**。原判据在新拓扑下不成立：卡不再从 DESIGN 起跑（前面多了 SHAPE），DoD 的产出方也换了阶段，「对照旧 8 轮」没有同基准。IT-01..12 的**单项判据仍然有效**，只是端到端那一条由 MR-38 承担 | 见 MR-38 | 见 MR-38 | IT-01..12 |
| IT-14 | ✅ Epic 分支在拆解批准时推送；派发前重试；合入后推头 | `src/vcs/epic-branch.ts`, `plan-approval.ts`, `merge-flow.ts` | 单测 + 实跑 origin/epic/E3OVERVIEW 存在 | — |
| IT-15 | ✅ Story draft MR 在 ff-merge 之前开（rebase → 推分支 → 开 MR → 复验 → 合入）；复用已开 MR；目标已包含则不开 | `merge-flow.ts`, `epic-integration.ts`, `story-worker.ts`, `story-delivery.ts`, `mr/adapters.ts` | 单测顺序断言 + S-E3OVERVIEW-01 resume 实跑 | IT-14 |
| IT-16 | ✅ Epic MR：缺红绿提交对不抛错；目标分支来自 `--target-branch`；等回归池干净；关闭未合并退回 EXECUTING | `src/vcs/epic-delivery.ts`、`src/orchestrator/epic-completion.ts`、`src/regression/epic-gate.ts` | 单测 | — |
| IT-17 | ✅ 走查环境：`verify.appStartCommand/appReadyUrl/seedCommand`，DoD `seed`；走查 inconclusive 可见 | `src/verify/app-under-review.ts`, `ui-reviewed-verify-port.ts`, `dod.ts` | 单测 + E3 卡实跑 | — |
| IT-18 | ✅ 需求层 `clearStop` 调用者；停点详情上页；HUMAN_PARKED 空 resume 不抛；EXECUTING 期间重投影 | `requirement-input-sync.ts`, `requirement-page-delivery.ts` | 单测 | — |
| IT-19 | ✅ MERGE 可重入；✅ 人工/契约触发的回 DESIGN 解冻并作废可复用轮 | `run-local-orchestrator.ts`, `story-execution-store.ts`, `story-worker.ts` | 单测 | — |
| IT-20 | ✅ Story 停牌上浮 Epic BLOCKED，恢复自动回 EXECUTING；escalation 型 BLOCKED 不可被评论触发重拆 | `src/orchestrator/epic-escalation.ts` | 单测 | — |
| IT-21 | ✅ outbox attempts + dead 状态 + 计数日志 + 死信列表 | `src/notion/outbox.ts` | 单测 | — |
| IT-22 | ✅ 回归环路：sweep 传 probe worktree；`regression_cards` resolve；REGRESSION_FIX 可运行 | `scripts/run-regression.ts`, `regression/store.ts`, `story-worker.ts` | 单测 + 人为制造回归实跑 | IT-16 |

IT-* 与 MS-* 逐行复核（2026-09-18）：此前未打勾的 IT-05/09/10/16/17/18/20/21/22 与 MS-01/02 全部已落地，
逐条对着代码与测试确认后补勾。唯一的实质修正是 IT-16 的输出物路径：`epic-completion.ts` 在 `src/orchestrator/` 而不是 `src/vcs/`。
IT-09 的判据点名了一张已被删库带走的卡，改写为脚本自身的实跑；IT-13 仍是并入 MR-38 的那条，不单独打勾。

---

## MR TDD 脊柱与 Agent 运行时（2026-09-14 增补，排期在 MQ/IT 收尾之前）

目标：把 TDD 从「CODE 内部的 micro-cycle」提升为跨阶段脊柱，把「用什么 Agent 跑」与「阶段产出什么」拆开，并让跨阶段前缀缓存第一次真正生效。设计见 `07-agent-runtime.md`、03 §12、04 §5。

**排期说明**：IT-09 / IT-10 触碰 `story-worker` 与 `pi-phase-port`，并进 MR-A 一次改完，不做两遍；IT-13 的端到端判据重写后并入 MR-38（见 IT-13 行）。其余未完成 IT 条目（IT-05/16/17/18/20/21/22、MQ-10）在新拓扑上继续，不受 MR 阻塞。

**MR-A 内部有硬顺序**：MR-08（key）→ MR-10（TTL）→ MR-12（前缀顺序）→ MR-13（度量）。key 没钉住之前做顺序优化，收益是零。

> **执行状态（2026-09-14，macOS 本机，确定性 mock provider 走通单机全流程）**：MR-01..MR-37 的生产代码与本机可执行判据完成，MR-38 / MR-39 仍开放（⏸），它们要的是真实卡 + 真实 provider，本机 mock 换不来。
>
> 实际跑过的命令与结果：`npx tsc --noEmit` 干净；`npx oxlint src scripts poc` 2 条既有告警（`story-execution-store.ts:609` prefer-set-has、`code-exit-gate.test.ts:186` consistent-function-scoping），无新增；`npx vitest run` **162 文件 1323 测试全绿**；`npx tsx scripts/smoke-story-pipeline.ts` 六条 PASS 全过；`npx tsx scripts/smoke-blind-verify.ts`、`npx tsx scripts/smoke-browser-e2e.ts` 通过。
>
> `smoke-story-pipeline` 这一轮被改成**单机端到端的真凭证**，不再只是状态机走位：真 bare remote + `git worktree` 的 Epic 分支、真 `EpicIntegrator` / `EpicMergeFlow`（rebase → 推分支 → 子集复验 → ff-merge → push）、种一个带 `@scenario` 标记的真测试文件，一张卡走完 `SHAPE→DESIGN→SPECIFY→CODE⇄VERIFY→MERGE→DELIVERED`，随后人为报一个缺陷走完 `DELIVERED→SPECIFY(narrow)→REGRESSION_FIX→VERIFY→DELIVERED`，最后断言 origin 上 `epic/E-MOCK-1` 的头就是修复后的 Story 头。断言含：6 次 run / 9 份产物 / 1 次 accepted / 6 条费用记录、`SPECIFY:2` + `REGRESSION_FIX:1`、最新 `story_test_contracts.mode = narrow`、回归卡 resolved。
>
> 这一轮端到端把三个**生产缺陷**逼了出来，都已修在生产代码里而不是绕在脚本里：① 浏览器道的配置写进 worktree，等于每一轮浏览器验证都在 VERIFY 钉住的树上制造改动并被隔离作废——改为环境变量下发（`src/verify/browser-config.ts`，理由另见 02 §3.3）；② SPECIFY 的 tree-pin 清理用 `git rm --ignore-unmatch`，它对**从未入库**的越界源码是空操作，于是最该撤掉的那类改动恰好被冻结 commit 收了进去（`src/pipeline/specify-gate.ts`，03 §12.2）；③ 人报缺陷把已交付的卡送回 SPECIFY 时没有标记它是窄版，`transition()` 按目标状态推导 `phase`，结果走的是全量 SPECIFY（`markNarrowSpecify`，03 §12.4）。另补一处设计缺口：窄版 SPECIFY 此前拿不到它要复现的失败签名，现按卡上的 `phase` 标记注入回归卡，走向 CODE 的那次 SPECIFY 一条都不注入，prompt 字节确定性因此仍成立。
>
> ⚠️ 的六条都是同一个形状——机制已落地、单测已锁住，**缺的那半条判据本机换不来**：MR-08 / MR-10 / MR-11 / MR-13 要真实 provider 的 payload 采集与第二台机器，MR-32 的结论已写进 02 §5.5（pi 0.85.1 的 `--no-refresh` 只挂在 `pi auth check` 上，agent 运行时无条件 `AuthStorage.create()`，所以子进程自刷新关不掉，只能靠 pi 自己的 `auth.json.lock` 串行化），MR-37 的公网绑定与内网可达要在真实 Linux 主机上验。这六条连同 MR-38 / MR-39 一起收在真实卡那一轮。

### MR-A 骨架：阶段契约、Agent 规格、prompt 成本

| ID | 任务 | 输出物 | 验证方式 | 前置 |
|---|---|---|---|---|
| MR-01 | ✅ 统一阶段枚举：`Phase` / `GuardPhase` / `StoryPhase` / `PmPhase` 收敛为一套，`ModelPurpose` 与之建立显式映射 | `src/pipeline/phase.ts`（新）、各处引用收口 | 类型层面无第二套枚举；改一处不会漏另一处的单测 | — |
| MR-02 | ✅ `PhaseContract` 注册表（含 `lane` 与干预点声明）+ `story-worker` 改为解释器 | `src/pipeline/phase-contract.ts`、`src/orchestrator/story-worker.ts` | 现有全部阶段走注册表；`story-worker.test.ts` 全绿；漏填 `lane` 编译失败 | MR-01 |
| MR-03 | ✅ `resolveAgentSpec` + Symbol brand + `assertAgentSpecs`；`RunnerSpawnOptions` 收紧为只接受 `ResolvedAgentSpec` | `src/runner/agent-spec.ts`、`src/runner/types.ts` | 单测覆盖全 purpose 映射；直传 model 字符串**通不过编译** | MR-01 |
| MR-04 | ✅ agent 族 registry 键落地：tools / prompts / guard / context / limits / skills / mcp（07 §2.2）。**并先修穷举 schema**（07 §2.2a）：`registry.ts:221` / `:248` 两处 `z.record(z.enum(...))` 是"少一个键就整键失效"的语义，与同文件 `z.partialRecord` 写法不一致；新增的七个键一律用 `partialRecord`，完整性由代码默认值承担 | `src/config/registry.ts`、`model-policy.ts` | 每键独立 schema 与 reload 语义；改一键不波及其他键的 overlay；**只含一个 purpose 的 overlay 能生效，而不是整键回落**；含未知 purpose 的 overlay 仍被拒；`MODEL_PURPOSES` 每个成员都能解析出 tier 的启动断言 | MR-03 |
| MR-05 | ✅ **工具集全阶段统一**（07 §6）：四处字面量删除，`blind-verify-port` 的 `[read,bash,grep,find,ls]` 并入统一来源；阶段约束改由 prompt 尾部 + 出口判据承担 | `pi-phase-port.ts`、`pi-pm-port.ts`、`pi-decompose-port.ts`、`blind-verify-port.ts`、`scripts/run-story.ts` | grep 仓内无第二处工具集字面量；单测断言各阶段拿到**逐字节相同**的工具块 | MR-04 |
| MR-06 | ✅ 修 `store.ts` 静默回落：dangerous 键校验失败启动即拒，其余产生告警事件 | `src/config/store.ts` | 注入坏 overlay 的单测：dangerous 键启动即拒；其余出告警事件且不静默换掉策略；**回归用例：部分键的 overlay（控制台只改一个 purpose 的形态）不得触发回落**——这是 `store.ts:70` 注释预言的失效模式里最容易撞上的一种 | — |
| MR-07 | ✅ 并入 IT-09（`replay-phase.ts`）与 IT-10（prompt 全文落盘 + 文件 sha 入 `phase_runs`） | `scripts/replay-phase.ts`、`src/orchestrator/pi-phase-port.ts` | 对一轮真实输入重放；prompt sha 变化可归因到具体文件 | MR-02 |
| MR-08 | ⚠️ **把 `prompt_cache_key` 钉成 per-card-per-lane**（07 §4.2-①）：spawn 前自建只含 SessionHeader 的空 JSONL，`id` 从 `cardId + lane` 确定性派生，`--session` 指向它；**缓存 key / session 文件路径 / run 身份三者分开**（07 §4.4）；scope 做成 `cache.keyScope` 配置 | `src/runner/session-file.ts`（新）、`rpc-runner.ts` | ① `get_state` 零成本实测：pi 接受只含 header 的空 session、重复 id 不报错；② 采集 payload 验证同道各阶段 key 相同、跨道不同；③ `verify_records` 的 CHECK 与 `executor.ts:343` 全程不触发；④ `assemblePhasePrompt` 字节确定性单测不变 | MR-02 |
| MR-09 | ✅ **补回被拆掉的误共享探针 + 收紧盲审身份**（07 §4.5）：session 文件路径含 `card/phase/round/attempt`（attempt 取 `phase_runs.run_id`，**只含 phase+round 不够**——同一轮会因 failover / 崩溃恢复跑多次）；首次 spawn 前断言文件零消息；`sessionId(state)` 的 `sessionFile ?? sessionId` 收紧为锚定 run 身份；三条断言进 04 §4.2 invariant 注册表 | `src/runner/session-file.ts`、`src/verify/executor.ts`、`src/verify/ui-review.ts`、`src/observability/invariants.ts` | 单测：同卡任意两次**执行**解析不到同一路径；同 (phase, round) 的两次 attempt 路径不同（`startPhase` 删旧行重插，`run_id` 每次都新）；**零消息断言的"首次"定义在 `run_id` 之内**——同 run_id 的重连续跑带消息不被拒，跨 attempt 不允许续跑；人为指向同一路径时首次 spawn 被拒；**pi 不返回 `sessionFile` 时盲审隔离仍成立**；checkpoint 快照键与 session 路径同键 | MR-08 |
| MR-10 | ⚠️ **`PI_CACHE_RETENTION=long`**（07 §4.2-②）：经 `providerEnvFor` 注入。**判据按 provider 分开**——0.85.1 的 codex 适配器请求体里根本没有长 TTL 字段，`cacheRetention` 只判 `=== "none"`，所以这条在 day1 主力 provider 上**不是杠杆**；codex 的 TTL 由 ChatGPT 后端决定，不可控 | `scripts/run-local-orchestrator.ts`、结论写进 07 §4.2 | ① openai-responses / anthropic：采集 payload 里出现 `prompt_cache_retention` / `prompt_cache_options.ttl` / `cache_control.ttl`；② **codex：不验字段**，只验跨阶段间隔数十分钟后 `cacheRead` 仍非零，且把实测到的有效窗口记进 07 §4.2 的矩阵 | MR-08 |
| MR-11 | ⚠️ **堵住宿主机 skill 注入**（07 §4.6） | `src/runner/rpc-runner.ts`（spawn 参数）、部署文档 | 采集的 payload 里无 `~/.agents/skills` 内容；两台机器上同输入产出**逐字节相同**的 system prompt | — |
| MR-12 | ✅ **修 prompt 前缀顺序**（07 §4.2-③）：`baseline + repo context + per-phase`。工具集统一（MR-05）后工具块不再是断点 | `src/orchestrator/pi-phase-port.ts`、`src/pipeline/prompt-loader.ts` | 单测断言组装顺序与字节确定性；公共前缀 712B → 11,497B | MR-05, MR-10 |
| MR-13 | ⚠️ **跨阶段缓存度量**：`cache-analysis.ts` 从单 session 扩到按 `(card, lane)` 聚合历次 spawn，两道分开统计 | `src/observability/cache-analysis.ts` | 单测；一张真卡跑完能给出各道的 cacheRead 占比与结构上限 | MR-12 |

### MR-B TDD 脊柱

| ID | 任务 | 输出物 | 验证方式 | 前置 |
|---|---|---|---|---|
| MR-14 | ✅ 新增 SHAPE 与 SPECIFY 状态及转移边；`0001_init.sql` 四处 CHECK 改写（`:132` / `:151` / `:267` / `:287`，预发布立场：直接改写不累积迁移）。**枚举要同步的是四处以上**：`MODEL_PURPOSES`、`model.purposeTiers` 与 `model.purposeThinking` 各自的 zod 枚举与 default，共四处；穷举 schema 不先改成 `partialRecord`（MR-04），加成员会让 DB 里每条已存 overlay 当场静默回落（07 §2.2a） | `0001_init.sql`、`schema.ts`、转移表、`model-policy.ts`、`registry.ts` | 全迁移表单测；非法迁移抛错；漂移检测通过；`SHAPE → DESIGN → SPECIFY` 顺序被转移表强制；**加成员后已存 overlay 仍生效的回归用例** | MR-02, MR-04 |
| MR-15 | ✅ `test-contract` schema（含 `mode: full/narrow`）+ `prompts/phases/specify.md`（含尾部「只写测试」约束） | `src/pipeline/test-contract.ts`、`prompts/phases/specify.md` | schema 单测：缺 `expected_failure`、缺 boundary/negative、写了 e2e 层均被拒并点名原因 | MR-14 |
| MR-16 | ✅ SPECIFY 出口七项检查（03 §12.2），**顺序本身是判据**：第 1 项 tree-pin 清理必须跑在第 4 项证红之前，**基准是本次入场冻结的 `specify_base_commit` 而不是写死的 DESIGN commit**（一次执行落两个 sha：进场 `specify_base_commit`、出场 `specify_commit`），只放行 `scaffolding[]`；第 4 项红只认 `assertion` / `not_implemented` 两种形态；第 5 项按 `kind`/`file`/`actual`/`assertion` 逐字段比对；第 6 项把红证据绑定到最终 `specify_commit` 的**树 sha**并落库 | `src/pipeline/spec-exit-gate.ts` | 各项失败的清单文案单测；**编译错 / 模块找不到 / 非目标符号异常冒充红均被拒**；未声明的非测试改动被 revert；**核心用例：越界改源码造成的红，在 tree-pin 恢复后变绿，出口必须拒绝冻结**；**CODE 已实现一部分后人工解冻重入 SPECIFY，已有合法实现不得被 revert**；**交付后的窄版 SPECIFY 同样不得 revert 已交付实现**；证红后树再动一次则证据作废并要求重跑；**贯通用例：DESIGN 留下不可加载的接口草稿，SPECIFY 用 `scaffolding` 补到可加载并拿到合法的红**；`specify_commit` 可被 CODE 读到 | MR-15 |
| MR-17 | ✅ CODE 冻结测试：SPECIFY 产出的测试文件进 `fencedPatterns`，出口用 `git diff <specify_commit>..HEAD` 复验。**两个基准不能混用**：现有四项走 `merge-base(baseRef, HEAD)`（分支基准），这一项走 `specify_commit`（阶段基准） | `src/guard/policy.ts`、`src/pipeline/code-exit-gate.ts` | CODE 会话改测试被 block 且留痕；绕过 guard 的 bash 写法被出口抓住；单测断言两个基准各自取值正确且互不替代；红绿证据仍从分支基准的 commit 范围里取（SPECIFY 的 `test(S-xx): red` 在范围内） | MR-16 |
| MR-18 | ✅ `codeExit.projectChecks` 新形态：`when` / `requires` / `assertCleanPaths` + 顶层 `protectedPaths` | `src/config/registry.ts`、`src/pipeline/code-exit-gate.ts` | 改文档类文件不触发全量测试；已有快照被意外改动时报出；无快照目录的仓库跳过而不是报错 | MR-17 |
| MR-19 | ✅ 豁免路径：`downgraded_to` 同步更新 DoD `layers`（03 §12.2 第 7 项） | `src/pipeline/dod.ts`、`spec-exit-gate.ts` | 降级后该 scenario 由 VERIFY 证明；单测证明无「没人证」的路径 | MR-16 |
| MR-20 | ✅ **REGRESSION_FIX 前置窄版 SPECIFY**（03 §12.4）。**复用已有红测试时跳过的只是"写测试"，不跳过 SPECIFY** | `src/pipeline/phase-contract.ts`、`src/regression/` | 回归卡先产 `mode: narrow` 的 test-contract；复用路径仍须**在当前树上证红**、比对 `expected_failure`、冻结 `specify_commit`，并用 `reuse.covered_by` 点名复用哪条；**跳过整个 SPECIFY 的旧路径被判为不合法**（CODE 出口第 5 项的基准会因此不存在） | MR-16 |
| MR-21 | ✅ 停点原因带收敛分类上浮（03 §1.5）。**`stagnantRoundsBeforeStop` 不做**——取 1 等于现状、取 >1 等于允许把一轮原样再跑一遍；持平与震荡是同一条规则的两个窗口，只保留 `retry.oscillationLookback` | `src/pipeline/convergence.ts`、`story-worker.ts`、`registry.ts` | 单测：`stalled` / `oscillating` / `expanded` / `budget_exhausted` 在停点详情里各自可区分；改 `oscillationLookback` 只影响回看窗口、**不允许任何持平轮续跑**；**四类真停点数量不变**，DB CHECK 不放宽 | MR-02 |

### MR-C SHAPE 与人在环

| ID | 任务 | 输出物 | 验证方式 | 前置 |
|---|---|---|---|---|
| MR-22 | ✅ **SHAPE 阶段落地**（03 §12.5、§5）：`dod` 从 DESIGN 迁到 SHAPE 并冻结，`design_summary` 移出 DoD 成为 DESIGN 自己的产物；新增 `dod_version` 内容 hash，覆盖 **scenarios 的 id/given/when/then/layers/`source`/`seed`/examples + `acceptance_criteria` 的文本与场景归宿 + `baseline` + `out_of_scope` + `relies_on`**（03 §5 末；`source`/`seed`/criteria 映射是初稿漏掉的漏失效面）；**并派生 per-scenario 的 `scenario_version`**（该条字段 + 对它生效的全局字段：`baseline` / `out_of_scope` / `relies_on` / 引用它的 criteria），它才是逐条失效判据；归一化**只做结构规范化**：NFC→集合类数组稳定排序→键序规范 JSON→SHA-256，**不折叠任何空白**（`examples[].text` 是字面显示内容、`seed` 是逐字造数输入，折了就漏失效；首尾空白由 `dod.ts` 的 `z.string().trim()` 在 schema 层已削）；**新增逐场景结论明细表 `verify_scenario_results`**（`card_id`/`scenario_id`/`round`/`dod_version`/`scenario_version`/`verified_tree_sha`/`outcome`/`evidence`/`carried_from`，追加式、原行不可改）——`verify_records` 是 `UNIQUE (card_id, round)` 的整轮一行、无 `scenario_id`，加两列不够用；`prompts/phases/shape.md`；DESIGN 出口加「DoD 未被改动」检查 | `prompts/phases/shape.md`、`src/pipeline/phase-contract.ts`、`dod.ts`、`0001_init.sql` | 单测：DoD 产出方是 SHAPE；DESIGN 改 DoD 被出口拒；**只改 `source`（模拟数据→真实事件表）或只改 `seed` 时 hash 必变**；只改 criteria 的场景归宿时 hash 必变；**只改 `examples[].text` 或 `seed` 里的换行 / 缩进 / 连续空格，hash 必变**；只有集合元素书写顺序与 JSON 键序的差异不改变 hash。改一条 scenario 时：整卡 `dod_version` 变、该条 `scenario_version` 变、**其余 scenario 的 `scenario_version` 不变**；改 `out_of_scope` 时全部 `scenario_version` 一起变。`verify_scenario_results` 的漂移检测与 drizzle 类型同步通过。**不验"改措辞 hash 不变"**——普通 hash 做不到语义等价，该判据已撤回（03 §5）；已有 `dod.test.ts` / `story-worker.test.ts` 全绿 | MR-14 |
| MR-23 | ✅ DESIGN 降为纯设计阶段：产**接口声明草稿**（写 worktree，不约束编译），prompt 尾部明令禁止提问 | `prompts/phases/design.md`、`phase-contract.ts` | 声明落盘可被 SPECIFY 读到；DESIGN 产 open_questions 被拒；DESIGN 越界实现时 SPECIFY 出口红不起来而被拒的单测 | MR-22 |
| MR-24 | ✅ SHAPE 产 **`open_questions`**（建议解答 + blocking + closed 状态存中央库），三级漏斗写进 prompt；**只有 SHAPE 能产**；人回答后 `rejectReturnsTo: SHAPE`，并按 `dod_version` 决定下游产物是否失效（03 §12.5） | `src/pipeline/open-questions.ts`、`0001_init.sql`、`prompts/phases/shape.md`、`story-execution-store.ts` | 单测：其他阶段产 open_questions 被拒；非 blocking 不阻塞开工；目标仓库无偏好文件时 SHAPE 必须写明假设；**人回答一条后重入的是 SHAPE 而非 DESIGN**；**整卡 hash 不变时下游产物与冻结测试全部复用；变了则按 `scenario_version` 逐条判**——变的那条作废其冻结测试、未验证 CODE 轮、以及它已 passed 的 VERIFY 与走查结论，没变的保留并由系统追加 carry-forward 行（新 `dod_version` + 原 `scenario_version` + 原 `verified_tree_sha` + 指向原始明细行，标明是顺延不是重验，**原记录不可变**）。**顺延的条件是两个都不变**：`scenario_version` 不变 **且** `verified_tree_sha` 等于待合流的树——契约没变不证明结论还能用，改动 A、B 共用的代码可能已经把 B 弄坏；树一变就作废全部顺延行、重验全量，**本轮不做依赖分析**（退化成今天的行为，代价可接受）；`recordVerification` 入参增加**本轮实际验证的 scenario 集合**，只更新集合内的行，`story_specs.status` 降为投影、不再当判据；**关键用例三条**：① 两条 scenario 的卡 VERIFY 已全绿，MERGE 之前人回答只改了 A，重验后 A 不需改代码 → A 重验通过、B 顺延复用、正常进入 MERGE；② **只验了 A 的那一轮，未被验证且无有效旧证据的 B 不得被置为 `passed`**（今天 `story-execution-store.ts:534` 的 `ELSE 'passed'` 在全量验证下正确，逐条重验一引入就会伪造结论）；③ **A 的修复改动了 A/B 共用代码 → 树变，B 的旧通过结论不得沿用，转移边不放行**；转移边判据落在 `scenario_version` 上（落在整卡 `dod_version` 上会把 B 一起判失效，等于整卡推倒）；已 DELIVERED 的卡改走 `defect` 通道 | MR-22 |
| MR-25 | ✅ `rework` 通道：写 `phase.invalidated`（来源 `human`），按契约 `rejectReturnsTo` 回退重入 | `src/notion/story-input-sync.ts`、`story-execution-store.ts` | 单测：人工解冻与系统解冻走**同一条转移路径**且都留痕 | MR-02 |
| MR-26 | ✅ `defect` 通道：开 regression 卡，接 MR-20 的回归路径 | `src/notion/story-input-sync.ts`、`src/regression/store.ts` | 单测：评论到回归卡的完整链路 | MR-20, MR-25 |
| MR-27 | ✅ **补充 context 通道**：`preference`/`unclassified` 进 prompt 独立小节 `## Additional context from a person`，不改状态、不消耗轮次、不产生逐条回应义务 | `src/pipeline/phase-input.ts`、`story-input-sync.ts` | 单测：注入后 `inner_loop_rounds` 不变、无 `[answer:]` tag、prompt 仍**字节确定** | MR-25 |
| MR-28 | ✅ `applied_at` 语义修正：只有真触发转移或真进了某一轮 prompt 才写 | `src/notion/story-input-sync.ts`、`story-projection.ts` | 单测：未触发任何动作的 feedback 不被标记；Notion 上不再显示「已用于第 N 轮」的假话 | MR-27 |

### MR-D 派单与并发

| ID | 任务 | 输出物 | 验证方式 | 前置 |
|---|---|---|---|---|
| MR-29a | ✅ **先补租约的三个洞**（07 §5.1a），它至今零生产调用者，MR-29 是第一次承重：① fence 跨 `release`/`revoke` 单调（删行即重置为 1，而 revoke 恰好用在旧持有者最可能回来的场景）；② holder 改为**执行实例身份**而非 hostId（现在同 holder 重复 `acquire` 必定成功，同机两个子进程都会拿到卡）；③ 状态与产物写入带 fence 校验（全仓除 lease.ts 外无一处出现 fence） | `src/persistence/lease.ts`、`story-execution-store.ts`、`0001_init.sql` | 单测：① 同一 holder 的两个执行实例并发 acquire，第二个被拒；② revoke 后重领，旧实例拿旧 fence 做 renew / release / 写状态**三者全被拒**；③ fence 跨 revoke 严格单调递增 | — |
| MR-29 | ✅ **`story:run` 改为从 DB 领单**：只接 `--card-id`，自己落租约、自己 `resolveAgentSpec`。**并把启动时一次性定死的计费口径改成逐次解析**（07 §5.2a）：`:151` 的 `metered`、`:157` recorder 的 `provider`/`isSubscription`、`:335` 的 `metered ? { spend } : {}` 现在都由命令行那个 provider 决定；provider 改成逐阶段解析 + failover 之后，从订阅起步的卡切到计费 API 后**费用上限自始至终没挂、账还按订阅记** | `scripts/run-story.ts`、`src/persistence/lease.ts` 的首个生产调用者、`phase-recorder.ts` | 两个领取者抢同一张卡，第二个被 CAS 拒（并入 M3-02 的判据）；**同机两个子进程抢同一张卡，第二个被拒**；单测断言 SHAPE 用 brain+high、CODE 用 standard+medium——**thinking/tier 不再丢**；**端到端用例：同一张卡走「订阅 → 计费 API → 订阅」，计费段支出全部入账且不重复计，`spend` 端口在计费段挂上、订阅段不挂，单卡累计不因切回订阅而清零，越线后在 phase 边界停在 `cost_ceiling_exceeded`** | MR-03, MR-29a |
| MR-30 | ✅ `src/queue/dispatch.ts`：协调器只写「可派发集」，不再决定谁跑哪张卡；capability 过滤承载从队列改为 `stories.capabilities` | `src/queue/dispatch.ts`、`scripts/run-local-orchestrator.ts` | orchestrator 重启后不重复派；能力真空告警仍然触发（M3-01 判据） | MR-29 |
| MR-31 | ✅ per-provider 分桶 + 桶容量按 authType 保守默认（oauth 2 / api_key 4）+ 429 自动收桶。**桶按"每次真实 spawn"原子申请、结束释放、failover 换家重新申请**（07 §5.2）：provider 是逐阶段解析的，整卡领单时占一次位保证不了后续阶段；等容量**不消耗失败轮次、不产生停点**；占位带过期与心跳，持有者死亡后可回收（不用进程内计数——`story:run` 已是独立子进程，`run-local-orchestrator.ts:437` 的 `inFlight: Map` 管不住跨进程） | `src/config/registry.ts`、`src/queue/dispatch.ts`、`src/runner/circuit-breaker.ts`、`src/persistence/` | **两张卡同时切向容量为 1 的 provider，只允许一个启动，另一个等待且不计失败轮次**；**持有者进程被杀后容量可回收**；单测：同 provider 超桶不派、跨 provider 并行、RATE_LIMIT 后桶容量下调并冷却渐增 | MR-30 |
| MR-32 | ⚠️ 刷新单点化补齐：预刷新窗口覆盖单个 phase 的最长时长；调研 pi 是否支持禁用子进程自刷新。**调研结论：关不掉**——0.85.1 的 `--no-refresh` 只挂在 `pi auth check` 上，agent 运行时无条件 `AuthStorage.create()`，只能靠 pi 自己的 `auth.json.lock` 串行化（02 §5.5） | `src/runner/auth-refresh.ts`、`src/runner/auth-lock.ts`、结论写进 02 §5.5 | 调研结论已写进 `docs/design/02` §5.5；**仍开放**：并发跑两张真卡不出 401（要真实 provider，随 MR-38 收） | MR-31 |
| MR-33 | ✅ 拆 Bull Board，队列页改读中央 DB 的可派发集与租约状态 | `src/console/server.ts` | console 无 Redis 依赖；页面显示的可派发集与 DB 一致 | MR-30 |

### MR-E 可观测三环与控制台

| ID | 任务 | 输出物 | 验证方式 | 前置 |
|---|---|---|---|---|
| MR-34 | ✅ **环 0 / 环 1**（04 §5.0–5.1）：先把写分成 **decision（可靠）** 与 **telemetry（可丢）** 两类并在代码里标注准入规则——`cost_entries` 与被执行路径回读的 `event_log` 类型（`epic.transition` / `epic.blocker_answered` / 打回理由 / 状态转移 / 停点）属 decision，**不进可丢 drain**；telemetry 的 `emit()` 改同步入队零 I/O，drain 循环独立 | `src/observability/emit.ts`、`phase-recorder.ts`、`pi-phase-port.ts`、`cost-ledger.ts` | **删除判据（仅 telemetry）**：telemetry emit 换空函数后 typecheck 通过、主流程行为不变，**且费用停点与 Epic 状态推导仍然正确**；**延迟判据** p99 < 1ms；buffer 满丢最老并计数；单测：丢弃全部 telemetry 后 `cost_ceiling_exceeded` 与 Epic BLOCKED 推导不受影响 | — |
| MR-35 | ✅ **环 2**：投影三尺度级联（run→card→fleet）+ nudge 推送 + `schemaVersion` 逃生口；`cost_entries` 的 purpose/tier/provider/billing 取自**本次执行**的 spec 而非启动快照（**它本身是 decision 类写入，不能随投影一起被杀**，04 §5.0；口径逐次切换见 07 §5.2a）；PM 与 DECOMPOSE 挂 canonical-capture | `src/observability/projection/`、`phase-recorder.ts`、`cost-ledger.ts` | **杀进程判据**（杀投影所有卡照常推进，**且费用停点仍按真实花费触发**）；fleet 读 card 成品值不读原始事件；老投影读新事件按 ignorable 计数而不崩 | MR-34, MR-03 |
| MR-36 | ✅ **环 3**：流程 invariant 扩展（04 §5.5 四条）+ 打回理由归一化跨卡排行 + 整卡可读档案 | `src/observability/invariants.ts`、`reject-signature.ts`、`card-dossier.ts` | 同因不同文案归一到同签名；排行按计数降序；**同一张卡重跑两次档案一致**；档案生成失败不挡卡 | MR-35 |
| MR-37 | ⚠️ console 接进常驻进程；写面开 prompt 与模型两族键，工具/skill/mcp 只读（05 §4.3 增补）。**不给它单独的 systemd unit**：控制台的写面改的就是 orchestrator 正在读的那份配置，同进程意味着热更不需要跨进程通知，多一个 unit 只会多一份要对齐的环境和一条会跟主进程各说各话的路径；开关是 `console.enabled`（runbook §4） | `src/console/server.ts`、`scripts/run-local-orchestrator.ts`、`docs/runbooks/linux-single-node.md` | 单测：公网通配绑定被拒；`CONSOLE_READ_ONLY_KEYS` 挡住 `agent.purposeTools/Skills/Mcp` 的写；改 prompt 不发版即生效且 `config.changed` 可回滚。**仍开放**：真实 Linux 主机上部署后内网可达（随 MR-38 收） | MR-33, MR-04 |

### MR-F 验收

| ID | 任务 | 输出物 | 验证方式 | 前置 |
|---|---|---|---|---|
| MR-38 | ⏸ **MR 验收**（也是 IT-13 重写后的那一条端到端判据；判据全文在本行，IT-13 不再自带一份）：一张真实 Story 走完 `SHAPE→DESIGN→SPECIFY→CODE⇄VERIFY→MERGE`，再人为制造一次回归走完 `SPECIFY(narrow)→REGRESSION_FIX` | `docs/poc/mr-acceptance.md` | ① SPECIFY 的红是**断言失败**且三字段匹配 `expected_failure`；② CODE 改测试被 block 并留痕；③ `assertCleanPaths` 真实拦住一次快照漂移；④ SHAPE 的 open_questions 非 blocking 的不挡开工、人回一条后**只重跑 SHAPE** 且 closed 入库；⑤ 人用 Notion 评论走通 rework 与补充 context 两条通道；⑥ 停点详情能区分 `stalled` 与 `budget_exhausted`；⑦ 控制台按 purpose 看到各阶段模型、effort、费用、缓存命中；⑧ 单机并发 ≥2 张卡且无双执行、无 401；⑨ 观测三个解耦判据全过；⑩ 采集的 payload 里同道各阶段 `prompt_cache_key` 相同、跨道不同、无宿主机 skill，跨阶段 `cacheRead` 非零（**长 TTL 字段只在非 codex provider 上验，见 MR-10**），盲审隔离的两处判据全程未触发；⑪ 同机两个子进程抢同一张卡第二个被拒，revoke 后旧实例写状态被拒；⑫ 关掉全部 telemetry 后费用停点与 Epic 状态推导仍正确 | MR-01..37 |
| MR-39 | ⏸ **前缀成本复盘**：用 MR-13 的跨阶段数据回答「六阶段拓扑下每张卡的真实缓存命中率是多少」 | `docs/poc/mr-acceptance.md` 追记 | 产出一份数字，据此决定三件事：`agent.purposeContext` 的 per-purpose 定制是否保留（它与跨阶段共享前缀直接冲突）、`cache.keyScope` 取 `card` 还是 `repo`、是否需要合并某两个相邻阶段 | MR-38 |

### 后续里程碑（MR 不做，理由写在设计里）

- **learning 语料层**（03 §12.3）：计数器去重 + 降序排序 + 注入 SPECIFY prompt。这是唯一能挡弱断言的可移植层，但它需要先有语料。
- **运行中打断**（03 §12.6）：pi RPC `clear_queue`→`abort`，另需定下被中断轮次的账划归属、checkpoint 保留策略、abort 后 worktree 状态。
- **独立观测者服务 / agent**（04 §5.5）：挂在环 3，读事件流抽样发现异常模式。
- **Prompt 工作台完整版**（05 §6）：灰度 + 行为回归对比，仍在 M4。

---

## MS Notion 呈现重做（2026-09-16 增补，排期在 MR 之后）

目标：Notion 是 hivemind 唯一的人机界面，但人打开一张卡读不懂——语言混杂、内部标识外露、区段语义错位、每层复述其他层的状态。重做从「人在这一层做什么决定」倒推三级页面骨架，设计见 01 §2.3 / §8.2。

| ID | 任务 | 输出物 | 验证方式 | 前置 |
|---|---|---|---|---|
| MS-02 | ✅ 审批粒度与验收层级：`decompose.planApproval` 配置项（默认关，Story 立即建）；验收下沉到 Epic（`epic_acceptance_items` 由 `epic_prd_scenarios` 播种、Epic 页 to_do、缺口在本 Epic 下开补交付 Story、全勾 + MR 合并才 DONE）；需求层改为汇总各 Epic 判定；Story 只在真停下时进「等我处理」，看板去掉「待人确认」列 | `src/orchestrator/epic-acceptance.ts`、`acceptance-checklist.ts`、`plan-approval.ts`、`src/notion/board-status.ts`、01 §2.3/§8.2 | `epic-acceptance.test.ts`（播种、勾选一次、缺口开补交付 Story 并回 EXECUTING、重开时已通过的不再问）；`epic-completion.test.ts`（未判定不 DONE）；`plan-approval.test.ts`（开关两态）；`acceptance-checklist.test.ts`（汇总不再等人）；`story-projection.test.ts`（四类停点各出一条 callout，运行中不出） | MS-01 |
| MS-01 | ✅ Notion 呈现重构：角色驱动的需求/Epic/Story 三级骨架（判断方向的信息排在进度之前、每层只维护自己这一层的状态、不等人时页面不出状态 callout）、agent 产中文业务语言 + 出口 lint、显示词表 `src/notion/display-text.json` 收口全部给人看的枚举 | `src/notion/display-text.{json,ts}`、`rich-text.ts`、三层 page builder 与 delivery、`prompts/phases/shape.md` 与 `design.md`、01 §2.3/§8.2 | `notion-write-language.test.ts` 扫三条投影的全部 outbox payload，裸枚举与英文模板即红；三层 delivery 的原位迁移用例（heading/spec/场景块的 blockId 不重建）；`scripts/live-notion-delivery.ts` 对真实需求/Epic/Story 页各跑一轮，每轮恰好一个 toggle、区段各出现一次、callout 唯一 | MR-37 |

---

## MT 流程去脆弱化（2026-09-17 增补，排期在 MS 之后）

目标：需求→Epic→Story 闭环只在真正值得人看的地方停下。live 库里唯一走完全程的 Story 停了 5 次、花 6.8 USD，没有一次是四类真停点想表达的意思：崩溃被当成重试、出口拒绝被当成崩溃、换掉一批失败被当成不收敛、合流复验跑在不含本 Story 的树上并无界打回、停点只给人一个词。逐条根因与决策见 03 §1.5 的 2026-09-17 修订与 §8.3。

| ID | 任务 | 输出物 | 验证方式 | 前置 |
|---|---|---|---|---|
| MT-01 | ✅ 收敛判据放宽为「不得重复」+ 内环预算收紧为 3 + 停点拆分（重复停 `verify_loop_exceeded`、预算耗尽停 `retry_limit_exceeded`，详情带 `convergence`/`spent`/`budget`） | `src/pipeline/convergence.ts`、`story-worker.ts`、`config/registry.ts`、03 §1.5、AGENTS.md | `convergence.test.ts`（持平/震荡停、换一批失败续跑）；`story-worker.test.ts`（换失败三轮后 DELIVERED；集合一直变到第三轮停 `retry_limit_exceeded budget_exhausted`） | M1-25 |
| MT-02 | ✅ 派发失败入账：子进程崩溃写 `story.dispatch_failed`（带脱敏错误文案与类别），`phase_reentries` 改为按 phase 计、系统性前进即清零 | `src/orchestrator/dispatch-failure.ts`、`story-execution-store.ts`、`state-machine.ts`、`scripts/run-local-orchestrator.ts` | `dispatch-failure.test.ts`（决策表 + 事件与脱敏）；`story-execution-store.test.ts`（前进清零、打回保留） | MT-01 |
| MT-03 | ✅ 合流复验跑在 rebase 后的 Story 树上 + `when` 相关性筛选 + 失败测试名提取 + 三类归因（story_regression / baseline_failing / environment） | `src/vcs/merge-flow.ts`、`subset-verifier.ts`、`check-failures.ts`、`pipeline/code-exit-gate.ts`、`scripts/run-story.ts` | `merge-flow.test.ts`（verifier 在 rebase 之后、ff 之前，candidate 是 story worktree）；`subset-verifier.test.ts`（base 仅失败时重跑、三类归因、不相关检查跳过）；`check-failures.test.ts`（真实载荷 fixture 恰得失败测试名） | MT-01 |
| MT-04 | ✅ 归因到 Story 的合流打回走状态机并消耗一轮：`story.transition` + `spent` 事件，预算由 `getInnerLoopSpend` 统一口径；打回原因把失败测试名排在最前喂给 CODE | `story-execution-store.ts`、`story-worker.ts`、`pipeline/phase-input.ts` | `story-worker.test.ts`（打回计一轮、到限停在 CODE）；`phase-input.test.ts`（`[rejected:MERGE]` 以测试名开头） | MT-03 |
| MT-05 | ✅ Epic 头自身红：Story 留在 MERGE 不消耗轮次，Epic 转 BLOCKED 写明失败测试，头修好后自动恢复 | `src/orchestrator/epic-integration.ts`、`epic-escalation.ts`、`epic-head-recheck.ts`、`vcs/epic-branch-refresh.ts`、03 §8.3/§11 | `epic-integration.test.ts`、`epic-head-recheck.test.ts`、`epic-escalation.test.ts`（head failing 不可被"回答"）、smoke 的 baseline-failing 段 | MT-03 |
| MT-06 | ✅ 停点汇总落库 + 停点钩子：`stories.stop_summary` 跨轮聚合（逐轮失败、合流打回、崩溃、费用、诊断、下一步），`StoryStopSink` 分发给告警与 friction，Story 页四类停点都附汇总 | `src/orchestrator/stop-summary.ts`、`story-stop-sink.ts`、`story-execution-store.ts`、`src/notion/story-projection.ts`、`display-text.json` | `stop-summary.test.ts`、`story-stop-sink.test.ts`、`story-projection.test.ts`、`notion-write-language.test.ts` | MT-04 |
| MT-07 | ✅ SPECIFY 出口拒绝改为会话内回喂（通用 `PhaseExitGate`，与 CODE 出口同构），耗尽 `specifyExit.maxRounds` 才算一次重入并记 friction | `src/orchestrator/story-worker.ts`、`src/orchestrator/pi-phase-port.ts`、`config/registry.ts` | `pi-phase-port.test.ts`（一次拒绝后通过 → 两次 prompt）；`story-worker.test.ts`（超限才失败） | MT-02 |
| MT-08 | ✅ 仓库注册表 + 多仓派发：只凭 git clone URL 自举，`repositories` 表 + `ensureCheckout` + 需求看板「目标仓库」+ 逐仓派发，删掉 `--repository-path/--repository-id` 硬编码 | `src/vcs/repository-checkout.ts`、`repository-registry.ts`、`src/orchestrator/repository-dispatch.ts`、`scripts/repository-add.ts`、`run-local-orchestrator.ts`、`run-requirement-loop.ts`、`preflight.ts`、`deploy/linux/install.sh`、runbook | `repository-checkout.test.ts`（slug 推导与拒绝、假 git 下 clone/fetch/竞态、一条真 git）；`repository-registry.test.ts`；`repository-dispatch.test.ts`（只派已注册仓、双仓首批各一）；`requirement-intake.test.ts`（未注册则 skip 不入库） | MT-02 |

---

## MU 方案关与界面契约（2026-09-17 增补，排期在 MT 之后）

目标：让"这事该用什么技术做""这一版界面长什么样"有一层能决定。实测形状：一条 web 后台需求拆出的 14 张卡里 10 张指向同一个不存在的前端目录，第一张进 CODE 的卡自造了一套无构建工具、`.js` 与 `.ts` 同名并存的骨架，第二张卡准备在另一条 Epic 分支上再造一次；全链路没有一处描述界面，唯一碰界面的 UI 走查永不否决。设计见 08，修订 03 §7.1 与 §9.2。2026-09-18 增补 MU-07 ～ MU-10：原型在产出当场用有限判据管住"满足需求"与"好用"，审美只做一次仓库级人选（08 §3.1–3.3）。

| ID | 任务 | 输出物 | 验证方式 | 前置 |
|---|---|---|---|---|
| MU-01 | ✅ 需求状态机加 `SOLUTION`（PRD 确认之后、拆解之前）+ `requirement_solutions` revision 表 + SOLUTION phase 与 prompt（大脑档）+ 确定性停人条件（`stackChanges` / `openDecisions` / 界面三者任一非空即必须人批，自动通过记 `source=auto`）+ 方案注入需求拆解 + 人批手势（看板「方案待确认」列、拖列与评论两条路） | `src/orchestrator/requirement-solution.ts`、`solution-runner.ts`、`requirement-machine.ts`、`requirement-store.ts`、`pi-pm-port.ts`、`prompts/pm/solution.md`、`src/notion/{intent-interpreter,requirement-input-sync,requirement-projection,bootstrap,notion-schema.json,display-text.json}`、`0001_init.sql`、`schema.ts`、08 §2 | `requirement-solution.test.ts`（引栈无备选/无门禁即拒、非中文摘要即拒、无验证道的平台即拒、三类触发各自报出原因）；`solution-runner.test.ts`（无决策自动通过并落 `auto` 确认、引栈停到人批、提问同样停、改写带上人的话、连续不可用停人）；`requirement-machine.test.ts`（PRD 不再能直接进拆解）；`intent-interpreter.test.ts` / `requirement-input-sync.test.ts`（拖列与评论两条确认路径）；`pi-pm-port.test.ts`（方案会问仓库、页面清单进拆解 prompt）；`bootstrap.test.ts`（新列只增不删） | MT-01 |
| MU-02 | ✅ 界面契约三件套的**读法与用法**：`docs/prototype/` 的 `tokens.json`（W3C design-tokens，按名扁平排序注入）+ `components.md` + 可运行页面原型（页面名与用途取自 `<title>` 与 `<meta name="description">`）；半成品契约整份不注入；四态（电脑/手机 × 明/暗）截图由本机 playwright CLI 直接对 `file://` 页面拍，不经模型 | `src/pipeline/interface-contract.ts`（放 pipeline 而非 orchestrator：注入属于 prompt 组装层，pipeline 不反向依赖 orchestrator）、`src/verify/prototype-screenshots.ts`、`src/pipeline/phase-input.ts`、`src/orchestrator/story-worker.ts`、`scripts/run-story.ts`、`config/registry.ts`（`prototype.root`）、`prompts/pm/solution.md` | `interface-contract.test.ts`（$type 继承、无类型即拒、缺项逐条报、重排与重排版后注入逐字节不变）；`prototype-screenshots.test.ts`（页×态全覆盖、渲染不出来只报告不失败）；`phase-input.test.ts`（契约排在本轮任务之前、无契约即整段不出现）；真实跑了一次四态截图 | MU-01 |
| MU-02b | ✅ 谁来写这三件套：需求层加 `PROTOTYPE` 档（PM 第六个 phase），紧跟 SOLUTION 草稿之后、人读之前跑，仅 `interface` 非空且有目标仓库时跑；guard 把写权限围在 `prototype.root` 之内（`prototypeFencePatterns` 两条），产出以 `prototype/<需求 id>` 分支的 PR 进目标仓库，人确认方案时一并确认；画不成就停在 SOLUTION 等人，不让方案单独走下去 | `src/orchestrator/prototype-runner.ts`、`pi-prototype-port.ts`、`src/guard/prototype-fence.ts`、`src/vcs/prototype-delivery.ts`、`requirement_prototypes` 表与 `saveSolutionPrototype`/`getSolutionPrototype`、`solution-runner.ts`、`prompts/pm/prototype.md`、`scripts/run-requirement-loop.ts`、08 §3.1–3.2 | `prototype-runner.test.ts`（无界面/无仓库不跑、按 revision 存、重画覆盖、画不成即停）；`pi-prototype-port.test.ts`（会话内回喂、轮次用尽即拒、围栏生效）；`prototype-fence.test.ts`；`prototype-delivery.test.ts`；`solution-runner.test.ts`（三条） | MU-02, MC-03 |
| MU-03 | ✅（逐页四态改为折叠里的文字说明，原因见下） Notion 方案区段：怎么做 / 这一版界面长什么样 / 要动的依赖 / 页面清单与原型 / 画原型时发现的问题 / 待定分叉 to_do / 确认 to_do（两类意图与看板新列已随 MU-01 落地，这一片补页面呈现与勾选回读） | `src/notion/blocks/requirement-page.ts`（`DesiredSolution` / `solutionBlocks`）、`requirement-page-delivery.ts`、`requirement-projection.ts`、`requirement-input-sync.ts`（`pollContent`）、`display-text.json`、`rich-text.ts`、`0001_init.sql`（section 与 source 两处 CHECK）、`pi-prototype-port.ts` / `prototype-runner.ts`（`described`：页名取自页面自己的 `<title>`，不取模型的答案） | `notion-write-language.test.ts`（方案区段全字段进扫描）；`requirement-input-sync.test.ts`（勾完待定才算确认、只勾底下那条不算、旧稿的勾不读）；`requirement-page-delivery.test.ts`（整段呈现、重发不动 blockId、确认后换成一句话且标题 id 不变）；`blocks/requirement-page.test.ts`（同稿不改、改稿整段重写、未起草时留空） | MU-01 |
| MU-04 | ✅ 反向兜底：SHAPE 冻结 DoD 后，若含 `ui`/`e2e` 场景而分支上没有界面契约，卡停 `blocking_question` 并记 friction `interface_contract_missing`（不走出口回喂：再写一遍 DoD 也放不进一张 token 表，这是需求层的决定）；CODE 出口拒绝卡自行改依赖清单（`codeExit.dependencyManifests`，不含 lock 文件）；界面契约在目标分支不存在时本轮只派一张卡（`planStoryExecution` 的 `maxPerBatch`） | `src/orchestrator/story-worker.ts`、`src/pipeline/dod.ts`（`renderMissingInterfaceContract`）、`pipeline/code-exit-gate.ts`、`config/registry.ts`、`orchestrator/scheduler.ts`、`repository-dispatch.ts`、`scripts/run-local-orchestrator.ts` | `story-worker.test.ts`（无契约即停并记 friction、有契约照常交付）；`code-exit-gate.test.ts`（改 package.json 即拒、没改即无事）；`repository-dispatch.test.ts`（无契约的仓库本轮只派一张，不影响另一个仓库） | MU-02 |
| MU-05 | ✅ VERIFY 结构层判据：SHAPE 为 `ui`/`e2e` 场景产出 `visible[]` 落 `story_specs.visible_json`；VERIFY 后由代码读 aria 快照断言，缺一条即该场景 failed；断言函数与原型档出口共用（MU-07） | `prompts/phases/shape.md`、`src/verify/snapshot-assert.ts`、`0001_init.sql` | `snapshot-assert.test.ts`（以本次真实证据的 404 快照与第二轮页面快照为 fixture，前者必须 fail、后者必须 pass） | MU-02 |
| MU-06 | ✅ VERIFY 契约层判据：走查跑完后由代码重开本轮到达过的页面，`page.evaluate()` 抽计算样式与 token 表比对（值而非来源，两边归一，长度按页面自己的根字号折算）；`uiContract.enforce` 三态（off/warn/block），默认 warn。**组件清单检查移到 MU-07**：`components.md` 今天是自由文本，“只用了清单里的组件”要先定一个页面怎么声明自己用了哪个组件的约定，而那个约定只有在真正产出原型的那一片里定才有人遵守；现在加就是一条没有生产者、恒不触发的规则 | `src/verify/ui-contract.ts`、`src/verify/ui-contract-collector.ts`、`src/orchestrator/ui-reviewed-verify-port.ts`、`scripts/run-story.ts`、`config/registry.ts`、03 §9.2 | `ui-contract.test.ts`（token 内/外值、别名与 rem 折算、同一决定只一条 finding）；`ui-contract-collector.test.ts`（file URL、打不开的页面不算干净、顺序稳定）；`ui-reviewed-verify-port.test.ts`（三态：off 不跑 / warn 只记 friction / block 进 failed 集合）；一条真实需求跑完后再决定是否置 block | MU-05 |
| MU-07 | ✅ 原型出口·确定性部分（08 §3.2 前三行）：页面声称承接的场景与 `visible[]` 必须真在 aria 快照里（跑 MU-05 的断言）；每页能以 `?state=` 切 empty/loading/error/waiting 四态，渲染不出或四态雷同即缺；计算样式只许来自 `tokens.json`（复用 MU-06，原型侧恒为 block）；场景覆盖与页面存在性一并判。三条都能否决，用尽 `prototype.maxRounds` 即 fail，需求留在 SOLUTION 等人 | `src/verify/prototype-exit.ts`、`src/verify/prototype-inspector.ts`、`src/verify/ui-contract-collector.ts`（改为只判页面声明过的值）、`scripts/smoke-prototype-exit.ts` | `prototype-exit.test.ts`（11 条）；`prototype-inspector.test.ts`（5 条）；`npx tsx scripts/smoke-prototype-exit.ts`：真实 Chromium 下一页干净无 finding、一页写死色值与缺声称内容被逐条拒 | MU-02b, MU-05, MU-06 |
| MU-08 | ✅ axe-core 进契约层：原型出口与 VERIFY 共用一份跑法（`axeRunExpression`，把 axe 自带的 source 注进页面，目标仓库不必装它），`serious` / `critical` 记违例；原型侧恒为 block，VERIFY 侧随 `uiContract.enforce` 三态走 | `src/verify/accessibility-audit.ts`、`prototype-inspector.ts`、`prototype-exit.ts`、`ui-contract-collector.ts`（`audit` 可选方法）、`orchestrator/ui-reviewed-verify-port.ts`、`package.json`（axe-core 4.13，MPL-2.0） | `accessibility-audit.test.ts`（两档否决、低两档不否决、表达式是一次调用）；`prototype-exit.test.ts`（critical 否决、moderate 放行）；`ui-reviewed-verify-port.test.ts`（block 时进 failed 集合）；`smoke-prototype-exit.ts`：真实 Chromium 下抄到一条 color-contrast | MU-07 |
| MU-09 | 部分✅（方向、理由层、检测器已落；多方向供人勾选随 MU-03 一起做，理由见下行）审美一次仓库级决定（08 §3.3）：`interface.direction {summary, alternatives[]}` 进 SOLUTION 产出与停人逻辑；目标仓库尚无契约时原型档对同一页画 `prototype.directionVariants`（默认 3）个方向并截图，Notion 方案区段并排供人只勾一个，选中结果落 `requirement_acceptance_items`；`design.md` 理由层（DESIGN.md 九节骨架：视觉主题与界面类型/色板与角色/字体规则/组件样式/布局原则/层级与深度/该做与不该做/响应式/给后续卡的提示）整篇注入，引用不存在的 token 名即整份契约不注入；原型档 prompt 加反均值禁用清单与"大胆花在一处"原则，机械可判的部分接 impeccable 独立检测引擎（`impeccable detect --json --no-config` 文件模式，Apache 2.0；pin engine 版本线 `hivemind.impeccableEngineVersion`，`install.sh` 从 release 取 linux 二进制并校 sha256、不走 npm 启动器与首次运行下载，`preflight` 探可执行且版本等于 pin）作 warn 级：读 `--json`、忽略退出码 2、finding 全记 friction，退出码 1 只报告；§3.1 自批结论同样只记 friction | `prompts/pm/{solution,prototype}.md`、`src/verify/design-lint.ts`（检测器封装）、`deploy/linux/install.sh`、`scripts/preflight.ts`、`package.json`、`requirement-solution.ts`（`direction` schema）、`prototype-runner.ts`、`src/pipeline/interface-contract.ts`（`design.md` 解析与 token 名校验）、`src/notion/blocks/requirement-page.ts`、`requirement-input-sync.ts`、`display-text.json` | `requirement-solution.test.ts`（`interface` 非空而无 `direction` 即拒、无备选即拒）；`interface-contract.test.ts`（`design.md` 引未知 token 即缺项、重排后注入逐字节不变）；`prototype-runner.test.ts`（无契约仓库出 N 个方向、已有契约跳过）；`design-lint.test.ts`（退出码 2 记 friction 不否决、退出码 1 只报告、版本不等于 pin 即探针红、字面版本号不出现在仓库任何 shell 或 ts 里）；`requirement-input-sync.test.ts`（勾第二个方向时前一个自动取消） | MU-03, MU-07 |
| MU-10 | ✅ 可用性清单 gate，先分流（08 §3.2）：机械条目（`prefers-reduced-motion`、触控目标尺寸、焦点可见、键盘可操作）归代码与 axe-core，能否决、用尽即 fail；语义条目（状态文案是否说清发生了什么与该做什么、校验提示是否可操作、标签是否描述旁边那个控件）由判官模型逐条二值判定，输入是剥掉注释与 `<script>` 的原型 HTML + MU-07 采的 aria 快照，**不是截图**；finding 以条目编号为键、不引编号即丢弃；同一条目连续两轮翻转记 friction `ui_checklist_unstable`；能否决，用尽 `solution.maxRounds` 即 `ship`。判官走 `src/judge/`：每条语义条目地板为"未见问题"，判官只能加 finding、不能动机械条目的结论，不可用即地板（AGENTS.md 判官不变量）；阈值单独一键 `judge.usabilityThreshold`、保守方向是高（加 finding 即打回），不与 `judge.environmentThreshold` 共用；三条**一条一个请求**（批次效应实测摆幅 0.29）；中文比英文约低 0.1，阈值留余量，上线前在真实中文原型样本上单问实测 | `prompts/pm/ui-checklist.md`、`prototype-runner.ts`、`src/pipeline/ui-checklist.ts`（条目解析、编号校验、HTML 剥注释）、`src/verify/usability-mechanical.ts`、`src/judge/usability.ts`（三条语义问题的 Noul 定义与地板） | `ui-checklist.test.ts`（无编号的 finding 被丢弃、引清单外编号被丢弃、注释里的自夸文本不进判官输入、每条条目独立一次判官调用、条目翻转记 friction、判官不可用即 ship）；`usability-mechanical.test.ts`（每条机械条目红绿各一例） | MU-07, MU-08 |

---


MU-09 拆开的那一项（2026-09-18，MU-03 做完后复核）：“仓库首次建立契约时对同一页画 `prototype.directionVariants` 个方向、人在 Notion 方案区段里只勾一个”**继续挂着，卡在能不能把图放上页面**：
并排比较是这件事的全部价值，而 hivemind 的 Notion gateway 只发 JSON，没有 multipart 上传通道，`file_upload` 没接；不上传就只能给 N 条链接，人要在几个标签页之间来回切着比——那不是并排，付了三倍原型成本却拿不到那个决定。
同一条也解释 MU-03 为什么没做逐页四态截图：`prototype-screenshots.ts` 拍的 PNG 落在本机 evidence 目录，Notion 拿不到。方案区段的逐页折叠里放的是这页承接哪些场景、必须看得见什么、四态怎么在原型里切，图仍然在合并请求里点开看。
要解掉这条，先给 gateway 补 `POST /v1/file_uploads` 与 multipart 发送，之后并排方向与四态截图是同一条路上的两件事。
`interface.direction` 已经让方向变成一个被写下来、被人批的决定，这是这一节的主体；多方向只是把“描述题”换成“选择题”的那一步。

原型阶段的写入围栏暂时摘掉（2026-09-18，Ryan）：主流程还没跑通，先不拿权限挡路。它是一条作用域规则而不是安全规则——
画原型的会话在自己的 worktree、自己的分支上，写出来的东西进的是一个没人合的评审；而它第一次真跑，
把轮次花在被拒绝 `ls` 它自己要填的那个目录上。`src/guard/prototype-fence.ts` 与它的测试都留着，
装回去就是 `pi-prototype-port.ts` 里的一个参数。

## MC 特殊化收敛（2026-09-18 增补，排期在 MU-02 与 MU-03 之间）

目标：在继续往流程上加东西之前，先把已经长出来的特例收回主路径。三处都是"同一件事有多套实现"，而不是"这件事需要例外"——真正的例外（UI 走查不能否决、大脑档反着排成本序、订阅不挂 spend）有理由、写在 AGENTS.md 里，不在此列。纯重构：不改对外行为，不动 schema。

| ID | 任务 | 输出物 | 验证方式 | 前置 |
|---|---|---|---|---|
| MC-01 | ✅ 出口检查收敛成一套机制：`evaluate → findings 回喂同一 session → 重解析` 只实现一次，每个 phase 的出口由一张表声明（CODE 的确定性出口、MERGE 的交付报告、DESIGN 的设计摘要由端口内置；SPECIFY 的测试契约、SHAPE 的 DoD 由调用方传入）。逐 gate 声明 `exhausted: fail / ship`，取代此前"有的抛错、有的照发"的隐含差别；SHAPE 的 DoD 语言检查从"换一个 session 重跑"改成会话内回喂，端口不执行时仍单判一次 | `src/orchestrator/pi-phase-port.ts`（`builtInGates` / `runExitGates`，删去 `enforceCodeExit`/`enforceExitGate`/`rewriteUntilReadable` 三份循环）、`story-worker.ts`（`PhaseExitGate` 加 `name`/`exhausted`/`failure`，`exitGates` 复数，`dodGate`） | `pi-phase-port.test.ts`（多 gate 按序执行并各自计数、无否决权的 gate 用尽即照发、有否决权的抛 `PhaseExitNotMetError`、CODE 仍抛 `CodeExitNotMetError`）；`story-worker.test.ts`（英文 DoD 仍被退回并记 friction、SPECIFY 会话内改写不耗 phase run） | MU-02 |
| MC-02 | ✅ Epic 层状态迁移收敛：`assertEpicTransition` 目前全部传字面量常量（断言恒真），真正的守卫是散在 7 个模块里的 `UPDATE ... WHERE state = ?`；`regression/attribution-runner.ts` 直接改 `state`/`phase` 且无断言。改为统一经 `epicTransitionStatement` / `storyTransitionStatement` 生成带 CAS 守卫的语句：声明的边与行守卫由同一对状态生成，不可能分叉；返回语句而非直接写库，因为迁移要和它的事件与看板投影同一 batch 落地 | `src/orchestrator/state-machine.ts`、`epic-{escalation,completion,acceptance,blocker}.ts`、`plan-approval.ts`、`decompose-runner.ts`、`story-execution-store.ts`、`regression/attribution-runner.ts` | `state-machine.test.ts`（守卫状态与声明一致、未声明的边构造即抛、随行列与附加条件的参数序）；全仓已无裸 `UPDATE epics/stories SET state` | MC-01 |
| MC-03 | ✅ 需求层收敛：`prd`/`solution` 两个 runner 的「起草→等人→改写→连续不可用就停」结构提成一份；各自硬编码的 `const MAX_ATTEMPTS = 2` 改为配置（与 Story 道的 `retry.*` 同一处口径）；缺的对等物（无 `phase_runs`、无 checkpoint/崩溃恢复、不进费用上限）在 08 §7 写明为何是选择而不是欠债，并写清它们共同的前提「这一层没有内环」 | `src/orchestrator/requirement-draft.ts`（新）、`{prd,solution}-runner.ts`、`config/registry.ts`（`requirement.maxDraftAttempts`）、`scripts/run-requirement-loop.ts`、08 §7 | 两个 runner 的既有测试全绿；新增"预算由配置决定、且每次重写都带上上一次被拒的原因"一条 | MC-02 |

## MJ 结构化判官（2026-09-18 增补，排期与 MU 并行）

目标：把几处"语义判断伪装成正则表"的地方交给一个只回类型化判断的判官，而**不动任何一张表**。判官是 pi 之外的第二条模型路径（`src/judge/`），只回 Noul / Choice / Score，不生成文本、不进 failover chain、不计费用上限。规矩写在 AGENTS.md：每个问它的问题都必须先有一个确定性答案，判官不可用、超时、不确定一律等于没意见，所以它永远只能加、不能把地板已经判定的东西拿走；移动方向由两个误判的代价决定，不由准确率决定。默认关（`judge.enabled`），开了而缺凭据要在启动时说出来。

| ID | 任务 | 输出物 | 验证方式 | 前置 |
|---|---|---|---|---|
| MJ-01 | ✅ 环境/代码归因单向补漏：`failure-classification.ts` 的模式表命中即环境（一行不改，且这类理由根本不送判官），只有表没命中的拒绝理由才问判官，高于 `judge.environmentThreshold` 才移出代码侧。两条道各接一次——功能道在 `BlindVerifyExecutor` 判一次并把结论带出，`blind-verify-port` 复用而不二次判；走查道自己判一次。移走的每条记 friction | `src/judge/{system-one,environment-reasons,settings}.ts`（新）、`pipeline/failure-classification.ts`（`splitScenarioFailures` 加只增不减的第三参）、`verify/executor.ts`、`orchestrator/{blind-verify-port,ui-reviewed-verify-port}.ts`、`config/registry.ts`（`judge.*` 五键）、`scripts/run-story.ts`、03 §8.6、AGENTS.md | `environment-reasons.test.ts`（表命中的理由永不送出、只问漏掉的、够确信才移、判官不可用即空集合、同一轮两次跑出同一份请求字节、超出单次容量的保留地板答案）；`system-one.test.ts`（请求形状与鉴权头、非法概率判 contract 而不静默当 0、四类错误分档、超时）；`settings.test.ts`（三态启动、缺凭据要说出来、操作者读到的那行不含凭据）；`failure-classification.test.ts`（无第三参时与从前逐字节同解） | — |
| MJ-02 | ✅ 真实往返验收，结论改了两处实现：① **一条理由一个请求**——实测同一句理由的概率随同批内容摆动 0.29（固定输入重跑只差 0.02），批量问会让归因取决于这一轮还有哪些兄弟场景失败；② **阈值 0.85 → 0.7**，由十五条真实理由逐条单问实测定（代码类 0.03–0.05、环境类 0.80–0.95），并留出中文比英文低约 0.1 的余量。采了两条真实往返进 `fixtures/judge/`，preflight 加判官探针（凭据 FAIL / 校准 WARN），`judge.enabled` 已置 true | `src/judge/environment-reasons.ts`（单问并发、一条失败不拖垮整轮）、`fixtures/judge/environment-reasons.json`、`scripts/preflight.ts`、`config/registry.ts`（阈值定值）、03 §8.6 | 真实往返 15/15 落在该落的一侧；批量敏感度与重跑噪声实测对照；`system-one.test.ts` 以采集到的两条真实响应为 fixture 断言解析与阈值两侧；preflight 实跑 `PASS structured judge` + `PASS 0.82 against a 0.7 threshold` | MJ-01 |
| MJ-03 | ✅ Notion 批准意图：`approved()` 四条整串相等的失败方式不是报错而是改写——「批准。」带句号即落进 `request_revision`，PRD 被当成"你要求改"重写一版；Epic 侧不匹配落到 `feedback`，也就是沉默，Epic 继续等而没有一处说明在等什么。加一条 **Noul 而不是 Choice**：Choice 等于让判官也去选"要求修改"还是"反馈"，那是把答案往地板**之上**移；白名单是地板、判官只许往"是批准"这一个方向加、门槛 0.8 由实测定。白名单已认出的措辞不送判官。不落库：评论无论被读成批准还是修改都当场 claim，同一条不会被判第二次，且这条结论永不进 prompt，`assemblePhasePrompt` 的确定性不受影响 | `src/judge/approval-intent.ts`（新）、`notion/intent-interpreter.ts`（两个解释器各加一个只增不减的第三参）、`notion/{requirement,epic}-input-sync.ts`、`orchestrator/requirement-store.ts`（`recordFriction`）、`config/registry.ts`（`judge.approvalThreshold`）、`judge/settings.ts`（两个问题各自的阈值走各自的 setup）、`scripts/{preflight,run-local-orchestrator,run-requirement-loop}.ts`、`fixtures/judge/approval-comments.json`、01 §4.2.1 | `approval-intent.test.ts`（一条评论一个请求、同批内容不改变单条提问、够确信才移、判官不可用即空集合、超出单次容量的保留白名单答案；采集的五条真实往返断言问题措辞未漂移且全部落在 0.8 两侧）；`intent-interpreter.test.ts`（白名单原样通过、判官背书的措辞被读成批准、没背书的照旧落"要求修改"、无第三参时与从前同解、非 PLAN_APPROVAL 的 Epic 永不被读成批准）；`{requirement,epic}-input-sync.test.ts`（白名单已认出的永不送出、判官背书即确认并记 friction、判官不确信即维持今天的重写/继续等）；preflight 实跑 `PASS 0.94 against a 0.8 threshold` | MJ-02 |
| MJ-04 | ✅ 拆解语言判据：17 词表判的是**词**不是意思，「引入缓存层以降低响应延迟」零命中即照原样上板。加一条 Noul「这句说的是用户能做什么，还是系统内部怎么实现」，**只补漏判**：表命中的照旧拒且不送判官，只有表放行的句子才问，判官说是实现句才追加一条拒绝理由。阈值 0.75 偏高一侧，因为两种错代价不等——漏判只是今天的行为，凭空拒一条则可能让 Epic BLOCKED（`MAX_ATTEMPTS` 只有 2）。判官接在 `EpicDecomposer` 的 accepted 分支之后而不是塞进 `evaluateDecomposition`：后者是纯同步函数，全系统都靠它保持这样。拒绝理由并入 `previousRejections` 喂给下一次 attempt，不落库，所以没有任何 prompt 会从判官答案重建。**表的另一半误判（正当技术名词被误拒 → Epic BLOCKED）本条不修**：那要判官去拿走地板的结论，破坏「只许加」的不变量；criteria 里明写"产品本身就是技术的"不算实现句，保证这一条至少不被拒第二次 | `src/judge/business-language.ts`（新）、`orchestrator/decompose-runner.ts`、`judge/settings.ts`、`config/registry.ts`（`judge.businessLanguageThreshold`）、`scripts/{preflight,run-local-orchestrator}.ts`、`fixtures/judge/decomposition-lines.json` | `business-language.test.ts`（表命中的永不送出、表漏掉的被拒、不确信即不加、一句一个请求、同批内容不改变单句提问、重复句只问一次、超容量保留表的答案；采集的六条真实往返断言问题措辞未漂移、全部落在 0.75 两侧、且"产品本身是技术的"那条没被拒）；`decompose-runner.test.ts`（判官拒 → 下一次 attempt 的 `previousRejections` 带上理由 + 记 friction；判官无异议 → 照常 present 且每句只问一次；无判官 → 与今天逐字节同解）；preflight 实跑 `PASS refused one and passed one against a 0.75 threshold` | MJ-02 |
| MJ-05 | ✅ 垂直切片判据：`userEntryPoint` / `verificationPath` 只判非空，「费用数据的存放位置」既非空又互不相同，于是六张各建一层的卡过了全部确定性检查而没有一张能独立交付。加一条 Noul，地板是现有非空检查 + `horizontalCuts`，只补拒绝。**问题措辞是量出来的，两版被丢掉**：问「是不是只完成了一部分」把「页面骨架」判成 0.22（比真切片还低——骨架确实是一个能打开的页面）；问「一个人是不是还是什么都用不上」让同一批 Story 摆动 0.54（重跑噪声 0.03）且仍不可分。**真正能分开的支点不是这张卡碰了什么，而是谁会给它起名**：客户给自己要做的事起名，团队给自己要走的步骤起名。十五条跑两轮，团队的步骤 0.54–0.91、人做的事 0.07–0.15，含两个最易搞错的（用公司账号登录、产品的客户本身是开发者）。阈值 0.6 在硬币线之上而不是缝底，因此「纯接口卡」（0.54–0.59，判官自己也不确定）只是偶尔被抓到——那是便宜的一侧 | `src/judge/vertical-slice.ts`（新）、`orchestrator/decompose-runner.ts`（判官接线收进 `DecomposeJudgement` 一个对象）、`judge/settings.ts`、`config/registry.ts`（`judge.verticalSliceThreshold`）、`scripts/{preflight,run-local-orchestrator}.ts`、`fixtures/judge/decomposition-slices.json`、03 §8.8 | `vertical-slice.test.ts`（一卡一个请求、同批兄弟卡不改变单卡提问、按 id 定序、只送人会读的字段、不确信即不加、判官不可用即空、超容量保留地板答案；采集的六条真实往返断言问题措辞未漂移、该拒的拒该放的放、**人做的事一条都不许被拒**、borderline 那条明确留给人）；`decompose-runner.test.ts`（判官拒 → 下一次 attempt 带上「Re-split the Epic」+ 记 friction）；preflight 实跑 `PASS refused one and passed one against a 0.6 threshold` | MJ-04 |
| MJ-06 | ✅ 给人读的那一句的语义层：`lintHumanSentence` 判 CJK 占比 + 六条正则，拦得住"看起来技术"的句子，拦不住"全中文写的实现过程"——「本次改动把缓存层抽出来，复用到三个调用点」100% 中文、无路径无代码块，正好是这条规则要挡的东西。**复用 MJ-04 那一道问题**（同一个问题、同一份采集、已校准），按句问，地板是 `lintHumanSentence` 本身：它有意见的句子不送判官。**只挂在 `exhausted: "ship"` 的两道 gate 上**（DESIGN 设计摘要、MERGE 交付报告），所以概率判断永远停不住一张卡——这也是它敢跑在散文上的唯一理由：一条关于"读起来怎么样"的判据，若有东西依赖它就永远收敛不了。阈值 0.6 **低于** MJ-04 的 0.75，因为代价不同：这里凭空加一条只多一次重写然后照发，拆解那边同样的错会停掉 Epic。实测十二条报告句跑两轮：实现散文 0.84–0.97，必须留下的 0.04–0.18，而**确定性 linter 对这十二条一条都没意见** | `src/judge/human-sentence.ts`（新）、`orchestrator/pi-phase-port.ts`（`readabilityGate` 加语义半边 + `readabilityJudge` 选项）、`judge/settings.ts`、`config/registry.ts`（`judge.readabilityThreshold`）、`scripts/{preflight,run-story}.ts` | `human-sentence.test.ts`（linter 已有意见的句子永不送出、全中文实现散文被找出、不确信即不加、按句拆、标题与短标签不问、重复句只问一次、判官不可用即空且不抛、超容量保留 linter 的答案）；`pi-phase-port.test.ts`（判官加的 finding 触发重写，用尽轮次仍照发——概率永远停不住卡）；preflight 实跑 `PASS flagged one and kept one against a 0.6 threshold` | MJ-04 |

排除在外、且理由写在 AGENTS.md 或设计里：`classify` 的错误分类（UNKNOWN fail closed 是安全性质，概率化是降级）、`guard/` 的危险规则与 VERIFY 导航白名单、收敛判据本身（集合比较，本来就精确）、`extractCheckFailures` 与 `failureSignature`（读的是机器自己的输出格式，正则对就是对）、Story 评论的 `rework:` / `defect:` 标记（显式标记是刻意设计，不是脆弱白名单）、界面观感层（判的是运行中应用的截图，判官只收文本）。

## M3 多机化

目标：capability 队列 + 派单信封 + 心跳失联两段式 + Mac mini 浏览器 e2e worker 接入。

| ID | 任务 | 输出物 | 验证方式 | 前置 |
|---|---|---|---|---|
| M3-01 | capability 路由：cap.web / cap.browser-e2e / cap.windows；路由键 = 卡能力集合中最稀缺能力；无存活 worker 具备该能力 → 能力真空告警。**2026-09-14：承载从 BullMQ 队列改为 `stories.capabilities` 上的可派发集过滤**（MR-30），路由纯函数本身不变 | `src/queue/routing.ts` | 路由纯函数单测；停掉对应 worker 触发真空告警而非卡沉底 | M2-14 |
| M3-02 | ~~派单信封模式：cap.* job 只是信封，worker 领单 → 中央 DB 落卡级租约 → ack 完成 job~~ **被 MR-30 取代**（2026-09-14）：BullMQ 撤销后没有信封这一层，worker 直接从 DB 领单并落租约。条目保留是因为它的**验证判据仍然有效且必须在 MR-30 复现**——防双执行的始终是租约 CAS，不是队列语义 | ~~`src/queue/envelope.ts`~~ → `src/queue/dispatch.ts` | 判据迁移到 MR-30：两个领取者抢同一张卡，第二个被 CAS 拒绝，**不产生双执行** | M1-04, M3-01 |
| M3-03 | ~~jobId 幂等规则：`task-<cardId>[-r<N>][-c<M>]` + removeOnComplete:true~~ **随 BullMQ 一并撤销**（2026-09-14）：这三个坑（jobId 幂等 / requeue / removeOnComplete）是 BullMQ 特有的，不引入就不存在。保留条目是为了记住**撤销的是坑不是教训**——「重投必须幂等」在 DB 队列里由租约 CAS 的条件 UPDATE 承担 | — | 不适用 | M3-02 |
| M3-04 | 心跳服务两段式，**承载从 Redis 改为中央 libsql**（2026-09-14 改写）：worker 5s 写心跳行、15s 视为过期；断 45s → offline 告警不打断；断 >30min → 撤销主机租约（`lease.ts` 的 revoke + 单调 fence）、卡带 freshWorktree 重回可派发集、当前 phase 从头重入 | `src/worker/heartbeat.ts` + orchestrator 侧监视 | 拔线演练：45s 收到告警且执行未中断；30min 后卡在另一机凭全量注入重建并续跑成功；**被撤销的持有者拿旧 fence 回来续租必须被拒** | M3-01, M1-08 |
| M3-05 | 心跳 payload 扩展：intranetIp / os / machine 指标 / capabilities / versions 三元组 / currentCards / credentialProbe / configVersion piggyback | payload schema + 节点健康页对接 | 节点健康页显示全部字段；每次心跳重申期望态——绕过 diff 直接改 DB config，下一次心跳仍收敛 | M3-04, M1-36 |
| M3-06 | worker daemon：能力声明、启动回扫自己粘性队列与本地 worktree 孤儿、孤儿 quarantine | `src/worker/daemon.ts` | 重启 worker 后进行中卡续跑；无主 worktree 进 quarantine 不被误删 | M3-04, M1-29 |
| M3-07 | 组网：三机 Tailscale；中央 libsql API 仅内网（2026-09-14：Redis 随 BullMQ 撤销，`requirepass` 一项删除） | 组网手册 + 配置 | 三机互通；libsql 端口仅内网可达；外网端口扫描无暴露 | — |
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
| M5-01 | Windows 主机接入：WSL2 Ubuntu 内跑 Linux worker，复用 `deploy/linux/install.sh`（2026-09-05 改：原生 Windows 计划任务 + Git Bash 方案作废，02 §1.5/§6.1 已更正） | 复用 Linux 部署件 + runbook WSL 小节 | 全新 WSL2 Ubuntu 上一条命令跑通安装脚本；重启 Windows 后单元自动回归 | M3-06 |
| M5-02 | ~~Windows 降级路径：纯 Playwright 探针执行器~~ 随 M5-01 改道作废 | — | — | — |
| M5-03 | self-update 滚动升级：控制台发布目标版本 → worker 空闲自查 → 自 drain → 升级 → SHA handshake 上报；同时只升一台、Linux 最后；pi 版本纳入同机制先单机灰度 | `src/self-update/`（busybee 骨架 + 跨平台 relaunch 抽象） | 三机滚动升级一轮无任务丢失无双版本并跑；注入坏版本 handshake 失败 → 停止推进并告警；pi 新版本单机灰度流程走通 | M3-12 |
| M5-04 | 行为回归统计基线固化：基线样本集入库 + nightly 常态化 | 基线集 + 报告存档 | 连续 7 天 nightly 报告生成且无误报 | M4-14 |
| M5-05 | 运行周报页：Notion 单页投影（吞吐/成本/friction/回归趋势） | 周报生成器 | 一期真实周报生成，Ryan 认可可读性 | M4-16 |
| M5-06 | 文档纪律：每个注入模型上下文的模块（prompt 片段/工具/skill）README 声明 Token effect 与 KV cache effect + CI 检查 | README 补齐 + CI 规则 | CI 对缺声明的新模块报错；存量模块全部有声明 | M4-13 |
| M5-07 | 安全收口复查：盘加密/内网隔离确认、审计双通道抽查、全量红线用例回归、脱敏规则复扫 | 安全 checklist 归档 | checklist 逐项打勾；红线用例回归全绿；全日志导出目录复扫无凭据泄漏 | M5-03 |
| M5-08 | **M5 验收 / GA**：连续两周 7×24 无人干预运行 | `docs/poc/m5-acceptance.md` + 运行统计 | 两周内所有停点均为合法三类（blocking_question / verify_loop_exceeded / retry_limit_exceeded）；无静默断流告警未处置；周报连续两期产出 | M5-01..07 |

---

## MW 首次真实需求全程观察（2026-09-18 夜 — 09-19）

需求「Hivemind 的 web 管理后台」是第一个从 Notion 接单、走完澄清 → PRD → 方案 → 原型 → 拆解 → 执行的真实需求。
逐条记录观察到的流程缺陷、根因与处置；**修复必须落在机制上**，手工推一把只算止血不算修。

| # | 现象 | 根因 | 处置 |
|---|---|---|---|
| W-01 ✅ | 画原型的会话声称画了六页，磁盘上一个文件没有 | 它借拆解的调用点取大脑档，连带继承了拆解的**只读**工具面（实测请求体 `tools: ['find','grep','ls','read']`）；守卫的只读工具名单写的是 Claude Code 的拼法（`list`/`glob`）而非 pi 的；围栏把契约根排除在自身之外 | 画原型成为自己的 `ModelPurpose`；两张工具名单合并为一个导出常量；围栏放行根目录。各带回归测试 |
| W-02 ✅ | 方案已批准，界面契约却留在未合的 PR 上 | `prototype-delivery.ts` 的注释写明「人批准方案时一起批」，但**没有任何代码在批准后合它**；而每张卡从自己的 worktree 读契约，worktree 从主干切 | `MergeRequestLandPort` + `SolutionRunner.landContract`：确认方案即落地契约，落不下去就停在 SOLUTION 让人看 PR，而不是拆完让每张带界面的卡各停一次 |
| W-03 ✅ | 七个 Epic 里三个在十分钟内 BLOCKED | 拒绝理由只说「invalid Story id」不说正确形状；prompt 说「数量有上限」不说上限是几；一个错 Story id 放大成十六条 reason 淹掉真正的打回理由；固定两次尝试在每轮都有进展时掐断 | 拒绝自带可照抄的形状；形状与上限随请求下发（上限来自配置）；级联抑制；固定两次改为上限四次 + 内环同款「理由集合不得重复」 |
| W-04 ✅ | BLOCKED 的 Epic 只能靠人评论恢复，而「id 形状不对」没有人答得上来 | 出路只有 `answerBlocker` 一条，它是为 blocking question 设计的 | `reopenRejectedDecompositions`：判据拒绝类的 BLOCKED 在安装版本变化后自动重开一次；blocking question 原样留着 |
| W-05 ✅ | 两版原型的 design lint finding 一字不差（实库 22 行只有 6 种，同一条重复四次） | `recordDesignLint` 在出口通过后记 friction（检测器慢/缺/错不许改变契约是否被接受，这是对的），但**没有任何代码把 friction 读回来**，下一版重画拿到的是和上一版一样的空白起点 | `RequirementStore.designLintFindings`：去重排序后作为「不否决」的提示进下一版 prompt。不给否决权是结构性的（08 §6）：拿得到否决权的审美评审每轮挑出不同一处细节，失败集合永不重复，卡只会烧完预算 |
| W-07 ✅ | 每个 phase 读的路径都带 `worktree/` 前缀，是模型自己摸出来的；SPECIFY 花十四分钟写完测试契约被以「没有测试」拒了三次 | session 头里的 `cwd` 写的是 session root（放会话文件的地方，没有仓库），pi 拿它当会话工作目录。模型写的测试落在出口不看的那棵树里；session root 下还长出第二棵 git worktree，挂在进程启动时所在的 checkout 上 | 头里改写这次 spawn 真正运行的目录；错位的 worktree 已移除 |
| W-08 ✅ | 「no session file」对每张卡的每一轮都出现，排障只能靠翻库和猜 | `inspect-round` 按一个已不存在的布局找会话（`<root>/<runId>/*.jsonl`，实际是 `<root>/<card>/<phase>/r<round>-a<n>.jsonl`），并且传了一个它从没取出来的 round | 按实际布局找，取最后一次 attempt。W-07 花一整夜才找到，就是因为这条先坏了 |
| W-09 ✅ | 失败那一轮的 tokens 记成 0、费用 0，而它真跑了 837 秒 | 记账写在出口检查之后，出口一拒绝就抛错走人；会话内回喂的那几轮 prompt 也从来不在这一轮的账上 | 记账移到抛错也走得到的地方，只记一次；回喂的 usage 逐轮累加进来。费用上限是唯一的敞口护栏，漏账就是护栏上的洞 |
| W-10 ✅ | 模型在卡的树里找不到依赖，跑去宝宝机主 checkout 翻源码，最后把宓主的 `node_modules` 软链进来 | 新切的 worktree 只是一份 checkout，没有装依赖；SPECIFY 要证明测试是红的，而测试根本跑不起来 | `worktree.setupCommand`（per-repo，默认空）：仓库自己声明一棵新树怎么准备好。hivemind 自己配 `npm ci`。软链宓主依赖会让树对着宓主恰好装了什么构建，不可复现 |
| W-06 ⬜ | 人只能从 worktree 的 `file://` 路径看原型，背离「只在 Notion 上完成」 | 截图能力（`prototype-screenshots.ts`，四态）与 Notion 上传能力（`sdk-adapters.ts` 的 multipart + `file_upload`，Story 侧已在生产用）都在仓库里，**两者之间没有接线**；MU-09 记的「gateway 没有 multipart 通道」是错的 | 待定：Ryan 倾向接 Cloudflare 一类免费服务给可点原型；截图进 Notion 是另一半，两件事不互斥 |
| W-11 ✅ | host 十二分钟一张卡没派，日志里每个周期只有一行 `cycle failed: Codex error: The usage limit has been reached` | 周期顺序是 checkouts → intake → projection → **拆解** → **Epic 维护** → 回归 → 派发，而 `step()` 只吞 TRANSPORT；一个拆不动的 Epic 让派发永远走不到。回归道早就因为同样的教训改成了「报告而不上抛」，这两步没跟上 | 拆解与 Epic 维护改成报告而不上抛。一个 Epic 拆不动，与已经拆出来的那些 Story 无关 |
| W-12 ✅ | `openai-codex` 配额耗尽后，每个周期还在敲同一个账号，`retry_at` 停在 00:48 再没动过 | 拆解这条路只读断路器（`usableProviders(...)[0]`）从不回写；Story 那条路一直是对的（`run-story.ts:622-633`），只有这条漏了。于是 `model.tierFailoverChains` 的降级从来没有机会发生 | 拆解失败按同一判据回写断路器：`classifyError !== UNKNOWN` 才记，我们自己的缺陷不许开别人的闸。实测窗口从 00:48 改写成 02:09，下一周期即取链上下一个 |
| W-13 ✅ | W-11 修完后浮出来：两个 Epic 反复拆解失败，每个周期重来一次按大脑档计费，看板上没有任何给人看的东西 | 端口在「回复里找不到能解析的候选」时抛普通 `Error`，而 `EpicDecomposer` 的尝试循环没有 catch——抛出去就跳出循环：不消耗尝试、不进 `previousRejections`、不走 `block()`，Epic 留在 `DECOMPOSE`。W-03 加的「四次上限 + 理由不得重复」全在这条路径之外 | `DecompositionContractError`：解析失败当作一次被拒的尝试，理由回喂、消耗一次、同样失败两次即 BLOCKED；provider 失败照旧上抛，它对「拆得对不对」零信息量，由断路器读 |
| W-14 ✅ | 两张在跑的卡租约 01:09:38 取得、01:24:38 到期，`renewed_at` 与 `acquired_at` 完全相同；01:27 两轮都还在跑（CODE 会话已 762KB），租约已过期九分钟 | `LeaseStore.renew` 写好了、测过了、**生产代码零调用**。`run-story.ts` 只 `acquire` 一次，TTL 15 分钟，而 CODE 轮常规超过 15 分钟。单机靠 orchestrator 的 `inFlight` map 恰好挡住；多机没有这一层，而 AGENTS.md 说租约「是多机粘性不出双执行的根」——这个根只在前 15 分钟成立 | `startLeaseHeartbeat`：每 TTL/3 续一次，允许连丢两次；续租被拒只报一次，执行仍由 fence 强制；store 故障不当作丢租约 |
| W-15 ⬜ 观察 | DESIGN 轮静默 15 分钟：模型为了找一个还不存在的 `console-ui/` 目录跑了 `find / -maxdepth 6`，把宿主整盘翻了一遍 | 预测 footprint 指向尚未创建的目录，模型出树去找。工具面对 `bash` 不设边界 | **已有兜底生效**：`retry.promptTimeoutMs`(15 分钟) 到点放弃该轮、杀掉 `find`、以 continue 续跑，实测 01:30 恢复。代价是一个 15 分钟窗口 + 宿主整盘被读过一遍。不打算按命令拼写去围堵（换个写法就绕开）；真正的问题是「骨架由第一张切片带出来」这件事模型不确信，属于 prompt 而非守卫 |
| W-16 ✅ | 一个 Epic 的拆解跑满 15 分钟 prompt 超时，整轮作废交给下一周期再花一个 15 分钟（`timed out waiting for agent_settled`） | `grep -rn "runner\.prompt(" src scripts` 除测试与探针外只有两处生产调用：拆解端口与产品经理端口。其余每一条驱动模型的道都走 `promptWithContinueRetry`（phase / prototype / verify / UI 走查）——RPC 下 pi 进程与会话都还在，流断了发一句 `continue` 就接上。而 `retry.promptTimeoutMs` 的描述本身写的就是「resumed, not failed」，这两条道是例外，且恰好是全系统最长的两种 turn | 两处改走 `promptWithContinueRetry`；非可重试的失败（QUOTA/AUTH）行为不变，照旧返回给调用方由断路器读 |
| W-17 ✅ | `inspect-round` 把 CODE r2 的 34.9KB prompt 报成 44 段，其中 `### SPECIFY / test-contract` 0.0KB——而它是整份里第二大的一段 | `sectionMap` 把任何以 `#` 开头的行当分界，而组装器只写一个 `# `（任务标题），其余一律 `## ` / `### `。于是 `components.md` 自己的十四个标题、测试合同 YAML 开头的注释行都成了「段落」，内容的体重记到了内容自己的标题上 | 分界只认组装器写得出的三种。44 段 → 20 段，测试合同 0.0KB → 7.7KB。一张 prompt 地图说最大的那段是空的，会把读的人送去找一个并不缺的注入——W-08 同一个方向的假话花了一整夜 |
| W-18 ◐ 部分（见 W-25）| 第一张走到界面走查的卡，`uiContract.unreadable = 7`、`violations = []`——七条全是 `ERR_CONNECTION_REFUSED at http://127.0.0.1:4311/...`，而同一轮走查自己的页面全在 4173 上打开成功 | 两条道各起一份应用：盲审道起 4311/4312/4313 跑完就关，`functional.pages` 记的是那些 URL；走查道起 4173。`checkContract` 用前者的 URL，而前者此刻已经不在了。**两层能否决的判据里的契约层（色值/字号/间距是否来自 token 表）结构性地从未真正跑过**——现在是 warn 所以没人受影响，拨到 block 就会零覆盖放行或全数打回 | `onAppOrigin`：页面身份是 path + query，由哪个实例服务是「此刻哪个还活着」。只改写 loopback 源，其他主机原样留着 |
| W-19 ⬜ 观察 | 换代码要等一个多小时：SIGTERM 之后常驻打「Waiting for 2 in-flight Story run(s) before exit」，而 run-story 子进程会带着卡一路走完 CODE→VERIFY→CODE→…→DELIVERED，排空没有自然终点。期间不再派新卡，另外 10 张全停 | `stop()` 里是无界的 `Promise.allSettled(inFlight.values())`。注释给的理由是「A Story worker keeps running after its parent dies, and a restarted orchestrator would dispatch the same card again beside it」——**这个理由在 W-14 之后不再成立**：租约现在会续期，活着的持有者让卡不在可派发集里 | **暂不改**。生产上 systemd 的 `TimeoutStopSec=120` + `KillMode=mixed` 已经把它限在两分钟，所以不是生产缺陷；而提前退出要同时想清楚 `handle.close()` 与 orchestrator 自己那半 DB 工作的生命周期（注释写明关早了会被报成 Story 失败）。这条改动碰的是进程退出与双执行两条不变量，值得单独一个 PR 想清楚，不在夜里顺手做 |
| W-20 ✅ | `npm run health` 退出码 1：「最早一条没发出去的 Notion 写入已经 19 分钟，看板不再显示系统在做什么」。两行 outbox 挂着，`attempts = 0`——不是发失败，是根本没人去发 | `outbox.replay` 在 `reconcileProjection` 里，而它是一个 cycle step；`stop()` 第一件事就是 `clearInterval(timer)`，然后才等在跑的卡。于是排空期间卡照常从 CODE 走到 VERIFY 再回 CODE，每次状态变化都排一行，一行都发不出去。今晚那次排空一个多小时 | 排空期间每 15 秒继续发，结束再发一次；其余一概不动。刻意只修这独立无风险的一半，排空本身没有上限那条仍是 W-19 |
| W-21 ✅ | Epic R237511RC 在 `epic.transition DECOMPOSE→BLOCKED` 之后同一毫秒就 `epic.decomposition_reopened` 再回 DECOMPOSE，`criteriaVersion` 与上一次重开的完全相同（`1889222`）。换句话说它每个周期都会被重新拆一次，永远到不了人手里 | `decomposition-reopen.ts` 在每个 BLOCKED 上 `triedSinceBlock.clear()`：重开记的版本会被它自己引发的那次拒绝抹掉，于是「每次改动重试一次」变成「每周期重试一次」，每次都是一整轮大脑档拆解。同文件的测试「counts a retry only against the refusal it answers」把这个循环当成期望行为写死了 | 重试由它产出的那次拒绝消费，不由启动它的那次重开消费：block 时 `spent = {openedUnder}` 而不是清空。人回答之后仍有新一次机会（回答不写 transition，`openedUnder` 已被上一次 block 消费掉），所以四类真停点不变 |
| W-22 ✅ | R237511RC 四次拆解有八条拒绝都是 `footprint must name a directory or module, not a file: src/console 角色配置读取与版本对比`——模型写的**是**目录，只是后面跟了一句为什么选它。拒绝描述的是它没犯的错，于是它每轮换个写法再犯一次 | 与同文件 `ID_SHAPES` 那条注释记的教训一模一样：只报「违反了哪条规则」的拒绝，下一轮无法据此修改。prompt 那句「predictedFootprint 保持目录或模块粒度」也没说过「路径之外不能有别的字」 | 拒绝文案写出形状本身（路径单独一条、小写、无文件名无扩展名、后面不跟说明），并在 prompt 与每轮请求的「id 与数量」段各说一遍——`decompose.ts` 这一层是模型忽略 prompt 时仍然生效的那层 |
| W-23 ⬜ 观察 | `R-237511dd5162 status drag: unsupported_property_change (not applied)`——人把需求卡拖到一个当前状态不接受的列，系统记下观察、更新影子、什么也不做，页面上没有任何说明。`HUMAN_WINS_MS = 120_000` 之后投影把列写回去，于是人看到的是自己的操作两分钟后被悄悄撤销 | 需求/Epic/Story 三层一致地这么做（`requirement-input-sync.ts:155`、`epic-input-sync.ts:102`、`story-input-sync.ts:110`），所以是设计而不是某处漏写。它成立的前提是「状态是系统 owner 字段」，这条对；缺的是**告诉人为什么不生效** | **暂不改**。最合适的做法是拖动被拒时在页面留一条一句话评论（复用阻塞问题已有的评论通道，影子已更新所以一次拖动只会说一次），但这是写进 Ryan 的 Notion 的对外动作、且属于呈现改动，按既定做法要先做样例页给人看过再改投影代码 |
| W-14 ✅ 已验证 | 换代码后新起的 `S-R237511CO-02` 在 03:19:19 领单、03:24:20 首次续租，`renewed_at - acquired_at` 恰好 300 秒 = `LEASE_TTL_MS / 3`。跨机粘性在长 phase 上不再靠运气 | — | — |
| W-24 ✅ 已验证 | 首次回归扫在重启后 14 分钟内跑起来：`regression_runs` 从 0 到 5，`epic/R237511CO` 的五条场景全部 verified、零 failed。取的是 `scenario_registry(pool, last_verified_at)` 索引上最旧的五条，剩下十条排后面的周期，符合设计 | — | — |
| W-25 ✅ | `S-R237511CO-02` 第二轮是第一份完整的界面走查：功能道 accepted、走查在 `http://127.0.0.1:6173/...` 上真跑过三条场景并给了两条 findings（major + minor，都不否决）——但 `uiContract.unreadable` 仍是三条 `ERR_CONNECTION_REFUSED at http://127.0.0.1:4187/...`。**W-18 的 `onAppOrigin` 是对的，但它是空转的**：改写的目标是「本道自己起的应用」，而 `verify.appStartCommand` 这个 per-repo 键为空，`handle` 根本没建，`appUrl` 恒为 undefined，于是 `onAppOrigin` 原样返回盲审道那个已经关掉的端口 | 走查能看到 6173 是因为走查 agent 在自己 session 里起了应用（证据目录里有 `harness.mts`），那个实例不归 `AppUnderReview` 管、也不会活到契约层。所以只要 `verify.appStartCommand` 为空，契约层就**结构性零覆盖**，而它现在报的是「三个页面打不开」——看起来像偶发，实际是这一层从没在这个仓库上量过任何东西 | 没有应用可开时直接说出来：一条指名 `verify.appStartCommand` 的说明，并记 `ui_contract_no_app` friction（08 §6 要用数据决定这层什么时候配拿到否决权，从没开过页面的层显然还没有）。**不猜 start command**——这个仓库的 console 应用正是这批 Story 在建，等它落地才谈得上配。测试里六条「无应用也能读页面」的用例按 AGENTS.md 一并改掉：那个组合在生产里不可能出现 |
| W-26 ✅ | `S-R237511CO-03`（footprint `src/console` `src/orchestrator` `src/persistence`）在 `S-R237511MB-01`（`src/console/` `src/persistence/`，已在 CODE、worktree 里正在写）旁边被派了出去。用实库复算 `planStoryExecution`：两张确实冲突——规划器把 CO-03 放进 batch 1、MB-01 放进 batch 6，然后协调器取 `batches[0]` 派发 | 规划每周期从零重算，输入里**没有「谁已经在跑」**。`DispatchQueue.dispatchable` 只把被租约持有的卡从批次里剔掉，挡的是同一张卡被派两次，挡不住「批次一里的卡与批次六里那张正在跑的卡共用目录」。于是 footprint 这道防线只在同一批内生效，跨批完全失效——而正在跑的那张必然在别的批 | 在跑的卡占住首批：`StoryExecutionOptions.running` 由协调器从 `leases` 读（不读自己的 in-flight map——重启后那张表是满的而 map 是空的），首轮先把它们放进 batch，其余按既有冲突判据往里加。空 `running` 时逐字节等价于旧行为，有一条测试守着 |
| W-27 ✅ | `S-R237511MB-01` 的 footprint 是 `["src/console/","src/persistence/"]`，带尾斜杠；其余卡都不带。实测 `pathsIntersect("src/console/", "src/console/tabs")` 为 **false**，而 `pathsIntersect("src/console", "src/console/tabs")` 为 true——带尾斜杠的目录装不下它自己的子目录 | 拆解那一层的 `footprint` 正则会拒掉尾斜杠，但 **SHAPE 的 DoD 会把它整个覆盖掉**（`story-execution-store.ts` 的 `UPDATE stories SET predicted_footprint`），而 `dod.ts` 对这个字段只要求 `z.string().trim().min(1)`——没有任何形状约束。于是两种写法都会到达调度器 | 在 `pathsIntersect` 里去掉尾斜杠：同一个目录的两种写法必须得到同一个答案。改在比较这一层而不是写入这一层，是因为 footprint 会进 DoD 文本、进 prompt，改写入会动到 `assemblePhasePrompt` 的字节；顺带让人写带尾斜杠的 `schedule.hotspotPaths` 也能正常匹配。三条测试：同目录两种写法串行、仅前缀相同仍并行、hotspot 带尾斜杠仍生效 |
| W-28 ✅ | 盘了一遍十四张卡的 footprint，除尾斜杠外还有 glob 写法：`S-R237511CO-02` 是 `["docs/prototype/pages/costs.html", "src/console/**", "src/observability/**", "src/persistence/**"]`。实测 `src/console/**` 装不下 `src/console/panels`（false），而 `src/console` 装得下 | 与 W-27 同一个根：`dod.ts` 对 `predicted_footprint` 没有形状约束，SHAPE 写什么就是什么。当前数据里恰好没有真撑爆的配对（没有卡声明 `src/console/<更深>`），所以是潜伏的，不是已发生的 | 把尾部的 `*` / `**` 整段去掉，与尾斜杠走同一个 `directoryOf`；只去整段，所以 `src/consoles` 和真叫 `*` 的文件保留原名。两条新测试守这两面 |
| W-29 ✅ | 今晚第一个真停点：`S-R237511TD-01` 停在 `retry_limit_exceeded`，而停点汇总是 `spent: 0, budget: 0, rounds: [], costUsd: 0`、`diagnosis.reason` 为「the budget was spent before any verification round completed」。两轮 VERIFY 都是 `inconclusive`，原因相同：`VERIFY returned a malformed verdict` | `verify/executor.ts` 对读不出判决的回复直接报错收场，内环再跑一轮——**重跑的是同一份 prompt，模型从没被告知上一答哪里不对**，于是第二轮就是第一轮的重演，两轮之后卡被停靠。这正是仓里已经写过两遍的教训（`ID_SHAPES` 那条注释、W-13 的拆解契约）：只报「不合格」而不说形状的拒绝，下一轮无法据此修改。全仓只有 VERIFY 这一道没有会话内回喂 | 读不出判决时在**同一个 session** 里告诉它并再要一次，最多两次；还是读不出就像以前一样 inconclusive。回喂提示词明确要求「不要再判、不要跑工具，把已经定下的结论重发一遍」，tree pin 依旧守着树不被动 |
| W-30 ✅ | 人把「处理已有待办并继续工作」从停靠拖回执行后，看板属性已经是「进行中 / 验证 / 第 2 轮」，页面正文却仍然挂着橙色停点 callout 与「需要你处理」整段。库里 `stop_reason` 已空、`state = CODE`，而 `notion_outbox` 里这张卡的最后一条 `sync_story_page` 停在停点那一刻 | `outbox.enqueue` 的 `ON CONFLICT(target, payload_hash) DO NOTHING` 把排重定义成「跟**曾经**发过的任一份相同就不发」。一张卡停下再被人恢复，页面期望值逐字节回到停之前那份，于是与旧行撞哈希、被丢掉，Notion 永远停在中间那份。实测：在库副本上重算这张卡的页面投影，得到的哈希正是 07:06 那行停之前的投影，新行一条没入。Epic 页（`epic-page-projection.ts`）与 Story 属性（`boardDisagrees`）各自打过一个补丁，Story 页漏了 | 不再逐处打补丁，把排重规则本身改对：只有当撞上的那行**仍是这个 target 收到的最新一份**时才算重放并折叠；已经被后来那份盖过的，重新出现就是新活，复活那行重发。重放排序同时从 `id` 改为 `created_at`，复活的行带的是复活时刻，所以它落在期间排队的那份之后而不是之前 |
| W-31 ✅ | `P0: Local orchestrator cycle failed ... The operation was aborted due to timeout`。一次 Notion 请求撑到自己的截止时间，整个周期挂掉：派发、Epic 保养、回归扫全都没跑，还报了一条 P0 | `step()` 只容忍 `TRANSPORT` 一个类，而「The operation was aborted due to timeout」落在 `TIMEOUT`。链路抑一下会用不止一种说法，把其中一种写进容忍名单、其余的毁掉整个周期，是把「哪类故障能重试」这个已经存在的判据重新猜了一遍 | 判据改用 `classifyError(message).retryable`：重试能清掉的故障跳过本周期，需要人拿主意的仍然停周期。`classify.test.ts` 釘住实测到的那句原文 |
| W-32 ✅ | 回归道在 `epic/R237511TD` 上把 `S-R237511TD-01` 的 5 条场景全跑红，而这张卡此刻还在 CODE 第 2 轮、从来没交付过——Epic 分支上根本没有它的实现。失败签名五条完全一致 | 场景在 DoD 冻结那一刻就进了 Epic 池，而不是在它交付之后。更坏的是失败**不写** `last_verified_at`，于是这八条永远排在队头，每个空闲周期都被重扫一遍，把真能说明问题的场景挤在后面。再扫两轮就凑齐 `regression.minFailures = 3` 且签名相同，会给一个从没建过的功能开回归卡，那张卡又以「有未关闭的回归卡」堵死它自己 Epic 的合流闸并叫人来看 | `ScenarioRegistry.pool()` 只取已 `DELIVERED` 的 Story 的场景：代码不在被扫的那棵树上，这一跑就什么也证明不了。合流闸不受影响：它要求每条注册场景在被提议的 revision 上有一条 passed，Epic 全部 Story 交付后自然都能扫 |
| W-33 ✅ | 回归扫在 `epic/R237511TD` 上整个挂掉，`FAILED: Command failed: git checkout --detach ` / `fatal: empty string is not a valid pathspec`，并报了一条 P0 | 这个 Epic 没有任何 Story 合进来过，`attributionSequence` 于是返回 `base: ""`——「没有基线」的写法。二分的第一探就是探 base，这个空串被原样交给 git，一条致命错误把整个 Epic 的扫带下水 | 没有基线就不探：没东西落到过这个头上，就没有任何 Story 能拿这次失败，直接走文档里已经写明的「不归因」路径。W-32 让这个状态不再出现，这一条是第二道 |
| W-34 ⬜ 待 Ryan 决策 | `S-R237511DT-01` 停在 `retry_limit_exceeded`，而它是目前收敛最健康的一张：第 1 轮 8 条没过、第 2 轮只剩 1 条、第 3 轮 VERIFY **已通过**。吃掉最后一轮的是 `git rebase epic/R237511DT` 在 25 个 commit 里的第 20 个上撞了冲突 | 这是 D2 的字面行为（「归因到 Story 的合流失败各消耗一轮」），不是实现 bug。但轮次上限管的是「打转」，而 rebase 冲突既不是打转也不是质量问题——它只说明别的卡先落了。于是一张已经验收通过的卡停下来问人，而人唯一有用的动作是「再给一轮」——这正是「每层只呈现该层要决定的事」要消除的那类打扰 | 不自行改：轮次口径写在 03 §1.5 与 D2，改它要改设计文档。供 Ryan 判断的一个选项：冲突型打回不占收敛预算，另设一个小的冲突重试上限（质量问题与机械问题分开计） |
| W-35 ✅ | `S-R237511TD-01` 的 CODE 出口用完轮次被拒（改了 SPECIFY 冻结的测试，红线拦对了），系统记下 `phase.failed`、把 findings 嗂回下一轮、卡回到 CODE 继续跑——同时报了一条 P0 | `runStory` 的 catch 里，`cancelled` 与 `provider_fault` 都直接 return 并写明了理由（「每次重试报一条 P0 会把每张卡的每次重试都重复一遍」），而 `reenter` 与 `park` 落到同一个 `throw error`，外层 `.catch(reportP0)` 于是逐次报警。`park` 更是报两次：`announceStop` 已经把停点汇总发给所有 sink，P0 又追一条只带子进程命令行的 | 两分支改成 return：系统自己会再试的事不叫人，记录留在 warn 行与 `story.dispatch_failed` 事件里；真停下时 `announceStop` 仍是那一条告警 |
| W-36 ✅ | 合流冲突只存了一条 `merge.conflict` 事件，里面是 git 的整段散文；friction 管道里没有这个种类，所以「它多久发一次」没人答得上来；打回 CODE 的那一轮也只拿到散文，得自己猜是哪几个文件 | Ryan 2026-09-19：冲突应该在 merge 阶段解掉，但先要能数。而 MERGE 是只读阶段（`guard/policy.ts` 的 `READ_ONLY_PHASES`），结构上就改不了代码，所以「在 merge 里解冲突」要么破红线要么新开一个写阶段——两者都是设计文档级的决定 | 本片只做可观测：`MergeResult.conflict` 带上冲突文件，写进 `merge.conflict` 事件的 `conflictedFiles`、写进 friction 的 `merge_conflict`（可计数），并作为 `failures` 渲染在 `[rejected:MERGE]` 的最前面。预防（CODE 轮间先贴着 Epic 头走）与提前预告文件/方法另列 |
| W-37 ✅ | `P0: Notion outbox gave up on sync_story_page for S-R237511TD-01`：同一行连吃 8 次 `The operation was aborted due to timeout` 后被判死信，这张卡的页面正文从此停在旧内容。事后把那条载荷原样重放，六个请求 3.8 秒发完并全部 200——载荷没有任何问题 | 两处叠起来：① gateway 只对 429 重试，一次读超时就把整趟（一次页面投影是几十次读围着几次写）全部作废；② outbox 的 8 次预算注释写着「撑过几个周期的 Notion 故障」，但周期是 10 秒且失败后不退避，8 次 = 80 秒，比一次 Notion 抖动还短，于是瞬时故障吃掉了本该留给「这份载荷 API 永远不收」的预算 | 把「说不出载荷任何信息的故障」单独认出来（超时 / 网络 / 5xx / 429），gateway 对**只读**请求重发两次（append 不幂等，超时的写原样交还，绝不盲目重发，否则页面上会多一个块）；outbox 给这类故障退避（10 秒起翻倍、封顶 10 分钟）并只在连续这样失败超过一小时后才判死。认不出来的错误仍按老路走：8 次后死信 + P0，让人来看 |
| W-38 ✅ | 中央库 `data/hivemind.db` 涨到 1.46 GB。`dbstat`：`event_log` 独占 1.12 GB，其中 `rpc.message_update` 237 万行 / 578 MB——都是流式 token 增量 | `LibsqlPhaseRecorder.writeEvidence` 把 `result.events` **同时**写进证据文件 `run-events.jsonl`（`rpc/event`）和 `event_log`（`rpc.<type>`）。04 §3 明确写着这是两条流：`run-events.jsonl` 是 agent 行为流，`event_log` 是编排决策流，Epic 与需求状态都从后者回读。镜像等于把整个行为流灌进那张被回读的表里，而且没有任何读者——`inspect-round.ts` 还专门 `type NOT LIKE 'rpc.%'` 把它们排掉 | 去掉镜像，RPC 流只留在证据文件里。既有的 237 万行不自行删除（规范日志不改写），留给 Ryan 决定是否清理 |
| W-39 ✅ | `P0: Story S-R237511DT-01 failed: existing worktree for S-R237511DT-01 is not on story/s-r237511dt-01`，每次派发都报一次，这张卡再也动不了。现场：该 worktree 停在 detached HEAD、`.git/worktrees/.../rebase-merge` 还在、`vitest.config.ts` 是 `UU` | `EpicMergeFlow.merge` 的 rebase catch 里读完 `diff --diff-filter=U` 就直接 return，**从不 `rebase --abort`**。一次没解开的 rebase 占着那棵树：HEAD 脱离分支、冲突留在工作区，于是下一次派发的「worktree 必须在 Story 分支上」守卫永远不通过。W-36（冲突计数）和这一条是同一次冲突的两面：那次记下了文件名，却把树丢在半路 | 先读冲突再放回树：catch 的三条出口（冲突 / 读不到冲突状态 / 非冲突失败）统一先 `rebase --abort`，abort 本身失败就把「这棵树还得人搭把手」接进 reason。派发侧的守卫不改——它 fail closed 是对的，别的原因造成的脱离仍该叫人 |
| W-40 ✅ | 两条 `P0: regression sweep failed`，底下的原因都是 `FAILED: VERIFY provider failure: 429 rate_limit_error`；另有一次 `FAILED: Command failed: git checkout --detach `（空串）把整个 Epic 的扫带下水 | ① 回归扫的任何失败都直接 `reportP0`，而扫本身是跑在前台后面的安全网、下一个空闲周期还会再跑一遍——provider 忙不是人的问题，和 W-31 / W-35 是同一类「为系统自己会再试的事叫人」。② W-33 只守住了 `base === ""`，`steps[].revision` 为空仍会原样交给 git；当前数据里造不出这个空值，所以这次没复现出来，但那条不变量本来就该是全称的 | ① 扫失败改按 `classifyError(message).needsHuman` 判：RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT 只记 warn，UNKNOWN 与 AUTH / QUOTA 照常 P0（认不出来的仍然叫人）。② 「revision 要么是 sha，要么就没有这条序列」收到 `attributionSequence` 一处表达：任一 step 的 revision 为空即整条序列视为不存在，既有的 `base === ""` 出口把它变成 `pre_existing` |
| W-41 ✅ | `S-R237511TD-01` 停在 `verify_loop_exceeded convergence:stalled`：连着 4 轮、8 条场景一条不差地全红，逐条理由都是「这个场景要看见的内容无从查证：没有留下任何页面结构记录」。证据目录里 `page-*.yml` 其实一堆 | 盲审把 8 条全判 passed，但 verdict 里没填 `snapshots`，于是结构层（08 §6）只能拒——它读的就是这份声明。prompt 早就写了要填（`prompts/phases/verify.md`），而「prompt 是最弱的一层」。真正让它转不出去的是**拒绝被送错了人**：结构层的 finding 随 `[rejected:VERIFY]` 发给 CODE，可 CODE 改不了盲审的声明，下一轮盲审原样再来一次，四轮一模一样直到预算耗尽 | 按既有的一套机制处理：**会话内回喂**。verdict 解析出来后立刻查「判了 passed 且声明了 `visible` 的场景有没有点名任一份结构记录」，没有就在**同一个盲审 session** 里点名这些场景要求补——它此刻正站在页面前，是唯一改得了这件事的人。最多两次（与已有的畸形 verdict 回喂同档），不耗轮次、不算重入；两次之后结构层照常否决 |
| W-42 ✅ | W-32 修好之前留下的残渣：`S-R237511TD-01` 的 5 条场景各有 3 条 failed 的回归记录，而那几次扫的是一棵根本没有这张卡代码的树。这些行还在 `regression.windowSize = 10` 的窗口里 | `judgeRegression` 判的是「最近这一窗里坏得够不够多」，不判「现在还坏不坏」。所以这张卡交付后第一次扫**通过**时，窗口是 `[P,F,F,F]`：失败 3 条达标、失败率 0.75 过线、同签名 3 次达标 —— 会给一条刚刚跑绿的场景开回归卡，卡住它 Epic 的合流闸并把 Story 打回 SPECIFY。另外「主导签名」是按窗口内出现次数选的，可能命名一个不是眼下这次失败的 break，Story 会被打回去修另一件事 | 回归卡命名的是**此刻正在发生**的失败：窗口最新一条必须是 failed，且卡只认这条失败的签名（它在窗口里复现够 `minFailures` 次才开）。窗口大小、失败率、最少次数三个配置语义不变；残渣数据不删——新规则下它们既当不了头也当不了名字 |
| W-43 ✅ | `R237511DT` 两张 Story 全交付后，评审请求停在「15 条场景在 `e28e196` 上没有通过记录」。主机上两张别的卡在盲审，回归扫的 idle 档不跑，Epic 就一直等——而这正是 `awaitedByDelivery` 那条旁路（注释写着「不然交付完的 Epic 会无限期排在别的 Epic 的 Story 后面」）存在的理由 | 旁路问的问题和它要疏通的那道闸不是同一个：闸要「在**被提议的那个 revision** 上通过过」（`epic-gate.ts` 的 `u.revision = ?`），旁路只问「有没有**曾经**通过过」。Story 合进 Epic 头会换 revision 并清空 `last_verified_at`，于是所有在旧头上绿过的场景（`S-R237511DT-02-*` 七条全是）都掉出触发集，只能等一个 7x24 服务不一定给得出的空闲窗口 | 判据抽成 `unprovenScenarios(client, epicId, revision)` 一处，闸和调度共用；调度另加 `epicsAwaitingDelivery(client, repo)` 挑出「只差证据」的 Epic，逐个 `git rev-parse epic/<id>` 拿到头再问同一个问题。分支还没发布过就跳过（没有 revision 可证），idle 档照常覆盖 |
| W-44 ✅ | 回归扫连着几个周期拿同一句 `429 rate_limit_error` 失败（W-40 之后只记 warn 不再叫人，但也就只是不叫人了）。`R237511DT` 的证据因此一直补不齐，Epic 停在「还有 N 条没有通过记录」 | 扫的 provider 是从熔断器里挑的（`usableProviders(chain, snapshot)` 取第一个可用），但子进程失败后**没有人报回去**：这家仍然算「可用」，下个周期再挑中它、再撞同一堵墙，永远轮不到链上的下一家。这和 `decomposeWaitingEpic` 当初那笔债一模一样，那边的注释已经写明白了，扫这条道漏了 | 扫的子进程失败时同样 `providerHealth.recordFailure(provider, message, breakerPolicy)`，只对错误目录认得出的类别记（我们自己的缺陷是 UNKNOWN，不许开熔断器），于是下个周期跳过这家、取链上下一家 —— 「订阅打满只许降级，不许停工」对回归道同样成立。脚本层没有单测桩，验证靠 typecheck + 全量 + 真机观察熔断器是否真的跳到下一家 |
| W-45 ✅ | `S-R237511DT-02-mobile`（`ui`+`e2e`）在同一棵树上，Story 的 VERIFY 第 2 轮判 passed（证据目录里有真实的 aria 快照与截图），回归扫 12:56 判 inconclusive，理由是「浏览器打开 127.0.0.1:39118 被拒，仓库里没有可运行的 console-ui」。`R237511DT` 的评审请求因此一直差这一条 | 盲审 prompt 的浏览器段（`browserLaneInstructions`）把「页面需要服务就自己起一个、自己挑一个没人占的端口」交给验证会话。仓库怎么起应用是仓库的事实，`verify.appStartCommand` / `appReadyUrl` 早就为此定义（03 §9「系统起服务、把 URL 交给评审」），但只有 UI 走查道读它，两条盲审道从不读——于是每个会话自己发明一套：发明对了就 passed，发明错了就 inconclusive。判据的答案取决于会话猜到什么，收敛判据在这种判据上不成立 | 新 `src/verify/app-lane.ts` 包住既有的 `AppUnderReview`：按仓库配置起应用、poll ready、把真实 URL 与它的 host 交给这一轮，轮次结束必停。`BlindVerifyStoryPort` 与 `BlindSweepPort`（含归因二分用的 probe sweep）各接一道，prompt 由 `app` 三态决定措辞——有地址就禁止自建替身、起不来或没配就明说并要求「要看屏幕的场景这一轮判 inconclusive」、仓库确实没有应用（未传 `app`）才保留原来的自己起。走查道的 `browserLaneInstructions` 同时拿到地址，消掉它此前「上一段说应用在这、下一段说自己起一个」的自相矛盾 |
| W-46 ✅ | `R237511TD` 的 5 张回归卡失败签名全是同一个 `4e66ec96…`，反推出来就是兜底文案 `regression scenario failed without a reported reason`。卡上没有任何可读的原因，归因二分去找「哪个 commit 弄坏的」找的是一句空话 | 两层。①`BlindSweepPort` 只读 `runnerFailure` + `validationErrors` 两个字段拼**一句共用的** output 发给所有失败场景，盲审逐场景给出的 `reasons` 整个没用上；verdict 是 rejected 而 runner 没失败时，那句共用的就是兜底文案。同一场景内两次**不同毛病**的失败于是 hash 成同一个签名，`judgeRegression` 的 `recurrences` 把它们当同一个复发累计（窗口是 per-scenario 的，不跨场景）；反过来真修好一个毛病换了新毛病，签名不变，`regression_cards` 的 `(scenario_id, signature)` 冲突键让卡不会重开。②`executor` 的 `scenarioReasons` 只覆盖 verdict 文档里自述未过的与结构层 findings，**被系统自己判失败的那类（`observedFailures`：自述 HIVEMIND_TEST_RESULT 说 failed 而结论写 passed）从来没有理由** | 扫改为逐场景取自己的理由（`reasons` → 该场景的 `validationErrors` → runner 自身失败 → 最后兜底也带上场景 id，让两条没理由的失败仍是两个 break）；executor 给 `observedFailures` 补一句确定性的中文说明。顺带修掉 #124 漏带进 main 的三处 `vi.fn` 参数类型错误 |
| W-47 ✅ | `R237511TD` 的分支跟进连着 10 个周期失败，`npm run health` 确实把它报成 Stuck，但那句话是 `Epic R237511TD cannot take main into its branch: Command failed: git merge --no-ff origin/main`——人被叫来了，却不知道该打开哪个文件 | `processGitCommand` 只留 `result.stdout`，失败时 `execFileAsync` 的 `error.message` 只含 stderr；而 git 把 `CONFLICT (content): Merge conflict in <path>` 写在 **stdout**，于是冲突路径整个丢了。`merge-flow.ts` 早就知道要在 abort 之前读 `diff --name-only --diff-filter=U`（注释写着「git 的散文不够，要文件名」），这条道漏了 | 同一模式：merge 失败后、`merge --abort` 之前读冲突文件，拼进 `failure_reason`，于是探针那句话变成 `…; conflicts in src/console/server.ts`。上浮路径本来就有（`progress-health.ts` 的 `unmergeableEpics` 只看最新的 succeeded/failed），不动 |
| W-48 ✅ | `epic_branch_refresh_events` 一天里积了 `R237511DT` 742 行、`R237511MB` 431 行 `skipped` | 每周期每个 Epic 写一行「这次没做」。而查间隔的语句只读 `outcome='succeeded'`，探针只读 `succeeded`/`failed`——**skipped 行零读者** | 不写了。与 W-38 同一类：一条没有读者的记录只会长大 |
| W-49 ✅ | 我验收 `R237511DT` 时对两条 PRD 场景记了缺口，系统按设计开出两张补交付卡、把 Epic 送回 EXECUTING 并清空 `mr_url`——而 GitHub 上的 PR #123 仍开着。两张卡做完后 Epic 会再次要求开评审请求，源分支和目标分支都没变 | Epic 道直接 `mr.create`，从不问「这两条分支之间已经有一个开着的没有」。平台对同一对分支的第二个请求直接拒绝，于是一个做完的批次会连提交评审都做不到。Story 道从一开始就用 `findOpen` 复用自己的草稿，`MRPort.findOpen` 的注释写的就是这件事（「a Story that comes back after its draft was opened reuses it instead of tripping the platform's already exists refusal」），Epic 道没接 | 开请求前先 `findOpen`，有就复用那个 URL。描述不回写——已开的请求里是上一批的章节，而下一批的章节等它真正被合并时由 Story 报告重新组装；这一条留给「验收打回后请求正文过期」单独处理，不混进这次修复 |
| W-50 ✅ | 解 `R237511TD` 的分支冲突时发现：它的 Epic 分支从 **59 个 PR 之前**（`887bf6f`）分叉，而这张「直接完成等待本人的待办」的业务卡改了 `src/verify/executor.ts`（+73，**判它自己 verdict 的那段代码**）、`src/runner/continue-retry.ts`（+42）、`src/runner/model-resolver.ts`、`vitest.config.ts` / 新建 `vite.config.ts` / `vitest.setup.ts`（根构建配置）。预测 footprint 是 `[console-ui, src/console, src/notion, src/orchestrator, src/persistence]`，实际多出 `.`、`scripts`、`src/runner`、`src/verify` | 偏差**算出来了也存下来了**（`summarizeFootprintDeviation` / `stories.actual_footprint`），但那个函数只有测试在调，生产代码零处；`actual_footprint` 只写不读。于是全系统没有一处会因为一张卡改出它声明的范围而说一句话。CLAUDE.md 写着「卡越界改依赖由 CODE 出口拒掉并升级回这一关」——那条规则只覆盖依赖，没覆盖源码范围 | 先让它**被看见**而不是被拒绝：预测做在动手之前，连带改到隔壁是常事，一上来就拒会误伤。`unpredictedDirectories` 从 `footprint-deviation.ts` 抽出来，合流捕获实际 footprint 时顺手比一次，越界就记一条 friction `footprint_overreach`（点名多出来的目录），永不阻挡合流、sink 抛错也吞掉。等数据说话再决定要不要升级成门禁——「一张卡不许在它没声明的地方干活」这句话在有数字之前没人估得出代价 |
| W-51 ✅ | 两张不同 Epic 的交付报告都写着 `src/runner/catalog-snapshot.test.ts > deepseek` 在自己的 worktree 里红，并各自判定「与本卡无关，属本机环境差异」绕了过去 | 不是环境差异。`pi --offline --list-models <provider>` **按 model id 子串过滤，不按 provider**：本机 command-code 供 `deepseek/deepseek-v4.1-flash`，问 deepseek 就把这一行打了出来，于是「采到的 deepseek 目录」混进别家的模型，漂移测试必红。更远的影响是 `resolveModel` 的 id 自校验——一个 model id 会被对着并不供它的 provider 校验通过 | 从 `R237511TD` 的 Epic 分支（`60fa2ce`，那张卡在自己分支上修了但合不回来，见 W-50）移植：`PiModelCatalog.list` 过一道 `keepOwnProvider`，只留 provider 字段等于所问那家的行。抽成导出的纯函数并单测（两家各一行、id 互相包含），行为来源写在注释里 |
| W-52 ✅ | `S-R237511TD-01` 的 VERIFY 第 4 轮被判 8 个场景全部失败——理由是「这些场景没有留下任何可观察的证据」。而证据是有的：02:57:45 那次测试运行点名了每一个场景，只是会话在 03:11:58 断了、`continue` 续上之后，前半段的事件一条都没进轨迹 | `promptWithContinueRetry` 每次 `promptOnce` 只报它自己产生的事件，而重试直接 `result = await promptOnce(runner, "continue", ...)` 覆盖——被中断那次跑过的测试、开过的页面、花掉的 token 全部丢弃。三处后果：盲审读到空轨迹判「没有证据」；`cost.perCardUsdCeiling` 读同一份 usage，于是每断一次就少记一截；规范日志缺掉那一段。不止 VERIFY，所有 phase 共用这条路 | 从 `R237511TD` 的 Epic 分支移植（`5c41cf9`，同 W-50/W-51 的出处）：events 累积、usage 相加，两个提前返回改成 `break` 走同一个出口。事件逐条 push 而不是展开——一个重工具的 turn 会发几万条，spread 过不了参数上限 |
| W-53 ⬜ 待决策 | `R237511TD` 的 Epic 分支上有一个提交（`44e5bf7`）新建了 `vitest.setup.ts`，**改掉 vitest 的 `.resolves` 行为**，让 SPECIFY 冻结的那条 `expect(await listPendingTodos(client)).resolves.equal([])` 能过——`await` 已经把 promise 解开了，`.resolves` 在一个非 promise 上必然报错，这条断言**照它写的样子跑不起来** | CODE 不许改冻结测试（对的：改了就等于自己给自己降判据），但**冻结的契约写错时没有任何出路**。那张卡的选择只剩三个：删掉这条检查（丢掉 SPECIFY 量到的东西）、改冻结测试（越线）、或者改测试框架去迎合它——它选了第三个，而第三个是三个里最坏的，因为它改的是**所有卡共用的**那把尺子 | 需要一条「冻结契约本身有问题」的回路：CODE 发现契约无法成立时能把它退回 SPECIFY 重写一条（带理由、不耗内环轮次，与出口 handback 同构），而不是让卡在三个坏选项里挑。这是新增一条状态转移，属设计改动，等 Ryan 定；在那之前先把现象记在这里 |

---

## 贯穿性事项（不属于单一里程碑）

| 事项 | 约束 |
|---|---|
| R-5 移植重审 | 每个移植 PR 必须声明 single-process 假设重审结论（见使用约定） |
| 设计偏离回写 | 实现与 00–06 设计偏离时，先改设计文档再改代码，同 PR 提交 |
| fixture 资产累积 | M0 起采集的 RPC 错误/usage-limit/Notion 行为 fixture 全部入仓，契约测试永续使用 |
| 验证证据归档 | 每个验收任务的轨迹/截图/SQL 核对记录归档 `docs/poc/`，清单行末回填链接 |
| 一机一账号纪律 | 任何时候不复制 auth.json 跨机（refresh token rotation 会互踩报废）；新机器接入一律 device code 重新登录 |
