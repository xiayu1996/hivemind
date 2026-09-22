# Agent 运行时与阶段契约设计

> 状态：2026-09-14 新增。本文档回答两个问题——**一个阶段用什么样的 Agent 去跑**，以及**阶段本身由什么定义**。
> 前者是数据（易变，web 可改），后者是代码（稳定，编译期可校验）。把这条线划清楚是本文档的全部目的。

## 0. 为什么要这份文档

`03-pipeline-quality.md` 定义了流水线要产出什么、什么算干完；`02-distributed-execution.md` 定义了卡怎么在机器之间流动。中间缺了一层：**一个阶段跑起来时，模型、effort、prompt、工具、context、skill、MCP 这七样是谁决定的**。

实现上它们散在七处，靠人脑对齐，已经产生了四个可量化的缺陷：

| 缺陷 | 现场 | 后果 |
|---|---|---|
| thinking 与 tier 在 Story 侧整条链路丢失 | `scripts/run-local-orchestrator.ts:851` 只取 `.id`，且用 `code` 一档跑完全部阶段 | `model.purposeTiers` / `model.purposeThinking` 在 Story 侧完全不生效；`model.tierFailoverChains` 的 per-tier 顺序也失效 |
| 成本无法按场景归因 | `src/observability/phase-recorder.ts:71-72` 把 `purpose` / `tier` 写死为 `"phase"` / `"standard"` | 账本存在但答不出"设计贵还是实现贵" |
| 工具集四处字面量 | `pi-phase-port.ts:243`、`pi-pm-port.ts:83`、`pi-decompose-port.ts:91`、`scripts/run-story.ts:208`/`:265` | 改一处漏三处；同为"只读"的 DESIGN 与 VERIFY 实际工具集不同 |
| 阶段概念五套枚举 | `Phase`(6) / `GuardPhase`(9) / `StoryPhase` / `PmPhase`(4) / `ModelPurpose`(10) | 新增一个阶段要改九处，漏一处就是运行时才发现 |

## 1. 石头与沙子

分界线只有一条：**改它需不需要重新证明系统是对的**。

**石头（代码，编译期可校验）**：流程拓扑；产物契约与 schema；出口判据的性质（确定性而非 LLM 判定）；状态机转移表；四类真停点；租约 CAS + fence；预算语义；守卫红线；证据链定义；**prompt 的结构**。

**沙子（数据，控制台可改，不发版生效）**：model id 与 tier 映射；failover 顺序；thinking 档位；**prompt 的文本**（含 per-provider 变体）；工具集；skill 清单；MCP server 清单；context 装载清单；超时、截断阈值、并发度、重试上限、停滞阈值。

"prompt 结构是石头、文本是沙子"这条线今天已经存在——`assemblePhasePrompt`（`src/pipeline/phase-input.ts:84`）是纯函数管结构，`prompts/*.md` 管文本。这是现有设计里做得最对的一处，本文档把它推广到其余全部维度。

## 2. Agent 规格：分表承载 + 唯一解析入口

### 2.1 为什么分表而不是一个大键

两条理由，都来自已经踩到的坑：

1. **schema 演进隔离**。单一大键改 schema 会让所有已存 overlay 值重新校验，而 `src/config/store.ts:70-75` 现在的行为是校验失败只 `console.warn` 后静默回落——注释自己承认这会悄悄换掉整套 provider 策略而页面仍显示旧值。
2. **各维度的 scope 与 reload 语义本来就不同**。tier 是 global/hot，工具集只能 next-spawn，context 清单是 per-repo。

### 2.2 键族

| 键 | scope / reload | 内容 |
|---|---|---|
| `agent.purposeTools` | global / next-spawn | purpose → 工具集（顺序稳定，见 §4.3） |
| `agent.purposePrompts` | global / next-spawn | purpose → prompt 键（默认取 repo 文件，overlay 可覆盖全文） |
| `agent.purposeGuard` | global / next-spawn | purpose → 守卫档 |
| `agent.purposeContext` | per-repo / next-spawn | purpose → context 文件标签清单 |
| `agent.purposeLimits` | global / hot | purpose → 超时 / 续跑上限 / 输出截断 |
| `agent.purposeSkills` | global / next-spawn | purpose → skill 清单（预留，默认空） |
| `agent.purposeMcp` | global / next-spawn | purpose → MCP server 清单（预留，默认空） |

已有的 `model.purposeTiers` / `model.purposeThinking` 并入同一族，形状不变。`ModelPurpose` 增加 `shape` 与 `specify`，两者默认档位均为 **brain**。

控制台写面只开给 **prompt 与模型两族**；工具 / skill / mcp 族只读展示——它们改错的后果是 spawn 失败或守卫失效，不是产出质量下降，不适合在线编辑。

### 2.2a 这一族的 schema 现在是穷举的，而那正好挡住它自己要支撑的功能（2026-09-14 二次审查）

`registry.ts:221` 与 `:248` 两处写的是 `z.record(z.enum([...十个 purpose...]), ...)`。zod 4 的 `z.record` 配枚举键是**穷举**语义：键少一个即 `invalid_value`，键多一个即 `unrecognized_keys`。同一文件里 `providerProfiles.tiers`（`:60`）与 `model.tierFailoverChains`（`:286`）用的却是 `z.partialRecord`——少键放行、多键仍拒。两种写法混在一个文件里，没有注释说明为什么。

