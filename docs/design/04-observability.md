# 可观测性与成本账本设计

> 参考对象：deepseek-harness（dsh，DeepSeek 官方 agent harness，事件溯源可观测路线）。**策略：抄它的分层与契约，自建它明确 defer 的两件事（USD 成本账本 + durable 上报 outbox）——这两件在 24x7 多机场景是必需品。** busybee 的 OpenInference 埋点资产（constants/truncate/trace-html/recorder）继续复用，但角色从"主存储"降级为"投影读面之一"。

## 1. dsh 调研结论速览

- dsh 的可观测 = 会话事件日志（append-only，turn/step 坐标）→ ProjectionDefinition 投影 → OTel Logs 导出，**明确拒绝 span 模型**（理由：对 forkable/interruptible 会话有损）。hivemind 的 phase run 是无状态全量注入（无 fork），span 作为读面仍然成立——所以采"事件日志为规范真相 + span 树为投影"的折中。
- dsh 的缺口（不能抄）：**只有 token 没有钱**（主动清零 pi-ai 的 ModelCost）、无跨会话聚合、SubagentResult 无 usage 字段（子 agent 消耗黑洞）、telemetry 投递 at-most-once（durable outbox 被 defer）、零内置脱敏规则、无 dashboard。

## 2. 三层模型

### 2.1 规范日志（worker 本地，唯一事实源）

每次 pi run 的 RPC 事件 tee 成 append-only `run-events.jsonl`（原子写）。事件 envelope：

```ts
{ type, seq /*run 内单调*/, time /*epoch ms*/, data, ignorable?: true }
```

- 层级用 **turn/step 数值坐标 + 成对开闭事件**（turn = 一次 prompt 轮；step = 一次模型调用 + 它请求的工具执行），不用 span id/parent id。
- 两条铁律（dsh 移植）：
  1. **Model-visible ⟺ logged**：任何进入模型请求的东西必须能从日志重建；`request/header` 记完整 system prompt + tool schemas 快照，`request/context` 记 provider/model/contextWindow（只在路由或容量变化时记）——从日志能精确知道"这个 step 用的哪家哪个模型、prompt 长什么样"。
  2. **未知事件 required-on-read**：读到不认识的 type 且无 `ignorable: true` → 拒绝重建，不静默跳过。
- `turn_end.reason` 可扩展 sum type：`completed | aborted | blocked | error | max-tokens | interrupted`——**`interrupted` 只由崩溃恢复的基础设施补写**（不截断已持久化事件，补一条合成 turn_end）。接收端判据：shutdown 标记缺失 = 崩溃；标记之后又来事件 = reload。

### 2.2 投影（ProjectionDefinition 读模型）

```ts
interface ProjectionDefinition<K, S> {
  key: K
  init(): S
  apply(state, event): S   // 纯、同步；不关心的事件必须返回同一引用 → 下游零工作
  view(state): Value       // state → wire 整值
  stateVersion: number     // bump 即丢弃旧缓存，不迁移
}
```

- registry 只订阅一次事件流，把每个已提交事件喂给所有 unit；读面收成品值，从不自己 fold。state 必须 plain JSON（持久缓存前置条件）。
- 持久缓存 `(runId, key, ver, seq, val)` 是 **fold 快捷方式而非权威**——可能过期（seq 精确说明过期多少）但绝不会错；写失败 fail-soft；**日志先落盘、缓存后落盘**（崩溃只会让缓存落后不会超前）。
- 首批投影 unit：tokenUsage（四桶）、cost、stats、phase 摘要、**trace 树**（busybee agent-tracer 重写为投影 unit，~250 行；trace-html/truncate/openinference.constants 零改动复用；HTML 读面 + bb-trace 式 skill 保留）。
- 好处：新增一个指标 = 新增一个 unit，不动埋点不动读面；冷读 O(1)。

### 2.3 上报与导出（worker → orchestrator）

- **emit() 边界公理**（dsh 契约）：采集处非阻塞入队、零 I/O，批处理/重试/排队策略全部属于传输层；上报路径的任何失败**永不影响 agent 循环**；本地只保留"已交接"水位（丢了不是错误，靠接收端去重吸收）。
- **固定 chunk 投影**：每 (turn, step) 只上报第一个 assistant/chunk（"流已开始"信号），其余在采集处丢弃。`step_start + 首chunk有无 + assistant_message有无 + turn_end.reason` 四信号组合可区分"请求未开始 / 流中途死 / 正常完成"，且 TTFT 仍可算——不传 chunk 洪流，本地 JSONL 仍全量。**seq 有洞是常态，洞永远不是丢失信号。**
- **durable outbox（dsh defer、我们必建）**：worker 本地 spool + per-sink cursor + at-least-once；orchestrator 端按 `(runId, seq)` 去重——与 Notion outbox 同一套模式复用。
- 脱敏：record waterfall 扩展点，只作用于导出副本，**规范日志永不改写**；"receiver-side redaction ships the secret first"——机制在进程内，策略（什么算密钥）归部署方即我们自己写。

