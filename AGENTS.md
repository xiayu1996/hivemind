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
fixtures/         真实采集的契约 fixture（rpc-errors/ 来自 M0-05 实测，非手写）
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
npm run preflight -- --repository-path <repo>   # 部署前就绪探针：pi/凭据/Notion/CLI/浏览器，不打印任何凭据
npm run orchestrator:run -- --repository-path <repo> --repository-id <id>   # Epic/Story 执行常驻
npm run requirements:run -- --repository-slug <owner/name>                  # 产品经理常驻（与上者共用一库一 outbox）

npx tsx scripts/smoke-runner.ts            # 真实 pi 子进程冒烟
npx tsx scripts/smoke-context-isolation.ts # 验证 context 文件不泄漏
npx tsx scripts/smoke-crash-recovery.ts    # SIGKILL 后从 checkpoint 续跑
npx tsx scripts/smoke-browser-e2e.ts       # 真实 headless 浏览器 + 三层红线
```

Node `>=26`，ESM，包管理用 npm。Linux 单节点部署走 `deploy/linux/install.sh` + systemd 用户单元，步骤见 [docs/runbooks/linux-single-node.md](docs/runbooks/linux-single-node.md)。

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
- **全系统只有三类真停点**：`blocking_question`、`verify_loop_exceeded`、`retry_limit_exceeded`（见 03 §1.5，DB CHECK 强制）。新增停点需要改设计文档。
- **内环收敛判据是严格真子集**（`failed(N) ⊊ failed(N-1)`）；轮次硬上限（内环 6 / phase 重入 3 / continue 8 / regression 重开 2）只是最终兜底，上限设在离散轮次，不设在时长或 token。
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
- **分类规则顺序有载荷**：QUOTA 必须排在 RATE_LIMIT 之前。配额耗尽也是 429，读反了 worker 会永远等一个不会打开的窗口。
- **TokenUsage 四桶互斥**（`uncachedInput / output / cacheRead / cacheWrite`）。reasoning 是 output 的细分，**不重复累加**；cacheRead 与 cacheWrite 单价不同，折进 input 就永久失去准确定价能力。
- **checkpoint 存 session JSONL 文件本身**，不存消息数组：RPC 有 `get_messages` 导出，但**没有任何载入命令**。
- **只修尾部损坏**（pi 已知 bug 的形态）；中段损坏拒绝修复并回退更老快照。宁可多跑一段，也不拿一个被悄悄改过的会话续跑。
- **默认 `--no-context-files`**：pi 会向上层叠 `CLAUDE.md` / `AGENTS.md`，实测会把宿主机的个人指令读进任务上下文，且静默无报错、事后难归因。需要的文件显式装载，并把生效清单记入规范日志。
- **`resolveModel` 是所有 model 参数的唯一入口且必须自校验模型 id**：坏 id 在 spawn 时只是 warning，pi 会当自定义模型继续跑并编造价格。
- **凭据探针一律 `--no-refresh`**；`pi auth check` 在 `not_ready` 时**退出码仍为 0**，必须解析 JSON status。
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
- **契约 fixture 来自真实采集**（`fixtures/rpc-errors/` 是 M0-05 从真实错误流采的），不手写臆造；新增 fixture 时要有测试保证它不会被漏掉。
- 测试描述行为而非正确性。行为过时了就连同测试一起改，并在 PR 里说明为什么。

## 编辑本文件

根目录的 `CLAUDE.md` 是指向 `AGENTS.md` 的符号链接（同 deepseek-harness 的做法），**编辑真实文件**。
每条规则保持自解释，细节链接到对应设计文档。能压缩就压缩，但不要为了短而丢掉"为什么"——
本文件里的多数规则是 M0 用实测换来的结论，去掉理由就会被下一个人当作可选项。