实测（本机 zod 4.4.3）：

```
z.record(z.enum([...]))      少键 → false     多键 → false
z.partialRecord(z.enum([...])) 少键 → true      多键 → false
```

这直接产生两个后果，而且都发生在"web 平台按场景配模型"这条正要建的路上：

1. **在控制台只改一个 purpose 的档位是做不到的**。写回去的 overlay 必须一次带齐全部十个键，少一个就整键校验失败 → `store.ts:70` 静默回落 → **整份 `model.purposeTiers` 退回代码默认值**，页面上还显示着刚提交的值。`store.ts` 的注释预言过这个失效模式，但只举了坏 model id 的例子；真正更容易触发的是这个。
2. **加 `shape` / `specify` 会让 DB 里每一条已存 overlay 当场失效**。枚举加两个成员之后，所有老 overlay 都变成"少两个键"，于是全部静默回落。这是 MR-14 的一个隐藏迁移步骤：不是"加两个默认值"就完事。

修法（MR-04 承担，MR-14 依赖它先落）：

- 两处 `z.record` 改 `z.partialRecord`，与同文件既有写法一致；缺失的 purpose 由**代码默认值**补齐，不由 overlay 承担完整性。
- `ModelPolicy.tierOf` 的 `if (!tier) throw` 保留，但语义从"配置漏了"变成"这个 purpose 连代码默认值都没有"——那是启动断言该拦的，不是运行时。`thinkingFor` 返回 `undefined` 本来就是合法的（只有目录声明 `thinking=yes` 的模型才收档位）。
- `shape` / `specify` 必须同时出现在 `MODEL_PURPOSES`、两处 zod 枚举、两处 `default` 里，共四处；`assertAgentSpecs` 增加一条"每个 `MODEL_PURPOSES` 成员都能解析出 tier"的启动断言，让漏改变成启动失败而不是某张卡跑到一半抛 `no tier is configured for purpose shape`。

### 2.3 唯一入口

```ts
resolveAgentSpec(config, catalog, purpose, provider): Promise<ResolvedAgentSpec>
```

结果带 Symbol brand，`RunnerSpawnOptions` 收紧为**只接受 `ResolvedAgentSpec`**，不再接受散装 model / tools / systemPrompt。

这不是风格偏好：`run-local-orchestrator.ts:851` 那个"只取 `.id`"的写法之所以能存在并静默吞掉 thinking 与 tier，正是因为下游肯收一个裸字符串。收紧之后同样的写法直接编译失败。这与 `resolveModel` 已有的"所有 model 参数的唯一入口"是同一条纪律，只是把它从模型一个维度扩到七个。

启动断言 `assertAgentSpecs` 扩展现有的 `assertModelPolicy`：每个 purpose 的各维度都能解析、工具名在 pi 目录内、prompt 键有对应文件或 overlay。**启动即拒，不留到 spawn 时**——坏 model id 在 spawn 时只是 warning，pi 会当自定义模型继续跑并编造价格，这个失效模式已经记录在 `AGENTS.md`。

并列修复 `store.ts` 的静默回落：dangerous 键校验失败启动即拒，其余产生告警事件。

## 3. 阶段契约注册表

### 3.1 契约

```ts
interface PhaseContract {
  phase: StoryPhase;
  purpose: ModelPurpose;                   // → resolveAgentSpec
  lane: "build" | "verify";                // 缓存 key 分组 + 盲审隔离，见 §4.4
  guardProfile: GuardProfile;
  produces: readonly ArtifactKind[];
  parse(raw: string): PhaseArtifacts;      // zod
  exit?: (ctx: ExitContext) => Promise<ExitVerdict>;
  budget: "inner-loop" | "free";           // 出口检查不计预算
  humanCanReject: boolean;                 // 本阶段产物可否被人工否决
  rejectReturnsTo: StoryPhase | null;      // 否决后回哪个阶段
}
```

`story-worker` 从 200 行命令式控制流（`src/orchestrator/story-worker.ts:198-400`）改为读注册表的解释器：

```
取当前状态 → 查契约 → 组 prompt → spawn → parse → 跑出口 → 按转移表推进
```

此后加一个阶段 = 加一行契约 + 一个出口函数 + 一条转移边 + 一处 DB CHECK，而不是九处。

### 3.2 为什么 `lane` 放在契约里

它一处声明供两处消费：缓存 key 分组（§4.4）与盲审隔离。加新阶段时"它属于哪一道"变成必填字段，漏填即编译失败——而不是等到 VERIFY 在运行时抛 `"VERIFY runner reused the CODE session"`（`src/verify/executor.ts:344`）。

### 3.3 为什么干预点也在契约里

`humanCanReject` / `rejectReturnsTo` 是**人在环的声明式接口**。人工否决与系统否决走同一条转移路径（都写 `phase.invalidated`，只是来源不同），所以"人能不能否决这个阶段、否决后回哪"必须是阶段自己的属性，而不是散在评论处理代码里的 if 分支。详见 `03-pipeline-quality.md` §12。

## 4. 跨阶段成本：前缀缓存

### 4.1 根因

pi 二进制里：

```js
prompt_cache_key: clampOpenAIPromptCacheKey(options?.sessionId)
```