## 3. 成本账本（dsh 缺口，自建）

- **TokenUsage 四桶互斥**归一：`uncachedInputTokens / outputTokens / cacheReadTokens / cacheWriteTokens`（reasoning 是 output 细分不重复加；计费 input = uncached + cacheRead + cacheWrite）。在 provider adapter 边界一次性归一（"报 0 归一成缺失"等细节照抄 dsh mapUsage），下游全 provider-neutral。**cacheRead/cacheWrite 单价不同，绝不折进 input**——折了就永久失去准确定价能力。
- pi 每消息自带 `usage.cost`（dsh 清零弃用，我们直接消费）→ `cost_entries(cardId, phase, purpose, tier, provider, modelId, hostId, runId, tokens 四桶, costUsd, ts)`，append-only。
- **子 agent/探针 job 的结果契约必须带 usage/cost 字段**（dsh SubagentResult 黑洞教训），跨机上卷中心。
- 数据面三件：cost_entries 表直查；`GET /costs?groupBy=card|phase|provider|purpose|day` 聚合 API；EventLog `cost.recorded` 事件流（实时订阅面）。
- 信号指标：**大脑花费占比**（策略被绕过/难度失控的早期信号）、**缓存丢失事件**（见下）、单卡成本 > p95×N 异常告警。
- **缓存指标不用单一命中率**（2026-09-05 实测修订）。命中率 = cacheRead/计费 input 由三个因子决定：固定前缀 P、每轮新增 d、轮数 N，零丢失时 ≈ 1 − (P + N·d)/(N·P + d·N²/2)。pi 的小前缀设计（首请求约 1–4K token，Codex CLI 约 12K）加上每 phase 独立会话（N 只有 4–8）使 hivemind 的理想上限只有 40%–70%，与 Codex CLI 交互会话的 95%+ 不可比，社区对照见 pi Discussion #6646。因此按轮落账 `turn_usage(run_id, turn, 四桶, cache_loss_tokens)`，并派生两个指标：
  - **丢失事件**：某轮 cacheRead 低于上一轮总上下文的 90% 即计一次，记录丢失 token 数（`src/observability/cache-analysis.ts`）。这是唯一表示"前缀被破坏或路由漂移"的信号。
  - **零丢失上限**：同一 run 在无丢失情况下的理想命中率，与实际并列展示；两者接近说明只剩结构性因素，差距大才值得查。
  - pi 在传输回退（WebSocket → SSE）时给 assistant 消息挂 `diagnostics`，规范日志以 `provider/diagnostics` 事件保留，用于给丢失事件归因。
- **降低每轮新增量是唯一可动的杠杆**：只读探索阶段（DECOMPOSE / DESIGN）的工具结果由 guard 策略 `toolOutputLimits` 截断（8KB / 200 行），CODE / VERIFY 保持 pi 默认 50KB / 2000 行以保留完整测试输出；仓库 AGENTS.md 以相同 label 装进 DECOMPOSE 与全部 Story phase 的 system prompt，作为跨会话共享前缀。
- **软护栏**：日/月阈值（全局 + per-provider）超限只告警不阻断；per 卡成本回写 Notion 属性。不设硬预算中断——与 StallWatchdog 同一哲学：人为上限只伤害真实工作。
- 错误归一：`AUTH / QUOTA / RATE_LIMIT / INVALID_REQUEST / SERVER / TIMEOUT / TRANSPORT` 分类表（dsh classifyPiAiError 模式，文本正则 + 优先 RPC 结构化错误码）；QUOTA 与 RATE_LIMIT 分流到 credentials/deferred 两条恢复路径（接 02 文档 §5.4 熔断矩阵）。

## 4. 行为质量与运行期自检

### 4.1 循环检测（dsh repeat-tool-reminder 移植）

- 链 key = (工具名, 深度 key 排序后 JSON.stringify 的 canonical 参数)；阈值 [3,5,8] 递进提醒（首个短提醒，后续详细版点名工具/run 长度/参数）。
- **未跟踪调用对链透明**（`grep X → todo类工具 → grep X` 仍算连续两次——记账工具穿插不能洗白循环）；**被拒绝的调用也计数**（猛砸被拒调用正是最该打断的循环）；纯建议不否决（提醒作为注入消息，tool/result 保持工具原始输出供审计）；per-agent 键控；纯内存（恢复后链清空可接受）。
- 与 StallWatchdog 互补：循环检测抓"空转"，静默检测抓"卡死"。

