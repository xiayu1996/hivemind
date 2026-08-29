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
| M2 | 并行与回归：多 Story Epic + 常驻 E2E loop | 14 | M2-14 带依赖 Epic 并行 + 回归物化归因 |
| M3 | 多机化：capability 队列 + Mac mini 接入 | 12 | M3-12 双机 Epic + 失联恢复演练 |
| M4 | 供应商矩阵与反馈闭环 | 17 | M4-17 断供演练 + 完整反馈自迭代一轮 |
| M5 | 收口：Windows worker + self-update + GA | 8 | M5-08 连续两周 7×24 无人干预 |

---

## M0 地基 PoC（~1 周）

目标：在写任何正式代码前，把设计中最贵的假设逐个证实或证伪，每个 PoC 都预先写明 fallback。

> **执行状态（2026-08-29）**：**15/16 已结案**，评审见 `docs/poc/m0-review.md`。
> Ryan 完成 Codex 授权后，凭据类阻塞全部解除（C1/C3/C4 活体 + prompt 三臂对照均已跑通）。
> M0-06 已在目标 Windows 完成 10/10；仅余 M0-15，待 Mac mini 接入后执行。
> M0-01（账号策略）与 M0-09（@mention 推送确认）待 Ryan，但均不阻塞 M1。
> 状态列：✅ 通过 · ⚠️ 部分（机制已证，活体待跑）· ⛔ 阻塞

