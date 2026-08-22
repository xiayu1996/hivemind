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
- 信号指标：**大脑花费占比**（策略被绕过/难度失控的早期信号）、**缓存命中率** cacheRead/计费 input（prompt 破坏前缀缓存的信号）、单卡成本 > p95×N 异常告警。
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