### 4.2 invariants 注册表（dsh 模式）

运行期自检一等公民：turn/step 配对、tool call/result 配对、状态机迁移合法、outbox 单调、lease 唯一持有——每个模块发布自己的 invariant companion（`fail(message)` 抛带包名归属的 InvariantError），regex 白名单控制生效范围，配置错误启动时大声失败。约束：**只断言权威事件流或可变数据的关系，不断言 service/方法存在**（那是类型/单测的事）；无可检查关系时空 installer 必须写包特定理由。

### 4.3 stats 投影

- llmMs = step_start → assistant_message（step 内重试等待算模型时间）；toolMs 按 callId 配对（turn 结束未配对丢弃）；ttft = step_start → 首个非空 delta（首次尝试边界穿过 step 内 retry 存活）；decode 吞吐 = decodeTokens/decodeMs。
- retry 可观测：`llm/retry`（等待前写：provider/policy key/failure/预定延迟）+ `llm/retry-started`（等待后写）事件对；retry 号只在 provider + policy key 都相同时连续，换路由重开。

### 4.4 闭环流速指标（busybee D23 教训 + dsh 无跨会话聚合的缺口自建）

memory 每轮蒸馏产出量、candidate→active 流速、场景距上次验证 p95、footprint 预测偏差率、合流冲突率、内环轮次分布、friction 率、triage 各通道流量、双 outbox 深度、429 率、**turn_end.reason 比率**（dsh 有分类无聚合，我们聚合成失败率/中断率趋势）——任一归零/超窗即告警。

读面 = 中央 libsql 聚合 + HTML 报表 + Notion 运行周报页，**不引外部 dashboard**（Grafana 等留作未来 OTLP sink 可选项：openinference 常量内联镜像上游，随时可原文外发）。

### 4.5 文档纪律（dsh 静态成本审计）

每个注入模型上下文的模块（prompt 片段/工具/skill/extension）在 README 声明 **Token effect** 与 **KV cache effect**——设计期回答"谁在烧钱、谁破坏前缀缓存"，与运行时计量互补。

## 5. 增补（2026-09-14）：观测全部旁路，三环重画

§2 已经把三层模型与 `emit()` 边界公理写对了。**实现违反了它**：`src/orchestrator/pi-phase-port.ts:335` 是 `await this.options.recordTelemetry?.(...)`，而 recorder 里是 `mkdir` + 逐条 append + DB 写。观测慢一点、盘满一次，卡就跟着挂。

还有两条设计裂缝：

- **两套事件流但本文档只承认一套**。`run-events.jsonl` 是 **agent 行为流**（§2.1 描述的就是它），`event_log` 是**编排决策流**（派单、状态转移、停点、熔断开合），前文通篇没提后者——于是有人会去错的层里找答案。两者的准入规则必须写进代码而不是靠人记：agent 在一次 run 内做了什么进前者，编排器对一张卡做了什么决定进后者。
- **投影没有推送路径**。§2.2 是纯 fold + 冷读缓存，所以"实时更新"只能靠轮询。

### 5.0 先分清：哪些写是执行真相，哪些才是观测副本

**"观测全部旁路"不等于"所有写都可丢"。** 今天有两处写既是记录、也是执行依据，把它们一并异步化会静默破坏执行正确性（2026-09-14 复审补齐）：

| 写 | 谁在**执行路径上回读**它 | 结论 |
|---|---|---|
| `cost_entries` | `cost-ledger.ts:61` 的 `cardSpend` → `run-story.ts:161` 的 `spendPort` → 每个 phase 边界的费用停点判据 | **必须可靠落库**。丢一条或读到滞后值，`cost_ceiling_exceeded` 这个真停点就静默失灵 |
| `event_log` 的部分类型 | `epic-escalation.ts:67`、`epic-blocker.ts:44/101`、`epic-page-projection.ts:53`、`requirement-store.ts` 多处读 `epic.transition` / `epic.blocker_answered` 等推导 Epic 与需求状态 | **这些类型必须可靠落库**。它们是编排决策流，不是观测流 |
| 打回理由、状态转移、停点 | 下一轮 prompt 组装与转移判定 | **必须可靠落库** |
| `run-events.jsonl` 行为流、trace、stats、缓存分析、档案/排行投影 | 无 | **可丢、旁路**，三个解耦判据只约束这一类 |

所以边界是：

> **执行状态、执行所需事件与费用结算走可靠写（同步或事务性，失败即失败）；观测副本与投影走旁路（可丢、可杀、可延迟）。**