| ID | 任务 | 输出物 | 验证方式 | 前置 |
|---|---|---|---|---|
| M0-01 | ⛔ **账号策略拍板（Ryan 决策项）**：一机一账号（Linux + Mac mini 各一个 ChatGPT 账号，06 文档方案 A）vs 单账号 broker（方案 B） | 00-overview §2 决策表新增一行 | 人拍板并落文档；若选方案 A 完成第二订阅购买 | — |
| M0-02 | ✅ pi 安装与 pin：安装脚本将 pin 版本装入 `~/.hivemind/pi/<version>/` 并排目录；GLM(zai)/Grok(xai) key 配置就绪 | `scripts/install-pi.sh` + README 版本记录 | 全新环境执行脚本后 `pi --version` 等于 pin 值；zai/xai 各发一条最小 completion 成功 | — |
| M0-03 | ✅ PoC-2a：RPC Context 导出/载入 | `poc/rpc-context/` 脚本 + `docs/poc/poc-2-context.md` | 导出 Context JSON → 新进程载入 → 再导出，两份 JSON 语义 diff 为空；载入后续跑一轮回答与原上下文连贯 | M0-02 |
| M0-04 | ✅ PoC-2b：mid-run 注入 / abort / resume 能力 | 同上报告附录 | run 中 abort 后同 session 注入消息续跑成功；不支持则报告记录降级路径（extension turn 边界序列化 / json 模式 + phase 边界注入）并回写 02 文档 | M0-03 |
| M0-05 | ✅ PoC-5：RPC 错误事件目录——人为制造 AUTH（坏 key）/ RATE_LIMIT / TRANSPORT（断网）/ INVALID_REQUEST 四类错误并采集结构化事件 | `fixtures/rpc-errors/*.json` + `docs/poc/poc-5-error-catalog.md` 错误模式表初稿 | 每类 ≥1 个真实样本；草拟的分类规则能对全部样本唯一分类 | M0-02 |
| M0-06 | ✅ PoC-1：Windows Git Bash 下 pi RPC 冒烟 ×10（含工具调用任务） | `scripts/smoke-windows-rpc.ts` + `docs/poc/poc-1-windows.md` | 10/10 无 CRLF 分帧错误、无挂死；不过则报告中拍板降级为纯 Playwright 探针执行器 | M0-02 |
| M0-07 | ✅ PoC-4：pi 默认 prompt vs 自建基线 A/B——3 张真实小卡各跑两条轨迹 | `docs/poc/poc-4-prompt-ab.md`（评分表 + 结论） | 每卡两条完整轨迹归档；盲评人（Ryan）不知分组；结论明确采用哪条基线 | M0-02 |
| M0-08 | ✅ R1：Notion 评论 resolve 行为实测——`comment.updated` webhook 是否覆盖 resolve、list comments 对已 resolve 评论的可见性 | `docs/poc/notion-behavior.md` | 得出明确结论并回写 01 文档（是否需要"agent 回评确认后人再 resolve"协议约定） | — |
| M0-09 | ⛔ R2：API 创建评论中 @mention 是否触发移动端推送 | 同上文档补充 | Ryan 手机实收推送截图归档；不触发则 needs_input 旁路告警升级为必选路径并回写 01 文档 | — |
| M0-10 | ✅ Notion 页面规模与 mermaid 实测：300+ block 页面写入/读取、mermaid 渲染语法子集 | `docs/poc/notion-behavior.md` + `docs/poc/evidence/` | 300 块页面创建与更新无 API 拒绝且耗时可接受；子集内每种图渲染截图归档 | — |
| M0-11 | ✅ PoC-C1：Codex device code 无头登录 + 自动刷新（Linux） | `docs/poc/poc-c-codex-oauth.md` | 登录后 RPC 跑通一轮；token 逼近过期后自动刷新，auth.json expires 更新且无人工介入、无 invalid_grant | M0-01, M0-02 |
| M0-12 | ✅ PoC-C2：usage-limit 撞墙文案采集与解析 | 分诊正则 + `fixtures/codex-usage-limit.json` | 正则从真实 errorMessage 解析出 reset 分钟数 | M0-11 |
| M0-13 | ✅ PoC-C3：`pi auth check --json --no-refresh` 探针零副作用确认 | 同上文档补充 | 连续调用后 auth.json mtime 与内容不变 | M0-11 |
| M0-14 | ✅ PoC-C4：同机双 pi 子进程并发刷新锁 | 同上文档补充 | 双进程逼近过期并发请求，文件锁生效，两进程均成功且无 invalid_grant | M0-11 |
| M0-15 | ⛔ PoC-C5：Mac mini LaunchAgent 用户会话下登录态持久性 | 同上文档补充 | 机器重启后 `pi auth check` 仍 ok | M0-01, M0-11 |
| M0-16 | ✅ **M0 评审与设计回写**：逐项 go/no-go，启用降级路径的更新对应设计文档 | `docs/poc/m0-review.md` + 00/01/02/06 文档修订 commit | 00-overview §6 风险表每个 M0 覆盖行标注"已证实 / 已证伪 / 降级路径已启用" | M0-03..15 |

---

## M1 单机闭环

目标：Linux 单机上 orchestrator + worker + guard + Notion 双 DB，跑通一张真实卡全流水线；控制台骨架同期上线（调 PoC/prompt 需要这个读面）。

