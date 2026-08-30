# hivemind 系统设计总览

> 状态：2026-08-22 设计冻结。详细设计见同目录 01–04 文档。

## 1. 背景与动机

busybee（Claude Agent SDK + 公司内部看板）已 7x24 稳定运行数月，但有两个战略性限制：

1. **供应商锁定**：深绑 Claude 生态（claude_code preset / settingSources / skills / session fork），未来需要 Codex、GLM、Grok 等多供应商。
2. **公司基础设施绑定**：内部看板、内部配置中心、内网告警通道，无法服务个人/通用场景。

hivemind 以 pi（earendil-works/pi，provider 无关）为执行底座、Notion database 为唯一人机界面与内容归档空间、git 仓库为代码归档，构建"接需求 → 拆解 → TDD 开发 → 五层测试 → 交付 → 反馈自迭代"完整闭环，应对 web 全栈 + 未来移动端。人几乎不写代码，Notion 内容以可读性为第一追求。

## 2. 关键决策（2026-08-22 冻结）

| 决策点 | 结论 |
|---|---|
| 项目形态 | 全新独立仓库；busybee 继续独立跑公司任务；移植 busybee 约 60% 基础设施代码 |
| agent 拓扑 | 编排式流水线 + 解耦并行（CODE 按有意义粒度并行；E2E 持续 loop 回归，非一次性 phase） |
| 多机策略 | day1 多机分布式：orchestrator 常驻 Linux 主机；Mac mini = UI-e2e/浏览器/未来 iOS worker；Windows = Windows 侧探针 worker |
| 隔离边界 | 裸机 + 工具面守卫（danger-rules → pi tool_call hook + worktree 隔离 + 全量审计），容器化留作后续加固 |
| 试点项目 | 个人新项目（GitHub）：MR 适配器优先 gh，glab 复用为第二适配 |
| day1 供应商 | Codex（ChatGPT 订阅 OAuth）+ GLM（zai key）+ Grok（xai key）；无 Claude 凭据，opus/sonnet 作为预留映射列 |
| 成本策略 | 软护栏（日/月阈值告警不阻断）+ 全量成本账本；可观测性重点设计（借鉴 deepseek-harness） |
| Web 控制台（08-25 增补） | day1 提供内网运维面：节点健康（IP/机器指标）、动态配置、Prompt 工作台、成本/统计。Notion=业务面，控制台=运维面 |
| 重试上限族（08-25 增补） | 收敛判据提前停 + 可配置硬上限最终停（上限设在离散重试轮次，不设在单次运行时长/token）；到限即失败 + 诊断报告 @人（需求侧 vs 系统侧两分法） |

## 3. 调研结论摘要

### pi（v0.84.x，pin exact）

- **给**：40+ provider 抽象（anthropic/openai-codex/zai/xai 原生）、Context 纯 JSON 跨供应商 handoff、extension 钩子（tool_call 可 block / before_provider_request / session_before_compact）、原生 CLAUDE.md/AGENTS.md 层叠 + skills（agentskills.io 规范，可直接挂 ~/.claude/skills）、RPC/JSON headless 入口、per-message 成本。
- **不给（自建 harness）**：MCP（社区有 pi-mcp-adapter）、subagent 编排、权限/沙箱、任务队列、跨供应商 failover、预算护栏、observability exporter、崩溃恢复编排。
- **风险**：pre-1.0 SDK 不稳、session JSONL 尾部损坏 open bug（#8345/8346）——对策：RPC 模式 + 自建 Context checkpoint，session 文件当可丢弃缓存。

### cumora（拿模式不拿拓扑）

不采用对等多 agent：其实证结论是协调正确性是概率性的、治理成本极高（46KB 反模式文档 + 6 层服务端 gate 才稳住基本协作）。直接移植的模式：builder/verifier 分离靠约束强制、completion verifier（小模型 fail-closed 裁判）、失败自动物化成 regression/friction 资产、大脑/小脑模型强制（enforceModelPolicy + 全量成本账本）、行为回归测试用样本级统计判据。

### busybee 生产教训（设计硬约束）

验证方式不可硬编码；验证造假需三层防御（prompt / 工具面物理掐断 / verdict 代码校验）；人为 turn/时长/预算上限只伤真实工作（用静默 watchdog + 收敛判据）；全局故障熔断不逐卡烧人工；HUMAN_PARKED 优先于所有权；memory 进料通道需闭环流速观测；md+DB 双写是漏账源头。

### deepseek-harness（dsh，DeepSeek 官方 harness）

借鉴其可观测子系统：事件溯源规范日志 → 投影 → 导出三层架构、TokenUsage 四桶互斥归一、emit() 非阻塞边界、invariants 运行期自检注册表、repeat-tool 循环检测。**补它明确 defer 的两个缺口**（USD 成本账本、durable 上报 outbox）+ 子 agent 结果契约必须带 usage（它的黑洞教训）。详见 04-observability.md。

## 4. 总体架构