`x-session-affinity` 同样取自 session id。对照实采的 provider payload：

```
session 文件名:   2026-09-10T10-54-54-911Z_01a08af4-cfbf-701c-9dcd-d74acb871a60.jsonl
payload 里的 key:                           01a08af4-cfbf-701c-9dcd-d74acb871a60
```

**整套缓存亲和都绑在 pi 的 session id 上，而每个 phase 开一个新 session，所以每个 phase 一个新 key。** pi 在主动把缓存打散。在解决这个 key 之前，任何前缀顺序优化的收益都是零。

### 4.2 三件套，缺一不可

| 步 | 做什么 | 解决哪一半 | 适用面 |
|---|---|---|---|
| ① key | spawn 前自建**只含 SessionHeader、零消息**的 JSONL，`id` 由 `cardId + lane` 确定性派生，`--session` 指向它 | 路由到同一实例 | 全部 provider |
| ② TTL | `PI_CACHE_RETENTION=long`，经现成的 `providerEnvFor(provider)`（`run-local-orchestrator.ts:518`）注入 | 阶段之间隔几十分钟也不过期 | **不含 codex，见下表** |
| ③ 顺序 | 组装顺序（`pi-phase-port.ts:267`）改为 `baseline + repo context + per-phase` | 公共前缀 712B → 11,497B | 全部 provider |

分工不同：**key 保证路由到同一实例，TTL 保证不过期，顺序保证前缀够长**。cache 条目按前缀 hash 存储，key 只影响路由，所以三者的收益是独立叠加的。

**TTL 这一档必须按 provider 分别核实，不能当成保证**（0.85.1 二进制逐条读出）：

| API 面 | `prompt_cache_key` | 长 TTL 字段 | `PI_CACHE_RETENTION=long` 的实际效果 |
|---|---|---|---|
| `openai-codex-responses`（ChatGPT 订阅，day1 主力） | `prompt_cache_key: cacheSessionId` | **没有这个字段** | **无**。codex 适配器对 `cacheRetention` 只判 `=== "none"`（置空 key），`long` 与不设完全等价 |
| openai-responses（`api.openai.com` 与兼容端点） | 有 | `prompt_cache_retention: "24h"`，或 `supportsExplicitPromptCacheMode` 时 `prompt_cache_options.ttl: "30m"` | 生效 |
| anthropic | `cache_control` cachePoint | `ttl: "1h"` | 生效 |
| azure-responses | 有 | 没有这个字段 | 无 |

所以：

- **`PI_CACHE_RETENTION=long` 仍然要设**（deepseek / zai / xai / anthropic 这几条 failover 链上的路都吃它），但它**不是**codex 上的杠杆。
- **codex 上的 TTL 是不可控变量**，由 ChatGPT 后端自己决定，我们既读不到也改不了。codex 上实际只有两件套：key + 顺序。
- 因此验收判据必须写成 per-provider：codex 上验 `cacheRead` 非零，**不验** payload 里有 TTL 字段；其余 provider 才验字段。把"payload 里出现长 TTL 字段"当成全局判据，会在 day1 主力 provider 上永远不通过。

原文此处曾用 `resolveCacheRetention2` 论证，那个函数属于 **Anthropic** 适配器，拿它论证 codex 是错的；codex 的请求体由 `buildRequestBody` 构造，键集恰好等于实采 payload 的那 11 个，里面没有任何 retention 字段。

### 4.3 顺序规则与它的连带纪律

社区收敛的排序规则是 **most-to-least stable：tool definitions → system prompt → reference docs → conversation history → live user query**，任何一块变动会废掉它自己**以及它之后的全部**缓存。当前实现恰好反过来——最稳定的 repo context 排在 per-phase 文本之后。

连带纪律：**工具定义必须逐字节且同序**。取消 per-phase 工具面之后工具块不再是断点，但 `agent.purposeTools` 的排序必须稳定，否则一次重排就废掉全部下游缓存。

### 4.4 共享的是路由标签，不是会话

每个 phase 各自一个 session 文件（**路径含 phase 与 round**），文件里零条消息，pi 以空对话开局，上下文仍然由 `assemblePhasePrompt` 全量注入。`assemblePhasePrompt` 的字节确定性、跨机重建、failover 全部不受影响，**不变量「不做 session fork」没有被触碰**。"上一阶段的偏见带进下一阶段"没有载体——pi 那边没有上一阶段的消息可读。

**但共享范围必须按道划分，不能整卡一个 key**，理由要说准——我此前写的"整卡一个 id 会当场撞死盲审"是**错的**，实际不会：

```
verify/executor.ts:114   const value = state.sessionFile ?? state.sessionId;
```

`sessionFile` **优先**。既然每个 phase 一个独立文件路径，写进 `verify_records` 的两个身份本来就不同，共享 header `id` 并不会触发 `0001_init.sql:510` 的 `CHECK (verify_session_id <> code_session_id)` 或 `executor.ts:343` 的运行时抛错。

而这恰恰是必须按道分组的**真正**理由：**盲审隔离今天靠的是 `??` 的左半边，而它左半边取的是文件路径，右半边取的才是 session id。** 一旦 pi 某个版本不再返回 `sessionFile`，或将来换一个不设它的 runner，右半边接管，两道的 id 若相同就会让每一轮 VERIFY 抛错。把三个身份物理分开，两个分支都安全：