> **执行状态（2026-08-29，Windows）**：29/37 已验证，7 项实现完成但真实外部服务验收待凭据，M1-37 未开始。
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
| M1-17 | ⚠️ DB bootstrap：脚本创建 Stories/Epics 两 DB 全属性（select 方案）+ board view 人工 bootstrap 手册 | `scripts/notion-bootstrap.ts` + 手册 | schema/调用契约单测通过；当前 Windows 无 `~/.hivemind/secrets.env`，空 workspace 活体待跑 | M1-15 |
| M1-18 | ⚠️ Story 页 builder：五锚定区段 + blockId 持久化 + 区段内 diff 原位更新 + 验证轮次 toggle 只追加（>8 轮归档子页） | `src/notion/blocks/` | diff/锚点/归档单测通过；真实 Notion 页连续 3 轮更新待 M1-17 活体 | M1-16, M1-17 |
| M1-19 | ⚠️ 评论水位 ingest：`comment_watermark`（created_time 水位 + 2min 回看 + comment_id 唯一去重） | `src/notion/comment-ingest.ts` | 重叠窗口、块锚点、bot 过滤与事务水位单测通过；真实评论秒级入库待凭据 | M1-02, M1-15 |
| M1-20 | ⚠️ webhook 接收 + 轮询兜底：page.properties_updated / content_updated / comment.created + 活跃集 60s 轮询收敛 | `src/notion/sync.ts` | webhook 签名/去重与关闭 webhook 后轮询逻辑单测通过；真实 workspace 收敛待凭据 | M1-19 |
| M1-21 | ⚠️ 意图解释器 v1：属性影子值比对判人工指令 → 拖列/评论基础语义（回答阻塞/继续开发/人工停靠/恢复）+ 120s human-wins window | `src/notion/intent-interpreter.ts` | 表驱动单测通过；真实拖列与 120s human-wins 活体待凭据 | M1-19, M1-23 |
| M1-22 | ⚠️ 图片管道：本地 evidence store → 异步 File Upload（≤20MB）→ 失败降级文字占位不阻塞 | `src/notion/media.ts` | 大小/类型/异步降级单测通过；真实截图上传待凭据 | M1-16 |

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
| M1-35 | ⚠️ 旁路告警通道：飞书 webhook / 邮件；needs_input 与 P0 级走此通道（Notion 故障时的唯一出口） | `src/alert/` | 双通道契约/部分失败/脱敏单测通过；无 webhook/SMTP 凭据，真实推送待跑 | M1-01 |
| M1-36 | ✅ 控制台骨架：Fastify 挂 Vue3+Vite SPA（仅内网）+ 节点健康页 + 任务视图（EventLog 时间线 + trace HTML）+ 成本只读 + config 只读 + Bull Board 挂载 | `src/console/` + `console-ui/` | Windows loopback 实际数据启动；内置浏览器四页与只读 Bull Board 检查通过；公网通配绑定被拒 | M1-32, M1-33 |

### M1-J 验收

| ID | 任务 | 输出物 | 验证方式 | 前置 |
|---|---|---|---|---|
| M1-37 | ⛔ **M1 端到端验收**：一张真实卡从 Notion 建卡 → DESIGN → CODE⇄VERIFY → MERGE → MR 创建全程无人干预 | `docs/poc/m1-acceptance.md`（进行中） | 当前 Windows 无 Notion/告警/provider 凭据，真实卡与 Notion 页面判据尚不能执行 | M1-01..36 |

---

## M2 并行与回归

目标：Epic 拆解 + 多 Story 并行 + epic 集成分支合流 + 常驻 E2E 双池回归；控制台开写面，重试上限族全量接入。

