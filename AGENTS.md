# AGENTS.md

hivemind 是 7x24 自主编码 agent 服务：从 Notion 看板接单，拆解后以 TDD 驱动开发，交付 MR 并回写业务语言报告。
改动任何 `src/` 之前先读 [docs/design/00-overview.md](docs/design/00-overview.md)（架构、决策、路线图）；
实施任务与验收判据见 [docs/plan/tasks.md](docs/plan/tasks.md)，设计与清单冲突时以设计文档为准并回写清单。

## 预发布立场：地基优先于兼容

**首次真实部署后删除本节。** 当前没有任何部署实例、没有外部使用者，因此优先把地基做对，而不是维护兼容层：

- 目录、模块、导出可以自由重命名，但必须同 PR 更新全部引用。
- schema 变更**直接改写 `0001_init.sql`**，不累积 `0002+` 迁移；本地库删掉重建（`data/` 已 gitignore，无生产数据）。
- 只有在第一次真实部署之后，迁移才变成只增不改的历史。

## 仓库布局

```
src/
  persistence/    中央 libsql：手写 SQL 迁移(权威) + drizzle 类型化查询 + 漂移检测 + 租约 CAS
  config/         配置注册表(zod schema + 作用域 + 热更语义) + 默认值/DB overlay 双层 store
  runner/         PiRunner port + RPC adapter + JSONL 分帧 + 错误提取/分类 + checkpoint + 断线重试
  pipeline/       无状态全量注入(phase prompt 组装) + DoD/收敛判据 + verdict 校验 + completion-verifier
  orchestrator/   两层状态机(Epic/Story) + intake + 调度纯函数(拓扑/footprint/hotspot)
  notion/         gateway(令牌桶+优先级+outbox) / sync(评论水位) / blocks(页面 builder) / 意图解释
  guard/          danger-rules + per-phase 策略组装（pi 侧钩子在 extensions/）
  queue/ worker/  BullMQ 派单信封 + worker daemon(心跳/能力声明/粘性恢复)
  regression/     RegressionScheduler + 场景注册表 + 归因二分 + 失败签名
  vcs/ verify/ report/ memory/ observability/ alert/ console/ util/
prompts/          基线层 + per-phase prompt，各自独立文件
extensions/       pi extension：hive-guard / model-policy 兜底（浏览器不走 MCP，见 02 §4.3）
poc/              M0 PoC 脚本（可丢弃）；scripts/ 为长期保留脚本
fixtures/         真实采集的契约 fixture（rpc-errors/ 来自 M0-05 实测；model-catalogs/ 由 scripts/catalog-snapshot.ts 采，非手写）
deploy/pi/        hivemind 追加给 pi 的模型声明（models.json），install.sh 幂等装到 ~/.pi/agent/
docs/design/      冻结设计 00–06；docs/poc/ 为 M0 执行记录与逐项 go/no-go
```

只有 `persistence` / `config` / `runner` / `pipeline` 已落地，其余目录为骨架。

## 命令

```sh
npm test          # vitest 单测，是提交前的默认门禁
npm run lint      # oxlint src poc scripts
npm run typecheck # tsc --noEmit，strict
npm run build     # tsc 产出 dist/
npm run db:migrate
npm run preflight -- --repository-path <repo>   # 就绪探针：pi/凭据/Notion/CLI/systemd/浏览器，不打印任何凭据
npm run orchestrator:run -- --repository-path <repo> --repository-id <id>   # Epic/Story 执行常驻
npm run requirements:run -- --repository-slug <owner/name>                  # 产品经理常驻（与上者共用一库一 outbox）

deploy/linux/install.sh --repository-path <repo>   # 部署唯一入口，幂等；Ubuntu / Arch(Omarchy) / WSL2 Ubuntu 同一条命令

npx tsx scripts/catalog-snapshot.ts <provider>   # 采 provider 目录快照（该机需有这家凭据）
npx tsx scripts/provider-add.ts <provider> ...   # 声明 provider（写 model.providers，等价于在 console 上改）

npx tsx scripts/smoke-runner.ts            # 真实 pi 子进程冒烟
npx tsx scripts/smoke-context-isolation.ts # 验证 context 文件不泄漏
npx tsx scripts/smoke-crash-recovery.ts    # SIGKILL 后从 checkpoint 续跑
npx tsx scripts/smoke-browser-e2e.ts       # 真实 headless 浏览器 + 三层红线
```

