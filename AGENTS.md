# AGENTS.md

hivemind 是 7x24 自主编码 agent 服务：从 Notion 看板接单，拆解后以 TDD 驱动开发，交付 MR 并回写业务语言报告。
改动任何 `src/` 之前先读 [docs/design/00-overview.md](docs/design/00-overview.md)（架构、决策、路线图）；
实施任务与验收判据见 [docs/plan/tasks.md](docs/plan/tasks.md)，设计与清单冲突时以设计文档为准并回写清单。

## 分支门禁

`main` 只经 PR 推进,两层门禁都已生效:GitHub 的 ruleset(仓库侧,唯一挡得住的一层，禁止直推、强推与删除)与 `.githooks/pre-push`(本地,由 `npm run prepare` 设 `core.hooksPath` 装上,让拒绝发生在网络调用之前并给出改法)。
直接在 `main` 上提交后再想推,唯一的出路是 `git switch -c <branch>` 把提交带到分支上；不要用 `--no-verify` 绕本地钩子——仓库侧照样拒。

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
  pipeline/       无状态全量注入(phase prompt 组装) + DoD/收敛判据 + verdict 校验 + 各 phase 确定性出口检查
  orchestrator/   三层状态机(需求/Epic/Story) + intake + 调度纯函数(拓扑/footprint/hotspot)
  notion/         gateway(令牌桶+优先级+outbox) / sync(评论水位) / blocks(页面 builder) / 意图解释
  guard/          danger-rules + 运行时红线（CODE 冻结测试的 fencedPatterns / VERIFY 的导航白名单）；工具面全阶段统一，pi 侧钩子在 extensions/
  queue/ worker/  DB 可派发集 + 租约 CAS 领单 + worker daemon(心跳/能力声明/粘性恢复)
  regression/     RegressionScheduler + 场景注册表 + 归因二分 + 失败签名
  judge/          结构化判官：pi 之外的第二条模型路径，只回类型化判断不生成文本；每个问题都有确定性地板，判官没意见即用地板
  vcs/ verify/ report/ memory/ observability/ alert/ console/ util/
prompts/          基线层 + per-phase prompt，各自独立文件
extensions/       pi extension：hive-guard / model-policy 兜底（浏览器不走 MCP，见 02 §4.3）
poc/              M0 PoC 脚本（可丢弃）；scripts/ 为长期保留脚本
fixtures/         真实采集的契约 fixture（rpc-errors/ 来自 M0-05 实测；model-catalogs/ 由 scripts/catalog-snapshot.ts 采，非手写）
docs/design/      冻结设计 00–07；docs/poc/ 为 M0 执行记录与逐项 go/no-go
```

除 `memory/`（交付后蒸馏，排在 MR 之后）与 `worker/`（多机 daemon，排在 M3）之外全部已落地；单机全流程可跑，入口见下节的 smoke 与常驻脚本。

## 命令

```sh
npm test          # vitest 单测，是提交前的默认门禁
npm run lint      # oxlint src poc scripts
npm run typecheck # tsc --noEmit，strict
npm run build     # tsc 产出 dist/
npm run db:migrate
npm run preflight                              # 就绪探针：pi/凭据/Notion/CLI/仓库可达性/systemd/浏览器，不打印任何凭据
npm run health                                 # 推进探针：卡/Epic/回归/outbox 是否真在动；只有"卡住"才非零退出，"等人"不算
npm run orchestrator:run                       # Epic/Story 执行常驻（服务注册表里的全部仓库）
npm run requirements:run                       # 产品经理常驻（与上者共用一库一 outbox）

npx tsx scripts/repository-add.ts <git-url> [--default-branch main]   # 注册一个仓库并在本机拉出 checkout

npx tsx scripts/serve-console.ts [--port 4319] [--db <url>]          # 只起控制台（只读），供 ui/e2e 场景在浏览器里核验；库由 HIVEMIND_DB_URL 指定

deploy/linux/install.sh --repository-url <git-url>   # 部署唯一入口，幂等；Ubuntu / Arch(Omarchy) / WSL2 Ubuntu 同一条命令