| ID | 任务 | 输出物 | 验证方式 | 前置 |
|---|---|---|---|---|
| M2-01 | DECOMPOSE phase：Epic → Story 拆解 + `depends_on` + `predicted_footprint`（目录/模块粒度，刻意不用文件粒度）+ 业务语言 lint（Spec 不得含实现词汇） | `src/orchestrator/decompose.ts` + prompt | 3 个真实 Epic 拆解产物过 schema 校验；lint 单测拦截含代码词汇的 Spec 行 | M1-37 |
| M2-02 | PLAN_APPROVAL 人批 gate：拆解结果贴 Notion，人批准前 Epic 不进 EXECUTING | 状态机扩展 + Notion 呈现 | e2e：未批不动；批准（拖列/评论）后启动 | M2-01 |
| M2-03 | footprint 调度纯函数：拓扑序 + footprint 两两相交判定 + hotspot 命中强制串行 + 环检测 | `src/orchestrator/scheduler.ts` | 表驱动单测：相交/不相交/hotspot/依赖环/混合场景 | M2-01 |
| M2-04 | hotspot 清单资产化：config 键承载（路由表/i18n/schema 等），随项目演化持续增补 | config 键 + 文档 | 修改 config 后下一次调度决策立即反映（单测） | M1-03, M2-03 |
| M2-05 | epic 集成分支 + 合流：`epic/<id>` cut、Story 分支 rebase onto epic HEAD、agent 现场解冲突、子集重验（本 Story + footprint 相交 Story 场景）、依赖 Story 延迟 cut | `src/vcs/merge-flow.ts` | e2e：两张有依赖的 Story 顺序合入；人为制造冲突验证解冲突 + 子集重验路径 | M2-03 |
| M2-06 | Epic 单 MR + 分支保鲜：commit 按 Story 分段保留 red/green、文案按 Story 分章；epic 分支每日 merge main；>8 Story 提示人拆 Epic | MR 生成扩展 + 定时任务 | MR 内 commit 序列可辨认每个 Story 的 red→green；定时 merge 日志；9 Story Epic 触发提示 | M2-05, M1-30 |
| M2-07 | actual_footprint 回写 + 预测偏差率指标 | 合入钩子 + stats 投影扩展 | 合入后 DB 有 actual 值；偏差率出现在控制台统计页 | M2-05 |
| M2-08 | 场景注册表：scenario_id → owner_story / 所属池 / 最后验证时间 | `src/regression/scenario-registry.ts` | schema 单测 + Story 交付时场景自动登记 e2e | M1-24 |
| M2-09 | RegressionScheduler 双池：活跃 epic 池（epic HEAD）+ main 历史全集池（低频）；事件触发 + 空闲 LRU 轮询 + 让位前台任务 | `src/regression/scheduler.ts` | 排程决策纯函数单测；e2e：Story 合入后该 epic 全量场景自动排一轮 | M2-08 |
| M2-10 | 样本级统计判定 + 失败签名：单次失败标 suspect 连排 N 次复测、窗口失败率超阈值才立卡、`(scenario_id, failure_signature)` 唯一索引去重 | `src/regression/verdict.ts` | 模拟 30% 随机失败的 flaky 场景不立卡；确定性失败立卡且重复失败不重复立卡 | M2-09 |
| M2-11 | 归因二分 + REGRESSION_FIX：新失败在合入序列上二分定位引入 Story → 该 Story 重开内环，队列最高优先级 | `src/regression/attribution.ts` | 3 个合入序列上人为引入回归，二分定位到正确 Story；REGRESSION_FIX 卡插队到队首 | M2-10 |
| M2-12 | 重试上限族接入：maxInnerLoopRounds(6) / maxPhaseReentries(3) / maxContinueRetries(8) / maxRegressionReopens(2) 全部 config 化热更；到限 → `retry_limit_exceeded` 真停点 + 卡置失败 + 诊断报告（需求侧 vs 系统侧两分法）+ Notion @创建人附收敛曲线 | `src/pipeline/retry-limits.ts` + 诊断报告生成 | 每个上限用故障注入逼到限：卡置失败、Notion 收到 @ 通知、报告含收敛曲线与两分法结论；系统侧结论触发 friction 物化 | M1-25, M1-07 |
| M2-13 | 控制台动态配置写面：zod schema 生成表单 + config_history 全量留痕 + 一键回滚 + `config.changed` EventLog 事件 + 高危键二次确认 | 控制台配置模块 | e2e：改 maxInnerLoopRounds 热生效于下一轮判定；回滚恢复旧值；非法值保存被拒；急停键有二次确认 | M1-36, M2-12 |
| M2-14 | **M2 验收**：一个 3+ Story 带依赖真实 Epic 并行执行至 Epic MR；E2E loop 常驻期间人为引入一处回归被自动物化、归因、修复 | `docs/poc/m2-acceptance.md` | ① 并行调度符合 footprint 判定（轨迹核对）；② 合流子集重验留痕；③ regression 卡自动立卡→归因→REGRESSION_FIX→修复合入；④ 重试上限演练记录齐全 | M2-01..13 |

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