Node `>=26`，ESM，包管理用 npm。部署只有 Linux 一条路：Windows 主机跑在 WSL2 Ubuntu 里，不再有原生 Windows 路径。
`deploy/linux/install.sh` 是唯一入口，每个阶段先查再做，人工步骤（凭据、pi 登录、gh 登录）原地停下、重跑续接；见 [docs/runbooks/linux-single-node.md](docs/runbooks/linux-single-node.md)。
pi 版本 pin 只写在 `package.json` 的 `hivemind.piVersion`，代码经 `src/runner/pi-binary.ts` 取，shell 经 `node -p` 取，不得再出现字面版本号。
`scripts/` 只放长期入口（run-* / smoke-* / preflight / notion-bootstrap / install-pi / pi-login / catalog-snapshot / provider-add）；一次性排障脚本用完即删，不进仓库。

### 本地验证顺序

单测 → 集成 → 端到端，按此顺序推进，不跳级。涉及真实 pi 行为的改动，单测之外必须跑对应 smoke 脚本；
只有**完全不依赖外部进程**的纯函数改动可以只跑单测。报告结果时只写实际执行过的命令。

## 凭据与配置

凭据一律走 `~/.hivemind/secrets.env`（chmod 600）与 `~/.pi/agent/auth.json`，**永不进仓库、永不进日志、永不粘进对话**。
`.env` / `secrets.env` / `data/` 已 gitignore。日志导出前经脱敏 waterfall，规范日志本身永不改写。
提交前确认 `git diff` 中没有任何令牌形态字符串（`sk-` / `ghp_` / `eyJ` 开头的 JWT 等）。

## 约定

### 架构不变量

- **中央 libsql 是执行状态的唯一真相源**，Notion 只是人机界面与呈现。同一字段永不双向合并：系统 owner 字段只由 orchestrator 写，人 owner 字段只被 ingest。
- **Notion 读写全部收敛在 orchestrator 的 NotionGateway**，worker 永不直连 Notion。单写者是"无需 CAS"这一简化的前提，破坏它就要补一整套冲突解决。
- **跨 phase 上下文是无状态全量注入**，不做 session fork。`assemblePhasePrompt` 只读它的参数：不读时钟、不读文件系统、不取随机数，每个集合按稳定键排序。相同输入必须产出逐字节相同的 prompt——跨机重建、failover、崩溃恢复三件事都骑在这一条上，且它是 provider 前缀缓存生效的前提。
- **全系统只有四类真停点**：`blocking_question`、`verify_loop_exceeded`、`retry_limit_exceeded`、`cost_ceiling_exceeded`（见 03 §1.5，DB CHECK 强制）。新增停点需要改设计文档。
- **轮次上限管"打转"，费用上限管"敞口"，互不代替**：同样 6 轮内环在 1M 模型上花费差一个数量级，所以 `cost.perCardUsdCeiling` 独立于 `retry.*`，在 phase 边界检查（turn 掐不断，故上限是超支下界而非精确切口），且**订阅额度不计入**——包月的钱花不花卡都一样。费用停点不出诊断、不进反思管道：它对"这活能不能干成"零信息量。
- **内环收敛判据是严格真子集**（`failed(N) ⊊ failed(N-1)`）；轮次硬上限（内环 6 / phase 重入 3 / continue 8 / regression 重开 2）只是最终兜底，上限设在离散轮次，不设在时长或 token。
- **加一个 provider 是数据改动，不是代码改动**：`model.providers`（registry 键，console 可编辑，标了 dangerous）声明每家怎么认证、每档用哪个模型；代码里不出现任何字面 model id。加进 `model.failoverChain` 是另一个决策，分开配、分开审计。
- **chain 顺序是成本决策：订阅在前、计费 API 在后**。包月的钱花不花都一样，所以订阅能扛的每一轮都是 deepseek 不用出的钱；deepseek 在链上是为了在订阅撞到 usage-limit 窗口时让服务不停，不是分担负载。
- **provider 目录有两个源**：pinned pi 的实时目录是权威，`fixtures/model-catalogs/` 的采集快照是无 pi / 无该家凭据时的兜底（漂移测试守住一致）。快照进仓库还有第二个作用：它让"这个 model id 是否存在"变成**同步**判据，配置写入当场就能拒绝坏 id，而不是等到 spawn 时卡住一张卡。
- **验证命令永不硬编码**，由 agent 看现场决定。防造假靠三层：prompt 约束、工具面物理掐断、verdict 代码校验；三层缺一不可，prompt 是最弱的一层。
- **`VERIFY.session_id != CODE.session_id`** 由 DB CHECK 强制，不靠应用层自觉。

### 持久化