| 身份 | 是什么 | 谁用 | 约束 |
|---|---|---|---|
| **缓存 key** | header `id`，由 `cardId + lane`（+ `cache.keyScope`）派生 | provider 路由与前缀亲和 | 同道内相同；**跨道必不同** |
| **session 文件路径** | 含 card / phase / round / attempt | `--session`、checkpoint 续跑 | 任意两次不同执行必不同 |
| **run 身份** | `phase_runs.run_id` | 编排、账本、盲审记录 | 每次执行唯一 |

盲审隔离的判据应当明确锚定 **run 身份**，而不是继续依赖"恰好路径不同"。`sessionId(state)` 那个 `??` 是一处需要在 MR-09 里收紧的隐患，不是可以依赖的保证。

分界线不用新发明，就是仓库里已经写着的 builder/verifier 隔离：

| 道 | 阶段 | 为什么归在一起 |
|---|---|---|
| 实现道 `build` | SHAPE / DESIGN / SPECIFY / CODE / REGRESSION_FIX / MERGE | 同一份 baseline + repo context + 同一张卡的需求头，公共前缀约 11.5KB；顺序执行，不并发 |
| 盲审道 `verify` | VERIFY / ui_review | 走 `blind-verify-port.ts` 另一条路，prompt 本就被削过；它在内环重跑 1–6 次，自己很快焐热前缀，独立成组几乎不损失 |

**共享范围（scope）做成配置**：`cache.keyScope`（`card` 默认 / `repo`）× lane。per-repo 的 key 理论上命中更高——同仓不同卡也能共用那 10,785B 的 repo context——代价是把并发的卡全汇到同一个实例，与 §5 的 per-provider 分桶相互干扰。用实测数据定，不预先拍板。

### 4.5 钉 id 拆掉了一个探针，必须补回来

"只共享标签不共享会话"只在文件路径不同的前提下成立。两个 phase 一旦指向同一路径，pi 会把上一阶段的消息续上——那就是被不变量禁止的 session fork，而且静默无报错。今天能发现这件事的判据恰好就是 session id 不相等；把 id 钉死就把探针拆了。

补三条独立断言：

1. session 文件路径必须含 `card / phase / round / attempt`。**只含 phase + round 不够**：同一 `(phase, round)` 会因 failover、崩溃恢复、provider 重入而跑多次，那些是不同的执行，不能落到同一个文件上。`attempt` 取 `phase_runs.run_id`（或其后缀），因为它本来就是"一次执行"的身份。单测断言同一张卡任意两次**执行**解析不到同一路径。
2. **首次** spawn 前文件必须零消息。崩溃续跑是同一 attempt 续自己那个文件，那时文件里有消息是正常的——断言只管首次。
3. `sessionId(state)` 的 `?? ` 收紧：盲审隔离比较的必须是 **run 身份**（`phase_runs.run_id`），不是"pi 碰巧返回了什么"。改完之后 `verify_records` 的两列语义才与它的 DB 注释一致（"Builder and verifier must be different sessions"）。

第 2、3 条同时写进 `04-observability.md` §4.2 的 invariants 注册表，事后也能抓到误共享。

**第 1 条与第 2 条之间有一个必须先解开的冲突（2026-09-14 二次审查）。** `story-execution-store.ts:337-350` 的 `startPhase` 对同一 `(card, phase, round)` 的重试是**删旧行再插新行**：

```sql
DELETE FROM phase_runs
  WHERE card_id = ? AND phase = ? AND round = ? AND status <> 'completed' ...
INSERT INTO phase_runs (run_id, ...) SELECT ?, id, ... WHERE NOT EXISTS (...)
```

`phase_runs` 的 `UNIQUE (card_id, phase, round)`（`0001_init.sql:275`）因此始终只留一行，而 `run_id` 由调用方每次新给。这有两个直接后果：

- `run_id` **确实**是一个合法的 attempt 身份（每次执行各一个），第 1 条成立；
- 但"每次 attempt 一个新 run_id"意味着**每次 attempt 都是首次 spawn**，于是第 2 条会把任何"带着 checkpoint 恢复"的启动一并拒掉。

所以第 2 条的"首次"必须定义在 **run_id 之内**，而不是 `(card, phase, round)` 之内：*同一个 `run_id` 的第一次 spawn* 必须零消息，同一个 `run_id` 的后续 spawn（进程内断线重连、一轮之内的续跑）可以带消息。跨 attempt 不存在续跑——旧行已被删除，新 attempt 是一次全新的无状态全量注入，这与"跨 phase 不做 session fork"是同一条纪律的延伸，不是例外。

连带一条事实：`CheckpointStore`（`src/runner/checkpoint.ts`）与 `lease.ts` 一样**至今零生产调用者**（只有 `scripts/smoke-crash-recovery.ts` 和单测在用）。所以"崩溃续跑"这条路在 MR-08/09 之前并不存在实现，本节定义的是它将来必须遵守的形状，不是在描述现状。checkpoint 的快照键必须与 session 文件路径同键（都以 `run_id` 为最内层），否则恢复出来的 JSONL 会落到一个不属于它的路径上——那正是第 1 条要挡的误共享。