npx tsx scripts/catalog-snapshot.ts <provider>   # 采 provider 目录快照（该机需有这家凭据）
npx tsx scripts/provider-add.ts <provider> ...   # 声明 provider（写 model.providers，等价于在 console 上改）

bash scripts/install-sol-pi.sh                   # 装 pin 住的 SoL-Pi extension（幂等，与 pi 同样按 ref 并存）

npx tsx scripts/smoke-runner.ts            # 真实 pi 子进程冒烟
npx tsx scripts/smoke-context-isolation.ts # 验证 context 文件不泄漏
npx tsx scripts/smoke-crash-recovery.ts    # SIGKILL 后从 checkpoint 续跑
npx tsx scripts/smoke-browser-e2e.ts       # 真实 headless 浏览器 + 三层红线
npx tsx scripts/smoke-blind-verify.ts      # 盲审拿不到 CODE 的会话，只拿得到树
npx tsx scripts/smoke-story-pipeline.ts    # 单机全流程：SHAPE→…→DELIVERED + Epic 合流 + 回归道（确定性 mock provider）

npx tsx scripts/inspect-round.ts --card-id <id> [--round N] [--prompt] [--tools]   # 一轮一屏：prompt 分段、工具、自述、commit、两条道的逐场景结论
npx tsx scripts/replay-phase.ts --card-id <id> --phase CODE --print-prompt        # 用中央状态重组一个 phase 的 prompt；给 --worktree 则真跑，不写库不动状态机
```

Node `>=26`，ESM，包管理用 npm。部署只有 Linux 一条路：Windows 主机跑在 WSL2 Ubuntu 里，不再有原生 Windows 路径。
`deploy/linux/install.sh` 是唯一入口，每个阶段先查再做，人工步骤（凭据、pi 登录、gh 登录）原地停下、重跑续接；见 [docs/runbooks/linux-single-node.md](docs/runbooks/linux-single-node.md)。
pi 版本 pin 只写在 `package.json` 的 `hivemind.piVersion`，代码经 `src/runner/pi-binary.ts` 取，shell 经 `node -p` 取，不得再出现字面版本号。
SoL-Pi 的 commit pin 同理只写在 `hivemind.solPiRef`，代码经 `src/runner/sol-pi.ts` 取。
`scripts/` 只放长期入口（run-* / smoke-* / serve-console / preflight / health-check / notion-bootstrap / install-pi / install-pi-models / install-sol-pi / pi-login / catalog-snapshot / provider-add / repository-add / inspect-round / replay-phase）；一次性排障脚本用完即删，不进仓库。

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
- **UI 验收走查是独立的一道,且只有功能能否决**:盲审判"测试是否证明做成了",走查判"用户打开这页看到的对不对"(03 §9)。一次返回两组结论——逐 scenario 的功能验收**能**打回 CODE,界面 findings(间距/一致性/文案/状态/布局)**永不**否决、不进 failed 集合、不消耗轮次,所以 severity 没有 blocking 档。审美不能否决是结构性的:收敛判据在品味上不成立,给了否决权的评审每轮挑出不同一处细节、失败集合永不重复,于是判据永远放行、卡只会烧完预算,正是 §8 消除的失效模式。它只在功能道已 accepted 的轮次、只对 `ui`/`e2e` scenario 跑;原型图是参考不是判据;目录里没宣告图片输入的模型不派去看界面。
- **余额不预警,假设充足**:没有余额查询 API,靠估算猜只会得到不可信的数;真耗尽时 API 自己返回错误码并被分类为 QUOTA。唯一有业务意义的护栏是单任务上限,不是账户余额(03 §9.4)。
- **全系统只有四类真停点**：`blocking_question`、`verify_loop_exceeded`、`retry_limit_exceeded`、`cost_ceiling_exceeded`（见 03 §1.5，DB CHECK 强制）。新增停点需要改设计文档。
- **轮次上限管"打转"，费用上限管"敞口"，互不代替**：同样 6 轮内环在 1M 模型上花费差一个数量级，所以 `cost.perCardUsdCeiling` 独立于 `retry.*`，在 phase 边界检查（turn 掐不断，故上限是超支下界而非精确切口），且**订阅额度不计入**——包月的钱花不花卡都一样。哪家算计费由 profile 的 `billing` 决定,不写则按 `authType` 推(api_key=计费 / oauth=订阅),付费型 OAuth 账号必须显式写明;卡跑在订阅 provider 上时 `spend` 端口**不挂**——一个永远回零的端口读起来像上限在生效,而其实什么都没管。费用停点不出诊断、不进反思管道：它对"这活能不能干成"零信息量。
- **内环收敛判据是"不得重复"**：`failed(N)` 与此前任一轮（回看窗口 `retry.oscillationLookback`）相同即停 `verify_loop_exceeded`——下一轮会是已经跑过的那一轮。换掉一批失败（修好三个、坏掉一个）是进展，照常消耗一轮继续；兜底是轮次预算而不是判据。轮次硬上限（内环 3，含归因到本 Story 的合流打回 / phase 连续崩溃 3，前进即清零 / continue 8 / regression 重开 2）设在离散轮次，不设在时长或 token；内环预算耗尽停 `retry_limit_exceeded`。
- **技术栈与界面是需求级决策，不是卡级决策**（08）：PRD 与拆解禁写技术方案、DESIGN 禁止提问且只看得见一张卡，所以此前**没有任何一层的作用域够大**——需要新栈的需求只能被某张卡顺手决定，涉及界面的需求全链路没有一处描述"长什么样"。需求层为此加一道 `SOLUTION` 关（PRD 确认之后、拆解之前）：产出选定方案与被否的备选、`stackChanges`、`openDecisions`（这是"主动提技术疑问"的出口）、`qualityGates`，涉及界面时再产出进仓库的界面契约（`docs/prototype/` 的 token 表 + 组件清单 + 可运行页面原型）。**停不停人由确定性条件决定**：`stackChanges` 或界面契约非空即必须人批，不接受模型自称不用审。卡越界改依赖由 CODE 出口拒掉并升级回这一关——仓库级不可逆的决定不由一张卡替所有卡做。等人仍停在 SOLUTION 状态内，四类真停点不变。
- **界面判据分三层，只有前两层能否决**（08 §6，修订 03 §9.2）：结构层（该场景声明要看见的角色与文本是否出现在 aria 快照里）与契约层（色值/字号/间距是否全部来自 token 表）可否决，因为两者有限可枚举、可收敛；观感永不否决。**像素级一致不做**——它是无限精度的判据，模型每轮都能挑出新的一处差，失败集合永不重复、判据永不生效，卡只会烧完预算。原型的作用是给前两层供数，不是一张要被像素对齐的图。
- **「这一页在不在」是代码问题，「这一页对不对」才是浏览器问题**（03 §13）：写好了组件却没在产品入口挂上，单测照样全绿，而能抓住它的场景 `layers` 是 `["e2e","ui"]`，于是这件 code 层完全证得了的事被整条交给了浏览器道——`applyDowngrades` 只朝一个方向开口（code 证不了 → 交给浏览器），反方向没有出口。所以屏幕场景必填 `page`（应用里的路径，与 `visible[]` 同一轮要），CODE 与 REGRESSION_FIX 出口起仓库声明的应用逐个打开它，findings 回喂同一 session（不耗轮次）。判据刻意窄：只有 **404/410** 与**完全没应答**会拒，302/401/500 都说明路由挂上了，要求 200 会让每个需要登录态的页面依赖这一阶段造不出来的数据。仓库没声明启动命令、或这一轮应用起不来，都什么都不问——此刻"箱子起不来"与"代码把启动搞坏了"是同一个观测。同一批补上了三层防造假里缺掉的第三层：屏幕场景报的页面地址必须与应用道同源（此前只有 prompt 一层，而 host 白名单是主机名级的，自起服务的端口照样在 localhost 上）；工具面那一层仍未做。
- **改东西的页面要有「改完之后还在」这条验收**：只在"改的那一刻"判定的屏幕场景，换成一个每次打开都重置的假存储也照样全绿——R237511RC 与 R237511TR 正是这样被建成、跑绿、并一路走到人面前的（2026-09-22）。这不是评审的眼睛该抓的事：保存不落地是这种页面唯一的、且**必现**的失败，必现就意味着它属于验收标准。所以屏幕场景必答 `mutates`，答 `true` 的必须用 `persisted_by` 指向一条同页、同样在浏览器里判定的「重新打开还在」场景，由 SHAPE 出口确定性把关、findings 回喂同一 session。判据故意只问结构（答没答、指向的那条在不在、是不是同一页、是不是浏览器道），不读散文——读散文就等于让这道门的结论取决于措辞。

- **出口检查只有一套机制**：`evaluate → findings 回喂同一 session → 重解析`，每个 phase 的出口由一张表声明（`pi-phase-port.ts` 的 `builtInGates`），调用方需要现场状态时自己传 gate。会话内回喂是关键：拒绝是一个工作项，不是对 Story 的判决，所以不耗轮次、不算重入，也不用重新加载这个 session 已经读过的东西——S-AGENTRULES-01 就是被两次"换个 session 重做"的 SPECIFY 拒绝停掉的。每个 gate 声明用尽轮次后是 `fail` 还是 `ship`：没有否决权的那些（交付报告、设计摘要）照发，因为卡在文字上比文字不好读更糟。

- **判官只许把答案从确定性地板上移开，且只往安全的那一边**：`src/judge/` 是 pi 之外的第二条模型路径，只回类型化判断（Noul / Choice / Score），不生成文本、不进 failover chain、不计费用上限。每一个问到它的问题都必须先有一个确定性答案，判官不可用、超时或不确定时那个答案就是全部答案——所以它**永远只能加**，不能把地板已经判定的东西拿走。方向由代价决定而不是由准确率决定，而且**两个问题的安全方向不一样、阈值不共用**：环境/代码这一处，把真缺陷读成环境会让卡永不收敛，把环境失败读成代码只损失一轮，所以只许往环境侧移；Notion 批准意图那一处，漏读一次批准只多重写一版而人会再说一遍，凭空读出一次批准则是没人批准过的东西被拿去建，所以门槛更高（01 §4.2.1）。问题一次只问一条（一条理由 / 一条评论一个请求）：实测同一句话的概率随同批内容摆动 0.29，而固定输入重跑只差 0.02，批量问会让一条的结论取决于同批恰好还有什么。判断随该轮 / 该次轮询用掉，不在 prompt 组装路径上，`assemblePhasePrompt` 的逐字节确定性不受影响。默认关，开了而缺凭据要说出来；每次移动都记 friction，用数据决定留不留。

- **自己写下的理由不进猜的那条路**：模式表读的是模型写的散文，这是它存在的全部理由。hivemind 自己从一个它检查过的条件里发出的理由——验证道声明了却没留下的页面结构记录、验证道自报的 `inconclusive`、箱子没能起起来的应用——不是待识别的散文，写它的那段代码就知道它是什么，所以由产出方直接标注（`ScenarioReason.environmental`），既不问表也不问判官。把这类理由丢进表里，等于让它的分类取决于措辞、再取决于判官对该措辞的把握：`snapshot does not exist` 因为表里写的是 `screenshot` 而长期落空，同一轮四个场景问成四个问题、两个过线两个没过，S-R237511OV-02 的预算就花在这个差别上（2026-09-19）。反向不成立：运行记录里判为失败的场景，`inconclusive` 盖不住它——箱子自己的记录压过模型的自述。

- **状态只经守卫语句写**：Epic 与 Story 的 state 一律由 `epicTransitionStatement` / `storyTransitionStatement` 生成——声明的边与 `WHERE state = ?` 守卫出自同一对状态，不可能分叉，并发下输的那个拿到 `rowsAffected === 0` 而不是覆盖赢家。它们返回语句而不直接写库：迁移必须和它的事件与看板投影同一 batch 落地，拆开就会有状态变了而没有记录的那一刻。全仓不应再出现手写的 `UPDATE epics/stories SET state`。

- **加一个仓库也是数据改动**：`repositories` 表只存 slug、clone URL 与默认分支，本机 checkout 路径由 `<workRoot>/repos/<name>` 推出来——路径是单机状态，写进库在第二台机器上就是错的。仓库**永远由 hivemind 自己 clone**，不复用操作者的 checkout（那棵树停在谁的分支上都不一定），主 checkout 保持 detached 以便 worktree 取任意分支。需求卡的「目标仓库」只在注册表里选；选了没注册的就留在看板上不入库，人补一下属性下一轮即被接走。

- **加一个 provider 是数据改动，不是代码改动**：`model.providers`（registry 键，console 可编辑，标了 dangerous）声明每家怎么认证、每档用哪个模型；代码里不出现任何字面 model id。加进 `model.failoverChain` 是另一个决策，分开配、分开审计。
- **chain 顺序是成本决策：订阅在前、计费 API 在后**。包月的钱花不花都一样，所以订阅能扛的每一轮都是 deepseek 不用出的钱；deepseek 在链上是为了在订阅撞到 usage-limit 窗口时让服务不停，不是分担负载。
- **大脑档是这条成本序的唯一例外，由 `model.tierFailoverChains` 单独排序**：拆解/设计/界面走查读的是人话、判的是屏幕，这一档最强的模型在前（`gpt-5.6-sol`），便宜的在后。它后面仍挂满整条链——**订阅打满只许降级，不许停工**；全系统唯一能因"没模型可用"停下的原因，是最后那个计费 API 没钱了。per-tier 顺序只能命名 `model.failoverChain` 里的 provider（`assertModelPolicy` 强制），因为链才是发凭据、采错误文案、记熔断状态的那份全集。
- **provider 目录有两个源**：pinned pi 的实时目录是权威，`fixtures/model-catalogs/` 的采集快照是无 pi / 无该家凭据时的兜底（漂移测试守住一致）。快照进仓库还有第二个作用：它让"这个 model id 是否存在"变成**同步**判据，配置写入当场就能拒绝坏 id，而不是等到 spawn 时卡住一张卡。
- **验证命令永不硬编码**，由 agent 看现场决定。防造假靠三层：prompt 约束、工具面物理掐断、verdict 代码校验；三层缺一不可，prompt 是最弱的一层。
- **带 `then_run` 的工具调用要过同一套 shell 红线**：SoL-Pi 的 Action Fusion 让 `edit`/`write` 捎带一条命令，而守卫此前只对 `bash` 读 `command`——命令换个位置，工具面那层物理掐断就被整层绕过，CODE 冻结测试的 `fencedPatterns` 同时失效。判定在 `decideToolCall` 最前面，对**任何**带 `then_run` 的调用先判一次（不只今天被替换的那两个工具），`then_run` 在而 `command` 不是字符串时拒绝而非忽略。真实 pi 的证明在 `scripts/smoke-guard.ts` 的 FUSED 探针。
- **SoL-Pi 只收两个机制，且开关是数据不是代码**（07 §6a）：Action Fusion 与 ObservationPack 由 `agent.solPi` 开关，`~/.pi/agent/sol-pi.json` 每次 spawn 前由 `resolveAgentSpec` 渲染（同 `models.json` 的模式与理由）。**Evidence-Preserving Reducer 永不开**——它在 extension 内部调第二个模型，那条调用不过 RPC 事件流，费用上限、熔断、错误分类、`turn_usage` 全都看不见它。**Online Context Compact 也不开**：它省的是 cache read，而我们绝大部分流量跑在订阅 provider 上，这份节省是零，代价却是 NVIDIA 自己消融里唯一的掉分。工具名 `obs_recall` 与扩展装载必须同生共死——实测 pi 对白名单里的未知工具名静默忽略，没有运行期报错兜底。
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
- **pi 内置目录之外的模型声明也是库里的数据**：写在 `model.providers.<provider>.declaration` 里，`ModelPolicy.resolve` 在 spawn 前渲染到该机的 `~/.pi/agent/models.json`（`src/runner/pi-model-declarations.ts`，原子写、内容未变则不写）。加一家 provider 因此不再动代码、不再重新部署，每台机从同一行渲染同一份文件——「这台机少装了一个 id」不再是一种可能，而不是靠测试去抓。声明里 `input` 不写 `"image"` 就永远不会发图（pi 默认 `["text"]`），`cost` 不写就静默记 0；`apiKey` 只写 `$ENV_NAME`，密钥永远留在 `secrets.env`。首次写入时没有任何快照见过这家，所以校验此刻认声明里的 id；pi 自带的 provider 仍由快照守着。
- **model id 存在 ≠ 本账号可用**：ChatGPT 订阅账号会拒掉 pi 目录里照样列着的 id（实测 `gpt-5.4-mini` / `gpt-5.4` / `gpt-5.3-codex-spark`，见 06 §3）。快照只能回答"是否存在"，"能否用"只有真实往返能回答——这就是 preflight 除凭据探针之外还要花一轮 capacity_probe 的原因。
- **凭据探针一律 `--no-refresh`**；`pi auth check` 在 `not_ready` 时**退出码仍为 0**，必须解析 JSON status。存着 token 就报 `ready`，refresh 是否还能用它不知道。
- **spawn 前清理陈旧 `auth.json.lock`，握手超时高于 pi 的 30s 夺锁窗口**：被 SIGKILL 的 pi 留下锁目录，下一个 pi 静默等满 30s——击杀/隔离/宿主机真死后的第一次 spawn 必然卡死。清理只认 mtime 超 30s（pi 自己的判据），夺不走活持有者的锁：破锁会让两个进程轮换同一个 refresh token，双双作废。
- **放弃一轮之前先 `clear_queue` 再 `abort`**：`abort` 故意保留 steering / follow-up 队列并在之后继续投递，不清就等于用刚被丢弃那一轮的指令去驱动下一轮。
- **等人不算在干活**：RPC 下"阻塞等人"的信号是 stdout 的 `extension_ui_request`（对话类方法要等 stdin 回 `extension_ui_response`），不是 extension 侧的 `ui_prompt_start/end`——后者在 RPC 模式不发。心跳读 `waitingOnUser`。
- **usage-limit 文案里的分钟数是相对值**，锚定事件自身时间戳，不能锚定"我们读到它的时间"——在 outbox 积压过就会算错窗口。

### 给人看的产出

- **每个模型产出的字段先分清读者**：给人读的（场景名与 given/when/then、验收标准、设计摘要、verdict 的 `reason`、
  交付报告业务段）用中文业务语言，给下游读的（`technical_notes`、`detail`、技术细节段）怎么准确怎么写。
  新增字段先回答"这是给谁读的"，两类内容不共用一个字段——分开之后"这段合不合格"才是可判定的，
  技术内容也永远有地方去，不必为了合规被删掉。
- **语言要求由确定性出口把关，不靠 prompt 自觉**：`lintHumanSentence` 判语言与实现词汇，findings 回喂同一个
  session 重写（SHAPE 的 DoD、DESIGN 的摘要、MERGE 的报告各一条回路）。判官可以在 DESIGN 摘要与
  MERGE 报告上**追加** findings（全中文写的实现散文，正则看不见），但只因为这两道 gate 声明了
  `exhausted: "ship"`——概率永远停不住一张卡。`lintHumanSentence` 本身与拿得到否决权的那些 gate
  不进这条路径：同样输入必须得到同样结论，否则 `assemblePhasePrompt` 的逐字节确定性就没了。
- **约束解码拿不到**：pi 的 RPC `prompt` 只收 `{message, images}`，没有 output schema，链上又有订阅型 OAuth
  provider 不经我们自己的 API 调用。结构保证止于 zod，语言保证止于出口检查——要再往上一层得先给 pi 提能力。
- **被退回的次数记进 friction**（`dod_language_rejected`），用数据决定要不要加强这条规则，而不是靠猜。

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