- **手写 SQL 迁移是权威**，drizzle 只做类型化查询，两者一致性由漂移检测测试守住。不引入 drizzle-kit。
- **约束下沉到 DB**：状态枚举、唯一键、互斥关系写成 CHECK / UNIQUE。应用层可以有 bug，DB 约束不会被绕过。
- **租约用条件 UPDATE + 单调 fence**。被撤销的持有者拿旧 fence 回来续租或释放必须被拒——这是多机粘性不出双执行的根，改动此处必须同时补并发测试。

### pi 运行器

- **RPC 分帧只切 LF**，禁止使用 Node `readline`：它同时在 U+2028/U+2029 处切分，而这两个码点在 JSON 字符串里合法。
- **握手是真实往返**（`get_state`），不是"进程起来了"。握手失败立即 SIGKILL，绝不复用可疑进程。
- **错误提取只认单一契约**：assistant 消息的 `stopReason === "error"` + `errorMessage`。但 RPC 有**两条**错误面——命令级 `{type:"response", success:false, error}` 与运行期 `stopReason:"error"`，前者不走这条契约。
- **分类规则顺序有载荷**：QUOTA 必须排在 RATE_LIMIT 之前。配额耗尽也是 429，读反了 worker 会永远等一个不会打开的窗口。pi 自己也这么挡（`status===429 && isTerminalRateLimitError → 不可重试`）。
- **文案来源是 pi 的 provider 层，不是 provoke**：`isTerminalRateLimitError`（计费家族）与 `RETRYABLE_PROVIDER_ERROR_PATTERN`（约四十条瞬时文案）是 pi 跨所有 provider 攒出来的，逐条断言在 `classify.test.ts`，pi 升级新增文案即测试红。**不要用真实并发去压 429**：那是花钱买一个字符串，而且会排队的 provider（DeepSeek）根本不给。采集脚本只留能零成本触发的 AUTH，且 `--model` 必填——曾因默认取"目录第一个"把一串长 turn 花在没人选的模型上。
- **UNKNOWN 必须 fail closed**（`needsHuman: true`，断路器 `retryAt: null`）：已知集合补全在前、兜底在后。若当瞬时故障处理，就是对着一个没人叫得出名字的错误安静重试到底——DeepSeek 余额耗尽（402 "Insufficient Balance"）曾正是如此。单条怪文案仍容忍，要连续到阈值才停牌。
- **TokenUsage 四桶互斥**（`uncachedInput / output / cacheRead / cacheWrite`）。reasoning 是 output 的细分，**不重复累加**；cacheRead 与 cacheWrite 单价不同，折进 input 就永久失去准确定价能力。
- **checkpoint 存 session JSONL 文件本身**，不存消息数组：RPC 有 `get_messages` 导出，但**没有任何载入命令**（0.85.0 的 `SessionManager.inMemory()` 只在库内 SDK 面，`AgentSession` 仍硬编码 JSONL，见 pi#9000）。
- **checkpoint 必须以换行结尾**：向未终止的末行追加会把下一条记录并进去，两条一起丢（pi#8345，0.84.4 已修根因，我们仍强制，因为 checkpoint 活得比写它的 pi 版本长）。修复被触发即为异常，走 `onRepair` 进规范日志，不做静默字段。
- **只修尾部损坏**（pi 已知 bug 的形态）；中段损坏拒绝修复并回退更老快照。宁可多跑一段，也不拿一个被悄悄改过的会话续跑。
- **默认 `--no-context-files`**：pi 会向上层叠 `CLAUDE.md` / `AGENTS.md`，实测会把宿主机的个人指令读进任务上下文，且静默无报错、事后难归因。需要的文件显式装载，并把生效清单记入规范日志。
- **reasoning effort 与 tier 同构**：`model.purposeThinking` 按 purpose 配 `--thinking` 档位，由 `ModelPolicy.resolve` 挂到 `ResolvedModel` 上随模型一起走，所以每个 port 零改动即透传。只有目录明说 `thinking=yes` 的模型才会收到档位——理由同下一条，pi 对用不上的参数不报错。
- **`resolveModel` 是所有 model 参数的唯一入口且必须自校验模型 id**：坏 id 在 spawn 时只是 warning，pi 会当自定义模型继续跑并编造价格。
- **pi 内置目录之外的模型走 `deploy/pi/models.json`**，由 `scripts/install-pi-models.sh` 装到 `~/.pi/agent/models.json`（install.sh 已串进 pi 阶段）。它必须在每台机器上一致：采集快照记的是"pi 宣告了什么"，少装一台就少宣告一个 id，漂移测试和配置校验都会在那台机器上炸。声明里 `input` 不写 `"image"` 就永远不会发图（pi 默认 `["text"]`），`cost` 不写就静默记 0。
- **model id 存在 ≠ 本账号可用**：ChatGPT 订阅账号会拒掉 pi 目录里照样列着的 id（实测 `gpt-5.4-mini` / `gpt-5.4` / `gpt-5.3-codex-spark`，见 06 §3）。快照只能回答"是否存在"，"能否用"只有真实往返能回答——这就是 preflight 除凭据探针之外还要花一轮 capacity_probe 的原因。
- **凭据探针一律 `--no-refresh`**；`pi auth check` 在 `not_ready` 时**退出码仍为 0**，必须解析 JSON status。存着 token 就报 `ready`，refresh 是否还能用它不知道。
- **spawn 前清理陈旧 `auth.json.lock`，握手超时高于 pi 的 30s 夺锁窗口**：被 SIGKILL 的 pi 留下锁目录，下一个 pi 静默等满 30s——击杀/隔离/宿主机真死后的第一次 spawn 必然卡死。清理只认 mtime 超 30s（pi 自己的判据），夺不走活持有者的锁：破锁会让两个进程轮换同一个 refresh token，双双作废。
- **放弃一轮之前先 `clear_queue` 再 `abort`**：`abort` 故意保留 steering / follow-up 队列并在之后继续投递，不清就等于用刚被丢弃那一轮的指令去驱动下一轮。
- **等人不算在干活**：RPC 下"阻塞等人"的信号是 stdout 的 `extension_ui_request`（对话类方法要等 stdin 回 `extension_ui_response`），不是 extension 侧的 `ui_prompt_start/end`——后者在 RPC 模式不发。心跳读 `waitingOnUser`。
- **usage-limit 文案里的分钟数是相对值**，锚定事件自身时间戳，不能锚定"我们读到它的时间"——在 outbox 积压过就会算错窗口。