### 4.6 宿主机 skill 注入必须堵住

实采 payload 的 system prompt 末尾注入了宿主机 `~/.agents/skills/` 下的 9 个个人 skill（共 5,199 字节），与任务无关。

严重性不在浪费的 5KB，而在**它破坏了"跨机重建 prompt 必须逐字节相同"这条不变量**——换一台机器 skill 列表就不同。`AGENTS.md` 已经记录过同一个失效模式（pi 会向上层叠 `CLAUDE.md`/`AGENTS.md`），当时用 `--no-context-files` 堵住了 context 文件那条路，**skill 这条路没堵**。

### 4.7 度量

`src/observability/cache-analysis.ts:2` 的注释自陈只算 "one model session" 内的 turn 间缓存，**跨阶段的缓存无人度量**。扩为按 `(card, lane)` 聚合历次 spawn 的 cacheRead 占比，沿用它现有的"结构上限 vs 真实损失"两分法。两道分开统计，否则盲审道天然较低的命中率会把实现道的数字拖花。

### 4.8 一个已知冲突，留给数据

`agent.purposeContext` 的 per-purpose 定制与跨阶段共享前缀**直接冲突**：per-phase 定制 context 越多，公共前缀越短。三件套做完后若实现道命中率仍然很低，"多阶段 vs 少阶段"的成本模型要重算，这个键也要重新权衡。这是 MR-39 要回答的问题。

另注：Anthropic 系的缓存不是自动的，需要 `cache_control` 标注，连 "automatic" 模式也要传一个 top-level 设置；实采样本里没有任何 `cache_control`。换到 Anthropic 系 provider 时这是另一道要单独验证的关口。

## 5. 派单与并发

### 5.1 进程已经是拆开的

`run-local-orchestrator.ts:500` 为每张卡 fork 一个 `npm run story:run`。所以这里不是"拆进程"，是**把喂参数改成领单**：

- `story:run` 的入参收敛为 `--card-id`（加必要路径），不再接 `--provider` / `--model`。子进程自己走 `src/persistence/lease.ts` 的 CAS + fence 落租约，自己 `resolveAgentSpec`。
- **thinkingLevel 在命令行这一跳丢失的根因随之消失**——`--model` 是命令行字符串，effort 挂在 `ResolvedModel` 上，物理上传不过去。
- 加机器时这个子进程原样就是 worker。

`src/persistence/lease.ts` 的 CAS + fence + revoke + expired 全部写好且有并发单测，生产代码一次没调；并发现在靠 orchestrator 进程内的 `inFlight: Map`（`:437`）+ `maxConcurrentStories` 默认 1。领单改造让租约第一次真正上生产。

### 5.1a 上生产之前，租约本身有三个洞

`lease.ts` 的 CAS + fence + revoke + expired 全部写好且有并发单测，但**零生产调用者**——所以下面三条至今没有被任何真实路径压过。MR-29 是它第一次承重，必须先补完再接：

**洞一：fence 在 release/revoke 之后重置。** `release`（`:83`）与 `revoke`（`:96`）都是 `DELETE FROM leases WHERE card_id = ?`，行没了；下一次 `acquire` 走 INSERT 分支，`VALUES (..., 1, ...)`，**fence 回到 1**。而 `:26-28` 的注释写的是「A holder that was revoked while partitioned still carries the old fence, so its later renewals and releases are rejected」——这句话在 holder 相同时不成立：同一个 holder 被 revoke 后重领，fence 又是 1，那个还在跑的旧执行实例拿着 fence=1 去 `renew`/`release`，**会被接受**。而 `revoke` 的用途恰恰就是「worker 失联超过宽限期」，也就是旧持有者最可能回来的那个场景。

修法：fence 不能存在会被删除的行里。要么 `release`/`revoke` 改为把行置空占位而不删（保留 `card_id` 与 `fence`），要么把单调计数器挪到独立的 `lease_fences(card_id, next_fence)` 表，`acquire` 从那里取。**fence 必须对一张卡全生命周期单调，跨 revoke 也单调。**

**洞二：同 holder 重复 acquire 永远成功。** `:56` 的 `WHERE leases.expires_at <= ? OR leases.holder = ?` 第二个分支是为「同一持有者续领」准备的，但它让**同 holder 的第二个进程也拿到租约**：P1 持有（fence=1），P2 用同一 holder 调 `acquire` → 命中 `holder = ?` → fence 变 2 → `get` 返回 holder 相符 → P2 认为自己拿到了。P1 此后 `renew(fence=1)` 会失败，但**没有任何东西强制 P1 在继续干活前先 renew**，于是两个进程同时在跑同一张卡。

这在 MR-29 里是必然踩到的：`story:run` 是每卡一个子进程，如果 holder 取 `hostId`，同机两个子进程就是这个形状。

修法：**holder 必须是执行实例身份，不是机器身份**——`hostId + pid + 启动时刻`，或直接用 `phase_runs.run_id`。机器身份留在另一列供粘性调度用。

**洞三：状态写入不带 fence。** 全仓除 `lease.ts` 与 drizzle schema 外没有任何地方出现 `fence`。租约挡住的只是"谁能领"，挡不住"一个已经被撤销的执行者继续往中央库写产物与状态"。fence 的全部价值就在这里：**被撤销者的写必须被拒**。