```
                   ┌────────────── Linux 主机（常开, systemd）──────────────┐
 Notion 看板 ◄───► │ Orchestrator（确定性状态机 + intake + NotionGateway）    │
 (webhook+轮询)    │ Redis(BullMQ) · 中央 libsql（执行真相源/EventLog/账本）  │
                   │ RegressionScheduler(E2E loop 排程) · 状态 API/Bull Board │
                   └──────┬──────────────────┬──────────────────┬───────────┘
                    cap.web             cap.browser-e2e     cap.windows       ← capability 队列
                                        cap.ios(未来)
                   ┌──────▼─────┐      ┌──────▼──────┐     ┌──────▼──────┐
                   │Linux worker│      │Mac mini      │     │Windows      │
                   │[web]       │      │[web,browser- │     │[windows,    │
                   │            │      │ e2e,ios(后)] │     │ browser-e2e]│
                   └── pi 子进程(--mode rpc) + hive-guard extension ─────────┘
```

两条脊柱决策：

1. **job = 整卡（Story）而非单 phase，卡对主机粘性**：worktree/构建缓存/Context 快照都在本地盘；worker 本地跑完 DESIGN→CODE⇄VERIFY→MERGE 全内环，phase 边界经 orchestrator API 回报中央 DB + 续租；跨平台验证建模为独立"探针 job"（对已 push 分支只读 clone + e2e + 回传证据），不打破粘性。
2. **字段级单向所有权的真相源模型**：中央 libsql 是系统状态/执行历史的唯一真相源；Notion 是人类输入的诞生地 + 唯一 UI。系统 owner 字段只由 orchestrator 写，人为改动解释为"指令/反馈"而非状态；人 owner 字段只被 ingest。同一字段永不双向合并 → 结构上无冲突，由单写者架构直接支撑（Notion 读写全部收敛在 orchestrator 的 NotionGateway，worker 永不直连 Notion）。

## 5. 实施路线图

| 里程碑 | 内容 |
|---|---|
| **M0 地基 PoC**（先证伪最贵假设，~1 周） | pi RPC Context 导出/载入（PoC-2）、Windows Git Bash 冒烟（PoC-1）、RPC 错误事件结构（PoC-5）、Notion 评论 resolve 丢失与 @mention 通知实测（R1/R2）、pi 默认 vs 自建 prompt A/B（PoC-4）、**Codex OAuth 五项（PoC-C1–C5：device code 登录/自动刷新/usage-limit 文案解析/无副作用探针/同机并发锁，06 文档 §9）** |
| **M1 单机闭环** | Linux 上 orchestrator + 本机 worker + guard extension + Notion 双 DB + Story 页 builder，跑通 1 张真实卡全流水线（TDD 红绿证据链 + 盲审 + completion verifier + Notion 报告回写）；**Web 控制台骨架**（节点健康 + 任务视图 + 成本/config 只读） |
| **M2 并行与回归** | DECOMPOSE 拆解 + footprint 调度 + epic 集成分支合流 + 常驻 E2E 双池回归 + regression 物化；**控制台动态配置写面 + 重试上限族接入** |
| **M3 多机化** | capability 队列 + 派单信封 + 心跳失联 + 中央租约 + Mac mini（浏览器 e2e worker）接入 |
| **M4 供应商矩阵与反馈闭环** | per-provider 熔断 + failover + 模型策略双 chokepoint + 成本账本 + 反馈 triage/friction/反思提案 + memory 投影；**Prompt 工作台完整版（灰度 + 行为回归对比）+ 供应商健康页** |
| **M5 收口** | Windows 探针 worker + 三平台 self-update 滚动升级 + 行为回归统计基线 + 运行周报 |

## 6. 风险与 PoC 清单

| # | 风险/假设 | 级 | 处置 |
|---|---|---|---|
| R0 | ChatGPT 订阅 OAuth 的 ToS/断供风险（OpenAI 官方 Codex for OSS 背书 pi，但背书是容忍非合同；Anthropic 已有关门先例） | 高 | 一机一账号（避开风控画像 + refresh rotation）；failover 链 day1 配好；凭据探针最早发现。详见 06 文档 §8 |
| PoC-2 | RPC 能否导出/载入 Context JSON + mid-run 注入/abort/resume（checkpoint+failover+纠偏基石） | 高 | 实测（含 Windows CRLF 分帧）；fallback: extension turn 边界序列化 + before_agent_start 注入重建；不支持注入则降级 json 模式 + phase 边界注入 |
| R1 | 人快速 resolve 评论致反馈丢失（list comments 只返回未 resolve） | 高 | 实测 comment.updated webhook 是否覆盖 resolve；不覆盖则约定"agent 回评确认后人再 resolve"+缩短轮询 |
| R2 | API 评论中 @mention 是否真触发通知（needs_input 依赖） | 高 | 实测 |
| PoC-1 | pi 在 Windows(Git Bash) RPC 稳定性 | 高 | 冒烟×10；不过则 Windows 降级纯 Playwright 探针执行器（架构已预留） |
| PoC-4 | pi 默认 prompt vs 自建基线质量 | 高 | 3 张真实卡 A/B 盲评 |
| R-5 | busybee 单机不变量（obliterate/本地 lease）被无意识照搬 | 高 | 评审 checklist：凡注释含 single-process 的资产必须重审 |
| 反思提案改坏系统 | — | 高 | 人批唯一开关 + 行为回归统计验证 + 可回滚 |
| footprint 预测漂移 | — | 中 | 目录粒度 + hotspot + 偏差率校准 + 子集重验兜底 |
| webhook 不可靠/水位粒度 | — | 中 | 轮询兜底 + 重叠回看 + id 去重（已设计） |
| Notion 页面 block 膨胀/mermaid 渲染子集 | — | 中 | PoC 实测 300+ 块页面；输出安全 mermaid 语法子集约束 |
| RPC 协议 pre-1.0 漂移 / MCP 社区扩展存续 | — | 中 | pin + fixture 契约测试 + PiRunner port；vendor 进仓 + defineTool 备胎 |
| E2E flaky 淹没 regression | — | 中 | 样本级统计 + 失败签名去重 |
| epic 分支长命偏离 / 大 MR 人审负担 | — | 中 | 每日 merge main；Notion 为主审阵地 + >8 Story 提示拆 |
| Redis/Linux 单点、GUI 会话自动登录安全弱化 | — | 低 | 接受：中央 DB 为真相源可重建；盘加密 + 内网隔离 |