### 代码风格

- 代码中不出现中文、特殊字符、无意义缩写，也不出现只在某次会话里成立的简称或步骤编号。
- 注释只写必要的，用简洁可读的英文，说明契约、失败模式、所有权与安全用法；不复述代码，不记录推理过程或评审历史。
- 空 `catch` 必须写明它吞掉了什么、为什么其他情况到不了这里。
- 文件以恰好一个换行结尾。
- 禁用某条 lint 规则时就地窄范围禁用并写明理由，不做全局关闭。

### 移植

**R-5（强制）**：凡从 busybee 移植的代码，注释含 `single-process` 或隐含单机假设（本地锁、本地文件即真相、`obliterate`）的，
必须逐条重审并在 PR 描述中声明结论。busybee 是单机服务，hivemind day1 就是多机——照搬这类不变量会静默产生双执行。

## 测试

- 纯函数决策逻辑（收敛判据、footprint 相交、拓扑调度、triage 路由、去重键）全部单测覆盖。
- **契约 fixture 来自真实采集**（`fixtures/rpc-errors/<provider>/` 是从真实错误流采的，openai-codex 那批来自 M0-05），不手写臆造；新增 fixture 时要有测试保证它不会被漏掉。
- **进 failover chain 的每个 provider 都必须有自己的 AUTH 采集**，由 `assertErrorFixtureCoverage` 在 preflight 与 orchestrator 启动时强制。它证明这家的整条错误路径（pi 传输 → assistant 消息 → 提取 → 分类）真的走通过，而 AUTH 是唯一能零成本触发的一类（错 key 在计费前被拒）。**不要求 QUOTA / RATE_LIMIT 采集**：DeepSeek 官方文档明说不设请求速率上限、排队而不回 429，余额也无 API 可查，要求它们等于把每个计费 provider 卡在一个没人造得出的 fixture 后面，而那不是一个人该做的决策。这两类的识别保证改由 `classify.test.ts` 对 pi 自己的文案表逐条断言 + UNKNOWN fail closed 承担，敞口由 `cost.perCardUsdCeiling` 直接兜住。
- 测试描述行为而非正确性。行为过时了就连同测试一起改，并在 PR 里说明为什么。

## 编辑本文件

根目录的 `CLAUDE.md` 是指向 `AGENTS.md` 的符号链接（同 deepseek-harness 的做法），**编辑真实文件**。
每条规则保持自解释，细节链接到对应设计文档。能压缩就压缩，但不要为了短而丢掉"为什么"——
本文件里的多数规则是 M0 用实测换来的结论，去掉理由就会被下一个人当作可选项。