修法：`story_execution` 的状态转移与 `phase_artifacts` / `phase_runs` 的写入都带上 `fence`，条件 UPDATE 里比对；不匹配即拒绝并让该进程自杀。

**验收必须覆盖这三条**，不能只测「两个不同 holder 抢同一张卡」这一个已经过的用例：

1. 同一 holder 的两个执行实例并发 `acquire`，**第二个必须被拒**；
2. `revoke` 之后重领，旧执行实例拿旧 fence 来 `renew` / `release` / 写状态，**三个都必须被拒**；
3. fence 在一张卡上跨 revoke 严格单调递增。

### 5.2 并发是 per-provider 分桶

`src/config/registry.ts:440` 那条注释「Kept at 1 while several concurrent pi processes still share one credential file」前提写错了：单账号确实能并发，真正的上限是**账号级并发节流**。

社区实证（见 00 §Sources）：上限约 2–3 个并发流，4 个并发流约 30 秒内必挂 429；响应无 `Retry-After`、无 `x-ratelimit-*`，客户端无法退避；复制凭据目录会自伤——OAuth refresh token 一次性，真实例刷新后所有副本立即作废。

所以：

- `schedule.maxConcurrentPerProvider`，桶容量在 `model.providers` 里逐家声明，默认按 authType 取保守值（oauth 2 / api_key 4）。
- **429 自动收桶**：复用 MQ-01 的 circuit-breaker，该 provider 出 RATE_LIMIT 则桶容量减一、冷却后渐增。无 `Retry-After` 可依，只能靠观测到的失败反推。
- **不做 `PI_CODING_AGENT_DIR` 目录隔离**。正确形态是共享唯一凭据 + 单点刷新，hivemind 已有 broker（`src/runner/auth-refresh.ts` 的 `open(...,"wx")` 文件锁）。缺口只有一处：pi 子进程跑到一半自己发起的刷新不走这把锁。
- `maxConcurrentStories` 保留为机器级总闸。

**桶必须按"每次真实启动模型"申请，不能按整卡领单时申请一次（2026-09-14 五次复审补齐）。** 上面只写了容量与收缩规则，没写申请时机，而这个设计里 **provider 是每个阶段各自解析的**（§2.3 的 `resolveAgentSpec(purpose, provider)`，加上 failover 链可能在一轮中途换家）。整卡领单时占一次桶，保证不了后续阶段：两张卡各自从不同 provider 起步，都在下一个阶段切到同一个容量为 1 的 provider，两边都以为自己早就占过位了。

分层因此是两层，各管各的：

| 层 | 粒度 | 管什么 |
|---|---|---|
| 卡级租约（`lease.ts`，§5.1a） | 整张卡 | 所有权：谁在跑这张卡，防双执行 |
| provider 容量 | **每次 spawn** | 节流：这家 provider 此刻同时有几个流 |

规则四条：

1. **在真正 spawn 模型之前原子申请**，执行结束（正常/失败/被杀）释放；**failover 换家要重新申请**，并释放原来那家的位置。
2. **等容量不消耗任何失败轮次、不产生停点**。等待是调度状态不是失败，算进重试上限就会让一张卡因为别人正忙而被判死。
3. **占位要能在持有者死亡后回收**：与租约同一套形态（带过期时间的条件写入 + 心跳续期），不做进程内计数——进程内计数在 `story:run` 已经是独立子进程的前提下根本管不住跨进程并发，这正是 `run-local-orchestrator.ts:437` 的 `inFlight: Map` 今天的局限。
4. 桶是**全局资源**，不随卡走：同一张卡的不同阶段各自申请、各自释放。

### 5.2a 逐阶段选 provider，计费口径也必须逐次重算

**这是上一条的连带缺口，不修就是费用上限静默失效（2026-09-14 五次复审补齐）。** `scripts/run-story.ts` 今天在启动时一次性定死三样，用的是命令行传进来的那个 provider：

```ts
:151  const metered = isMeteredProvider(await modelPolicy.profileOf(provider));
:157  const recorder = new LibsqlPhaseRecorder(..., { provider: model.provider, isSubscription: !metered });
:335  ...(metered ? { spend: spendPort } : {})
```

这在"一张卡一个 provider 从头跑到尾"的旧形态下成立。MR-29 把 provider 改成逐阶段解析、并挂上 failover 链之后就不成立了：卡从订阅家起步 → `metered` 为 false → **`spend` 端口根本没挂** → 中途 failover 到计费 API，之后每一轮都在花真钱，而费用上限自始至终没有生效，账也按订阅记（`isSubscription: true`），在成本视图里显示为零。这与 `AGENTS.md` 那条"卡跑在订阅 provider 上时 `spend` 端口不挂"并不冲突——那条说的是**当下这次执行**跑在订阅上，不是"这张卡开局时是订阅"。

所以：

- **provider / model / billing / 记账口径全部取本次执行的解析结果**，不取启动时的快照。`recorder` 的 `provider` 与 `isSubscription`、`spend` 端口挂不挂，都是**每次执行**的决定。
- **`spend` 端口按执行挂载**：这次执行落在计费 provider 上就挂，落在订阅上就不挂。
- **单卡累计只增不减**：`cost_entries` 里此前真实发生的计费支出，不因为后来切回订阅而清零或被隐藏。否则一张"订阅 → 计费 → 订阅"的卡会把中间那段花掉的钱抹掉，上限再也拦不住它。
- 上限的语义不变，仍是 §9.4 的"phase 边界检查、超支下界而非精确切口"。