## 6.5 M0 执行结果（2026-08-27）

完整评审见 `docs/poc/m0-review.md`。总体：**架构无致命证伪，可进 M1**。

| 风险/假设 | 结论 |
|---|---|
| PoC-2 Context 导出/载入 | PASS，但**无 RPC 载入命令**，checkpoint 必须保留 session JSONL |
| PoC-5 错误事件结构 | PASS，单一提取契约（`stopReason==="error"` → `errorMessage`）+ 需优先级分类 |
| R1 评论 resolve 丢失 | **原方案被证伪**：REST 永久取不回已 resolve 评论，协议已改 |
| （新增）块级评论可见性 | **高影响**：按 page_id 拉取取不到 Spec 行上的评论，轮询改按锚点 blockId |
| Notion 块膨胀 / mermaid | PASS，300 块 + 大页定点更新 + 锚点保全 + 三种图含中文均渲染 |
| PoC-4 prompt | 默认 prompt 已量化，结论由"替换"改为"**追加**" |
| Codex OAuth C1–C4 | 机制核实通过（登录入口在 TUI 非 CLI；auth check 退出码陷阱），活体待 M0-01 决策 |
| PoC-1 Windows | **PASS（2026-08-29 补测）**：Git Bash 下真实 pi RPC + 工具调用 10/10，无 framing 错误或挂死 |
| C5 Mac mini | **未执行**：目标机尚未接入；顺延至 M3 |

阻塞 M1 的只剩 **provider 凭据**（GLM/Grok key 或 Codex 登录）。

## 7. 验证策略

- **M0**：每个 PoC 有明确判据（RPC Context 往返 diff 为空、Windows 10 次冒烟全过、@mention 手机收到推送等）。
- **M1 验收**：一张真实卡从 Notion 建卡到 MR 创建全程无人干预；Notion 页面呈现完整（Spec 状态/设计/验证 toggle/成本）；EventLog/trace/成本账本三面可查；danger-rules 拦截注入测试（故意让 agent 试红线命令，被 block 且审计留痕）。
- **系统自测**：纯函数决策逻辑（收敛判据/footprint 相交/拓扑调度/triage 路由/去重键/业务语言 lint）全部单测；Notion client 与 PiRunner 用罐头回放契约测试；prompt/规则变更走样本级统计行为回归（N trials 置信区间，nightly，不 gate PR）。

## 8. busybee 移植资产索引

| 类别 | busybee 源 | 移植方式 |
|---|---|---|
| 队列 | src/queue/（jobId 幂等/requeue 坑/removeOnComplete 教训） | 移植 + 多机化改造（obliterate 上移 orchestrator） |
| 租约 | src/persistence/lease.service.ts（CAS 条件更新） | SQL 语义原样，库上移中央 libsql |
| worktree/MR | src/worktree/（tree-pin/quarantine/mr-plan） | 原样移植 + gh adapter 优先 |
| 守卫 | src/agent/hooks/danger-rules.ts（零依赖纯函数） | 原样 + Windows 路径 normalize + gh 红线 |
| 证据/报告 | src/verify/evidence-store + src/report/ | 移植；HTML 报告改写为 Notion block builder |
| memory | src/memory/ 全套 | 整体移植；md 双写改"整页重建投影" |
| observability | src/observability/（constants/truncate/trace-html 零改动） | tracer 重写为投影 unit（~250 行） |
| 失败处理 | escalation-policy / run-failure / CredentialHealth / StallWatchdog | 移植；熔断扩展为 per-provider 矩阵 |
| 自更新 | src/self-update/（drain→build→handshake） | 骨架保留，跨平台 relaunch 抽象 + 滚动升级 |