`event_log` 因此要显式分成两类并在代码里标注准入规则：**decision 类**（可靠，执行回读）与 **telemetry 类**（旁路，仅供投影）。写入侧按类型选择通道，而不是整张表一个通道。§5.2 的"删除判据"只对 telemetry 类成立——把 `emit` 换成空函数之后，费用停点与 Epic 状态推导必须**依然工作**。

### 5.1 三环，环之间只能单向依赖

```
环 0  发射   主流程内唯一侵入点：emit(event) 同步入队，零 I/O，永不抛
  ↓（单向，不回压；buffer 满则丢最老并计数）
环 1  落盘   独立 drain 循环 → 两个 sink，各自的准入规则写进代码
  ↓（单向，可杀）
环 2  投影   三尺度级联：run 级 → card 级 → fleet 级；fleet 读 card 的成品值，不读原始事件
  ↓（单向，完全外部）
环 3  消费   控制台 / 观测者 agent / invariants 检查器
```

**丢事件是设计的一部分**：buffer 满则丢最老并计数。否则 `emit` 就有了背压，环 0 到环 1 的单向性立刻破掉。

### 5.2 三个可执行的解耦判据

不是口号，进验收：

1. **删除判据**（最硬，**仅限观测副本**）：把 telemetry 通道的 `emit` 换成空函数，`npm run typecheck` 通过、主流程行为不变，且**费用停点与 Epic 状态推导仍然正确**（§5.0）。这一条直接禁掉主流程里出现 `await recorder.<telemetry>()` 或 `if (observability.enabled)`；它**不**要求把 `cost_entries` 与 decision 类事件也变成可丢。
2. **杀进程判据**：杀掉投影进程，所有卡照常推进。
3. **延迟判据**：`emit` 的 p99 < 1ms。

### 5.3 另外三条纪律

- **采样只能在消费者侧**。采集侧丢了就永久没了；存储成本用保留期解决，不用降采样。
- **推拉并存**：`event_log` 自增 id + 投影 cursor + nudge，推送失败靠定时 drain 兜底——与派单（07 §5.3）、配置分发（05 §4.3）同一个模式。
- **`required-on-read` 要有逃生口**：envelope 加 `schemaVersion`，投影声明可处理区间，超区间按 `ignorable` 计数而非拒绝重建。否则老投影读到新事件直接死，而"老投影"在滚动升级期间必然存在。

### 5.4 主流程只做一件事：追加自描述事件

其余全部是投影。

| 观测项 | 主流程里（可靠写） | 旁路里（可丢） |
|---|---|---|
| 费用 / 缓存命中 | **可靠**写 `cost_entries`，purpose/tier 取自 `ResolvedAgentSpec`（07 §2.3）——费用停点要回读它 | 按 purpose / tier / provider / lane 聚合 |
| 停点原因 | **可靠**写带收敛分类的停点事件（03 §1.5） | 停点分布统计 |
| **跨卡打回理由聚合** | 打回时写事件（理由原文） | 复用 `src/regression/` 的失败签名归一化对准"打回理由"，出跨卡重复排行 |
| **整卡可读档案** | 无 | 从 `event_log` 重放生成，随时可跑、可重跑；控制台可看 |
| prompt 版本归因 | `phase_runs` 记 prompt 文件 sha | 行为变化按 prompt 版本对比 |

后两项是 GacUI 的 `[COUNTER]` 去重 learning 与 `Copilot_Investigate.md` 的对等物。**档案不在交付路径上生成**——交付时生成就是侵入，且一旦生成失败会挡住卡。

`src/observability/cache-analysis.ts` 的跨阶段扩展见 07 §4.7：按 `(card, lane)` 聚合，两道分开统计。

### 5.5 流程缺陷检测不是新系统

§4.2 的 invariants 注册表已经是"对权威事件流断言关系"，把流程缺陷写成 invariant 即可：

- SPECIFY 之后第一个 CODE 轮开始时，冻结测试的 `git diff` 必须为空；
- `rework` 触发后必须有 `phase.invalidated`；
- 一次执行（`card / phase / round / attempt`）的 session 文件在首次 spawn 前必须零消息（07 §4.5）；
- 同一张卡的实现道各 phase 的 `prompt_cache_key` 必须相同，且与盲审道不同；
- `verify_records` 的两列必须是两个不同的 **run 身份**，而不是"恰好两个不同的文件路径"（07 §4.4）；
- 租约的 fence 在一张卡上跨 revoke 严格单调，且被撤销的持有者写不进任何状态（07 §5.1a）。

违反**不阻断**，产生 finding 事件 → fleet 投影 → 排行。这是"快速迭代停止条件"的正确形态：判据写在数据上而不是写死在主流程的 if 里，改一条判据不发版。

未来的独立观测者服务 / agent 挂在环 3，读事件流抽样发现异常模式，对环 0–2 零影响。