### 5.3 不引入 MQ

MQ 能提供的每一项在中央 libsql 里都已有对等物：任务持久化 = `stories` 表；优先级 = `stories.priority`；能力路由 = `stories.capabilities`；stalled 检测重派 = 租约过期（`lease.ts:119`）；防重复消费 = 租约 CAS + 单调 fence（`lease.ts:48-87`）。

`02-distributed-execution.md` §1.3 自己写明链路是「worker 领**信封** → 落中央租约 → ack」——防双执行的始终是租约。引入 BullMQ 的代价是一个必须常驻的 Redis、跨机网络依赖与认证、busybee 已踩过的 jobId 幂等/requeue/removeOnComplete 三个坑，以及**第二份状态**——而"避免第二个真相源"是本设计的核心不变量。

唯一真缺的"推送式唤醒"，对跑几分钟到几十分钟的卡，5–10 秒轮询延迟无影响。推拉并存，与 `05-web-console.md` §4.3 给配置分发定的模式同源。

## 6. 工具面：不做 per-phase 限制

**结论**：工具集全阶段统一，阶段约束交给 prompt 尾部 + 确定性出口判据。

理由不是"省事"，是**原来的依据经不起细看**。`03-pipeline-quality.md` §0 第 2 条的教训来源是 busybee 的 file:// 假页面截图冒充 e2e，落成的约束里含"VERIFY/E2E runner 工具面禁写"。但**工具面禁写从来就挡不住这个事故**——伪造者只需要导航到一个 file:// URL 并截图，两个都是读操作。真正挡住它的是另外两层：guard 的 `e2eHostAllowlist`（导航层，`src/guard/policy.ts:118`）与 IT-04 的屏幕证据校验（verdict 层：e2e/ui 场景需独有截图 + 到达页面，缺则 inconclusive）。

其余阶段本就没有造假动机：DESIGN 写代码无收益；SPECIFY 写实现是自伤（写了实现测试就绿，而出口要求红，tree-pin 还会把非测试改动 revert 掉）。

保留的物理约束只有两条运行时红线，**都不改工具 schema，所以不切断缓存前缀**：

| 红线 | 在哪 | 挡什么 |
|---|---|---|
| `fencedPatterns` | hook 侧运行时检查 | CODE 改 SPECIFY 冻结的测试文件 |
| `e2eHostAllowlist` | 导航层（`policy.ts:118`） | 假页面冒充 e2e |

采集数据还暴露了工具面现在根本不是一个受控的面：VERIFY 是 `[read, bash, grep, find, ls]`、DESIGN 是 `[read, bash]`，两个都"只读"却完全不同，因为 VERIFY 走 `blind-verify-port.ts` 另一条路。`agent.purposeTools` 收口时一并处理。

## 6a. SoL-Pi：只收两个机制（2026-09-22 增补）

NVIDIA 的 SoL-Pi 是 pi 0.85.1 的标准 extension（不改 pi 源码，全走公开 API，默认四个机制全关），
打包了它在 535 个可执行环境里搜出来的四条省法。它的 pin 与我们一致，因此可以直接装载。

本机实测（`turn_usage`，09-18 至 09-22）决定了收哪两个：输入 16.6 亿 token 里 99% 是缓存命中，
其中 14.98 亿跑在包月的 command-code 上。**所以 SoL-Pi 论文里 33% 的账单节省在这里基本不存在**，
真正的价值是少撞订阅的 usage-limit 窗口、缩短每张卡的轮次——而 CODE 平均 107 轮、峰值上下文 189K，
64 次里 41 次超过 150K，正是前两个机制针对的形态。

| 机制 | 收不收 | 理由 |
|---|---|---|
| Action Fusion | 收 | `edit`/`write` 多一个可选 `then_run`，改完在同一次工具调用里跑验证命令，省掉 CODE 里每一对「改—跑测试」的一个模型往返 |
| ObservationPack | 收 | 超 10 KiB 的工具结果只完整发 2 次，之后换句柄 + 摘要，`obs_recall` 分页取回原文；只改投喂给 provider 的投影，session 文件不动 |
| Evidence-Preserving Reducer | 不收 | 它在 extension 内部直接调第二个模型，这条调用**不过 RPC 事件流**，于是 `sumUsage`、`turn_usage`、`cost.perCardUsdCeiling`、熔断、错误分类全都看不见它——等于在所有护栏之外开一条模型路径。它还改写落进 session 的 tool_result，而那正是 VERIFY 证据比对与 SPECIFY 测试报告读的文本 |
| Online Context Compact | 不收 | 省得最多，也是 NVIDIA 自己的消融里唯一掉分的（44.8 → 42.0）。它省的是 cache read，而承载我们绝大部分流量的 provider 按订阅计费，这份节省在账单上是零；它还要在 turn 中途 `abort` 再发隐藏消息续跑，与「`clear_queue` + `abort` 是放弃一轮的信号」直接相撞 |

### 装载方式与三条纪律

1. **不用 `pi install`**：那会把包写进宿主机的 pi 设置，让 prompt 取决于机器——正是 `--no-context-files` 与
   `--no-skills` 要挡的那一类。改为像 pi 自己一样按 pin 装在 `~/.hivemind/sol-pi/<ref>/`
   （`scripts/install-sol-pi.sh`，幂等，校验 checkout 就是那个 commit），spawn 时经 `-e` 显式装载。
   ref 只写在 `package.json` 的 `hivemind.solPiRef`，代码经 `src/runner/sol-pi.ts` 取，不得再出现字面 sha。
2. **开关是数据，文件由 hivemind 渲染**：`agent.solPi`（registry 键，console 可编辑，标了 dangerous）是
   唯一真相，`~/.pi/agent/sol-pi.json` 由 `resolveAgentSpec` 在每次 spawn 前渲染——与 `models.json`
   同一个模式、同一个理由（pi 是另一个进程，只读磁盘上的文件）。不收的两个机制**显式写成 false 而不是省略**，
   因为这个文件就是那个决定的审计；reducer 的 provider/model 一行都不写，这样没有任何日志能经它离开本机。
3. **`obs_recall` 与创建句柄的机制同生共死**：spawn 传的是显式工具白名单，所以工具名与扩展装载必须出自
   同一个决定（`ResolvedAgentSpec.solPi`）。装了扩展不给工具，模型拿到打不开的句柄；给了工具不装扩展，
   白名单里是一个 pi 解析不了的名字。实测 pi 对白名单里的未知工具名**静默忽略**，所以这件事没有运行期报错兜底。

### 融合调用把工具面那层红线整个绕开了

`decideToolCall` 此前只对 `bash` 取 `command` 过 `checkBash`，而 Action Fusion 的命令藏在
`edit.then_run.command` 里——三层防造假中最硬的那层（工具面物理掐断）会被一个换位置的命令整层绕过，
CODE 冻结测试的 `fencedPatterns` 与全局红线同时失效。修法是把命令判定抽成一段，在函数最前面对**任何**
带 `then_run` 的调用先判一次，而不是只判今天被替换的那两个工具；`then_run` 在而 `command` 不是字符串时
拒绝而非忽略，与 bash 的 fail-closed 同构。验证不靠单测自证：`scripts/smoke-guard.ts` 里新增的三条
FUSED 探针跑的是真实 pi + 真实 SoL-Pi，由确定性 mock provider 发出融合调用，
审计里出现 `deny write rm -rf …` 才算过；放行那条要求事件流里有 `then_run:succeeded`，
因为内置 `write` 根本没有 `then_run`，这个标记是「扩展真的生效了」唯一的物证。

### 与工具输出截断的先后

hive-guard 在 `tool_result` 截断，ObservationPack 在 `context` 投影改写，所以**守卫在前**：
归档的是已经截断过的字节，`obs_recall` 取回的也只到守卫允许的那条线。这是对的方向——守卫仍是上界——
但也意味着 ObservationPack 在这里省的不是「一次大输出」，而是那次输出在其后每一轮里的重放。

### 验收

开关默认关，因为工具块位于缓存前缀最前面，开任一个都会让前缀缓存整体作废一次。
判据用现成的 `turn_usage`：对比开关前后 CODE 与 REGRESSION_FIX 的 turns_per_run 与每轮输入 token，
并看订阅 provider 撞窗口的频率是否下降。

## 7. 不变量清单

本文档新增或改写的不变量，实施时逐条对照：

1. **`resolveAgentSpec` 是全部七个维度的唯一入口**，结果带 brand；`RunnerSpawnOptions` 不接受散装参数。破坏它就会重现 thinking/tier 静默丢失。
2. **阶段的一切由 `PhaseContract` 声明**，包括它属于哪一道。加阶段不改九处。
3. **缓存 key、session 文件路径、run 身份是三个东西，永不互相代用**。路径含 card/phase/round/attempt；首次 spawn 前零消息；盲审隔离锚定 run 身份。破坏第一条等于静默做了 session fork，破坏第三条等于把隔离寄托在 pi 的返回字段上。
4. **缓存 key 按 lane 分组**，实现道与盲审道永不同 key。这是为了让盲审隔离在 `sessionFile ?? sessionId` 的**两个分支下都成立**，而不是因为不分组就会立刻崩。
5. **工具定义逐字节且同序**。`agent.purposeTools` 的排序稳定是缓存前缀的前提。
6. **prompt 组装顺序 most-to-least stable**：`baseline + repo context + per-phase`。
7. **宿主机 skill 与 context 文件都不得注入**。跨机重建 prompt 逐字节相同这条不变量骑在它上面。
8. **并发上限是 per-provider 的**，凭据共享 + 单点刷新，永不复制 `auth.json`。
8b. **租约的 holder 是执行实例不是机器，fence 跨 revoke 单调，且状态写入必须带 fence**（§5.1a）。三条缺任何一条，租约就只是看起来在防双执行。
9. **SoL-Pi 的开关、工具名与扩展装载出自同一个 `ResolvedAgentSpec.solPi`**，不收的两个机制显式写 false；
   任何带 `then_run` 的工具调用都要过一遍 shell 红线，否则工具面那层防造假形同虚设（§6a）。
10. **控制台写面只开 prompt 与模型两族**；工具 / skill / mcp 只读。
