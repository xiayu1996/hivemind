# 单节点需求自主执行闭环：代码与数据核验及优化方案

核验日期：2026-09-11（Asia/Shanghai）。基线：`fix/resume-reads-repo-config`，HEAD `a29eb7a`；读取本机 `data/hivemind-mp.db`、相关轮次产物、决策记录和 GitHub PR #26。本文是优化方案，未实施运行状态修复。

## 1. 结论与完成定义

当前已经证明“部分 Story 能自行开发、验证、交付到 Epic”，尚未证明“一个完整需求能在单节点自行执行并闭环”。最主要的差距在需求契约、验证环境、回归归属与发布验收之间的连接，以及系统故障的恢复。继续增加模型、并发或重试额度不会解决这些问题。

建议保持现有中央数据库、PM/执行两个循环、Story 流水线，先完成本文 P0/P1；暂缓多机扩展。保留 builder/verifier 隔离、功能验收否决权、审美 findings 不否决、严格真子集收敛与四类停点。必要的变化应先更新设计，不能用放宽验收掩盖错误。

“自主”允许人回答业务问题、批准范围和做最终业务验收；不应要求人识别浏览器故障、改库、找 PID、补推分支或写一次性恢复脚本。人工 GitHub 合并目前也是实际 gate，但 MP-10 只列四类人工 gate，没有包含它，必须明确选择：保留并如实写进验收规则，或由用户预先授权合并策略，再在受保护 PR 路径上自动合并。不能把当前 PR OPEN 简单归结为用户欠系统一个动作。

目标链条为：冻结需求与回答 → 具备可运行环境的垂直拆解 → CODE/VERIFY → Epic 集成验证 → 受保护 PR 合并 → 可访问且版本明确的验收实例 → 逐场景验收 → 缺口补单并重新验收 → DONE。系统故障应在链条内部被识别、恢复和记账。

## 2. 对原修复总结的校正

| 项目 | 本次核验 | 含义 |
|---|---|---|
| 修复分支 | 工作区核验前干净，HEAD `a29eb7a`；相对本地 `origin/main` 有 19 个提交 | “10 个提交”不是当前比较口径；本次未据此推断远端同名分支是否存在 |
| M0/M1/M2 已关 | tasks.md 的 M2-09/11/12/14/17/18 仍保留活体缺口 | 不能把单测/进程内验收等同于真实运行验收；也不能仅凭旧清单断言代码仍未接线 |
| IT-05 未实现 | `failure-classification.ts` 已包含 route not found、旧页面、无法复现等规则 | 应记为已实现但不完整；实际浏览器错误仍漏判 |
| IT-16..22 可全部勾选 | 多处代码存在，但 IT-17/22 明确要求实跑；当前回归数据为空 | 按“代码存在、生产可达、离线通过、活体通过”分别记录，不批量补 ✅ |
| MQ-10 仅差记录 | mp-acceptance.md 已有“首次完整链路”记录；S-E3OVERVIEW-01 因已在 Epic head 而没有独立 MR | 与原判据不完全一致，需要正式说明等价判据；不是单纯补文档 |
| website 状态 | 需求 EXECUTING；E1ACTION EPIC_ACCEPT；E2RESULTS/E3OVERVIEW BLOCKED；7/12 Story DELIVERED | 与总结主体吻合；验收项目表尚为 0 行 |
| PR #26 | GitHub 实时读取为 OPEN、非 draft、MERGEABLE，目标 main | 可合并不代表已完成本报告要求的当前版本集成验收 |
| $20.92 为计费花费 | 总账合计约 $20.9223，其中 `is_subscription=0` 为 $12.6553，订阅估算 $8.2670 | 原总结混加了两种口径；早期 Codex 记录还存在标记可疑的问题 |
| Linux 验收 | 文档记载干净 Linux 容器安装与浏览器冒烟，业务需求执行证据来自 macOS | 不能认定带凭据的 Linux systemd 单节点业务闭环已经通过 |

费用细分：DeepSeek 非订阅 $0.3401；Codex 早期非订阅标记 $12.3152（09-05）；Codex 后期订阅标记 $8.2670（09-10..11）。这些是数据库值，不是银行账单。早期 Codex 是否应改为订阅，必须依据当时认证/计费配置追溯，不能仅凭 provider 名称批量改账。

## 3. 当前阻塞的证据与处理

### 3.1 S-E2RESULTS-01：存在三类独立问题

数据库记录第 9、10 轮 accepted，第 11、12 轮均 rejected，最终 `verify_loop_exceeded`，累计 round=12。累计编号不等于当前预算已消耗 12 次。

- 第 11 轮：验证器报告页面显示 `accepted delivery` / `failed` / `recovered failure`，而 DoD 写的是首字母大写；另有 `duplicate requirement` 与 `duplicate_requirement`、缺字段原因标识之间的差异。这是相对当前 DoD 的契约不符，不能直接归为环境问题。是否看到了旧构建，现有记录不足以证明。
- 第 12 轮：五条理由全部为 `net::ERR_CONNECTION_REFUSED`，没有截图。当前分类函数对这一真实文案返回 false，因而环境故障进入代码失败集合，导致无收敛停牌。应优先修复此确定性漏判。
- 更上游：本地代理决策 D3 记录的回答是“同一个失败对象在 Notion 恢复/重启且不再终止才算恢复；关联需求交付不算”；当前 DoD 则采用“后续交付关联原失败”。mp-acceptance.md 已披露这处冲突。应核对已归档 Notion 回答的有效版本，修订 DoD 与代码，不应等到最终业务验收才处理。

当前 worktree 已有大写标签代码，说明不能再用第 11 轮截图直接断言最新代码仍有同一缺陷。恢复前必须绑定当前 HEAD 与新启动的服务重新验证。本次没有重启应用或调用真实 pi，故不宣称此卡功能已通过。

### 3.2 S-E3OVERVIEW-02：修复代码与恢复现存状态是两件事

实际状态为 NEEDS_INPUT，`retry_limit_exceeded`，resume_state=VERIFY，round=0，phase_reentries=1。当前入口已经接受 VERIFY，worker 也有回 CODE 的恢复路径，但修复代码不会自动清掉既有停点。

建议通过有审计的恢复入口执行：核验停因、记录修复版本、保留原历史、只重置对应失败预算，再续跑。不要用裸 SQL 修改 state，也不要抹掉失败记录。需重新 DESIGN 时应由契约变更决定，不能把所有恢复都当重设计。

### 3.3 E1ACTION：交付成功，但回归证据不足

6/6 Story DELIVERED、PR #26 OPEN 是确定事实。与此同时，实际库 `regression_runs=0`，31 个 registry 场景 `last_verified_at` 全为空。不能据“没有 open regression card”证明 Epic head 已回归通过。

## 4. 优先修复的系统缺口

### P0-A：验证绑定真实版本，并区分环境、代码和证据故障

代码入口：`src/verify/app-under-review.ts`、`src/orchestrator/ui-reviewed-verify-port.ts`、`src/orchestrator/blind-verify-port.ts`、`src/pipeline/failure-classification.ts`、`src/orchestrator/story-worker.ts`。

当前问题：

1. 应用启动/seed 仅包在功能盲审 accepted 之后的走查阶段，不能解决功能盲审本身起不了服务的问题。本机也没有配置 `verify.appStartCommand/appReadyUrl/seedCommand` 的 overlay。
2. readiness 仅看 HTTP 2xx/3xx，无法证明响应属于当前 worktree/HEAD，可能认领已有旧服务。
3. 分类既漏掉浏览器连接错误，也把 HTTP 500、route not found 等宽泛归为环境。正确版本的应用返回错误同样可能是真缺陷，不能无限免责。
4. inconclusive 当前仍回 CODE；连续达到上限后写成 `verify_loop_exceeded`。这会让环境问题触发无意义代码修改，最终仍由人处理。

改进：

- 建立仓库级运行清单，由 agent 探索项目后生成并验证，声明启动、构建、就绪、seed、cleanup 及测试命令。不在平台硬编码项目命令。
- 由同一个应用生命周期管理器为功能盲审、UI 走查和回归提供环境；每次分配独立 runId、端口、样本库、进程组、证据目录。记录实际 argv、cwd、HEAD、构建标识和健康响应；退出/崩溃均清理子进程。
- 对服务做身份核验，不能只探一个可用 URL。共享本地端口时禁止未经确认复用；验收证据中保存服务与代码版本的绑定。
- 结构化记录 `origin`、错误码、服务身份和证据状态，模型理由作为解释；真实错误文案作兼容兜底。确认环境有效后，应用自己的 404/500 应进入功能失败。
- 环境故障先修环境、重试 VERIFY，保持 CODE HEAD 不变；恢复尝试数与代码收敛预算分开。未知故障不能当通过，也不能无限重试。耗尽恢复次数使用现有 `retry_limit_exceeded` 并带环境来源；修改设计中的停点语义说明，保持四类停点。
- 对大小写/精确文案明确“必须逐字一致”或“语义等价”，由需求约束决定。不能因为失败是文案就绕过 DoD，也不能让模型自行把字段枚举当成用户必须看到的文案。

验收：用 E2 第 12 轮原文回放必须进入环境分类；注入端口冲突、旧服务、服务崩溃与真正的应用 500，分别走正确路径；前面三类不新增代码失败预算；健康环境中的业务错误不得漏过。

### P0-B：恢复 Epic/main 回归的真实含义

代码入口：`scripts/run-story.ts:344`、`src/regression/scenario-registry.ts`、`src/regression/epic-gate.ts`、`src/regression/blind-sweep-port.ts`、`scripts/run-regression.ts`、`scripts/run-local-orchestrator.ts`。

已确认问题：

- Story DELIVERED 即 promoteToMain，但实际交付目的地是 Epic。库里 E1ACTION 的 22 个、E3OVERVIEW 的 4 个场景已经在 main 池，而对应 Epic 尚未合入 main。
- `epicRegressionClean` 只查未关闭回归卡；没有运行记录也返回 clean。
- sweep 向验证器只传 scenario id 字符串，未加载完整 DoD/source/seed，也没有传 `screenScenarioIds`；与 Story 验证契约不同。
- sweep 把 inconclusive 转为全部 failed，环境错误可能触发回归立卡和错误归因。
- `run-regression.ts` 使用空 tree capture、空 quarantine 与空 record sink；没有接 Story 的 telemetry/cost recorder。守卫仍存在，但无法据此声称完整 tree-pin 与账本保证相同。
- 调度的 Epic 场景可跨 Epic 选入同一批，再取首个 Epic 的 worktree；main tree 建立后没有在该路径显式更新到最新 main。两者均需补跨版本测试。
- 当前 cycle 在派 Story 后同步等待 sweep；长回归可能延迟下一轮 intake、投影和维护。现存回归表为空的确切运行时原因尚未定位，不能仅凭代码推断已经执行过。

改进：

1. Epic 内场景直到平台确认 Epic 合并且记录 merge SHA 后才进入 main；独立 Story 则在其目标分支合并后晋升。
2. 回归任务按 repository/pool/Epic/revision 分组，固定目标 SHA；加载完整冻结场景契约、应用环境、证据约束和真实 tree-pin。
3. 发布 gate 同时要求预期场景完整覆盖、结果通过、验证 revision 匹配目标版本、无未解决功能回归。零记录、缺结果、旧版本均为等待，不是通过。
4. 引入 inconclusive 的独立回归结果，不进入确定性缺陷统计和归因；保留 suspect/flaky 机制。失败卡只有在有效复测通过后才能 resolve。
5. main 池回归也应能找到引入提交并物化修复工作；当前脚本仅在有 Epic+probe 时归因，main 路径不能只留下无人接手的卡。
6. 前台工作优先，但交付前的必要验证有保留机会；后台 sweep 独立执行并回报状态，不长时间阻塞 intake/投影。保持单节点的有限并发，不为此引入新队列体系。

验收：一张 Story 仅合入 Epic 时绝不进入 main 池；Epic MR 没有当前 SHA 验证不得通过 gate；两个 Epic 的场景不混跑；人为破坏一个场景后完成“发现→复测→立卡→定位→修复→复验→关闭”；环境失败不立功能回归卡；费用与证据落账。

### P0-C：代码、实际数据库与运行进程版本一致

权威 `0001_init.sql` 支持 `cost_ceiling_exceeded`，本机实际 stories CHECK 仍只有三类。列结构一致不代表约束一致。`migrate()` 仅按文件名判断已应用，改写过的 0001 不会重放，启动会把旧库当作已迁移。

改进：启动 preflight 校验实际 schema fingerprint（含 CHECK/索引/外键）与期望版本，运行进程登记代码 SHA、schema 指纹、配置版本、prompt 版本；不满足兼容条件时停止接新任务并明确报因。不要边运行边临时改表。

按预发布规则，新验收环境从 0001 创建干净库，不增造兼容迁移链。现有 MP 实验库含不可丢失的澄清与历史，不能直接删除；先一致性备份并验证可恢复，作为原始证据保留。若要继续使用现存任务，应另外设计一次可审计的重建导入流程，核对行数、关系与状态，不能把手改表当常态。

验收：旧三类约束被 preflight 识别；新库成功落费用停点；两个 daemon 读到同一版本；备份恢复后需求、任务、成本和 outbox 可对账。

### P0-D：冻结业务含义，防止“实现可行”反向修改需求

代码入口：`requirement-artifacts.ts`、`requirement-decompose.ts`、`dod.ts`、`story-execution-store.ts`。

场景有 source/examples 并不证明它忠于批准的需求。E2 恢复含义被替换就是反例。当前 DoD 还把真实 Notion 同步排除在范围外，如果没有另一张 Story 明确负责真实数据连接，全部样本测试通过也可能交付一个看不到真实运行状态的页面。

改进：保留 PRD 场景→批准回答→Epic→Story→DoD→验证证据的版本化映射；source 引用输入事实而不是仅写实现表名。冻结前检查遗漏、冲突、新增限制、out_of_scope 和 relies_on 的责任归属。业务语义检查可使用独立结构化评审，但不是重新引入对所有 CODE 出口的泛化 completion judge。权威答案已存在时直接回 DESIGN 修正；确有歧义才问人。

严格真子集仅在同一冻结契约及可比较的验证上下文内比较。契约修订须保存版本关系、废弃旧可复用产物并记录原因；不能把修改场景列表用作重置失败集合的捷径。

验收：包含“关联需求交付不算恢复”的输入不能产出 successor=恢复的合法 DoD；每条 PRD 场景至少有一个明确负责人和最终验证路径；真实数据接线不能无人负责。

## 5. 完整闭环的 P1 工作

| 工作包 | 具体改进 | 验收判据 |
|---|---|---|
| P1-A 恢复与重入 | 将系统恢复与人工暂停分开；恢复记录故障来源、修复版本、前后状态和保留的 HEAD/契约。对外部副作用做“先查是否已完成，再继续”。为单写者增加进程所有权/重复启动保护，复用现有中央租约与 fence 思路 | 在 CODE 完成、VERIFY 中断、PR 已创建、ff 已完成、报告未写回等边界逐点杀进程，重启后无双执行、无重复 MR、无丢任务；HUMAN_PARKED 永不自动恢复 |
| P1-B 验收补单原子性 | `AcceptanceChecklist.settle()` 当前分多次提交：建 gap Epic、重开项目、切状态。将验收轮次及 gap 创建绑定稳定键，用事务提交内部状态与 outbox | 在每一步中断并重试，只有一个 gap Epic，既有勾选不丢；修复后只重开待验项目，全部通过才 DONE |
| P1-C 合并与可访问验收 | 明确 PR 合并授权策略；保存合并 SHA。按项目运行清单启动验收实例，呈现 URL、版本、样本与真实数据口径；自举时运行器版本与被开发产品版本分离 | Epic 合并后能打开对应版本；PRD 场景可以照单操作；若还未达到可访问条件则显示具体等待原因，不能只有“已合并” |
| P1-D 未合并关闭的 PR | 当前 closed→EXECUTING 会清 mr_url，下一轮可重新开 PR；需要区分技术关闭、人工拒绝、替代 PR | 明确人工拒绝不会被自动重新开同内容 PR；有替代关系时追踪新 PR；有效反馈回到执行链 |
| P1-E 公平调度与故障隔离 | 在 footprint 安全约束内优先完成 MERGE/VERIFY 等在途工作，加入等待老化；维护完成 Epic 时不只盯最老的一个。PM 循环也按步骤/需求隔离错误，并让 outbox 在其他步骤失败时仍可重放 | 一张不可交付 Epic 不挡其他 Epic；坏页/网络错误不吞全部投影；必要回归与正在收尾的卡不会被无限新任务饿死 |
| P1-F Notion 可靠呈现 | 保留现有字段所有权和操作分流；按错误类型退避、限制重试并提供受控死信重放；健康与告警不只依赖终端日志 | 断网恢复后逐步排空且无重复章节；不可重试错误进入可操作列表；人物能看到等待谁、系统在重试什么、最后成功推进时间 |
| P1-G 全链成本 | 每次模型调用共用 telemetry/账本，包括 PM、拆解、走查、回归、重试、capacity probe。runId/调用序号去重；保存当时 billing 来源；分别显示实际计费与订阅参考量 | 人工复核账本与真实返回 usage 一致；中途失败与回归不漏账；重复上报不重复计费；旧 Codex 标记经证据校正并留审计 |
| P1-H 可复盘运行输入 | 保存不可变 phase 输入、DoD 版本、代码/基底 SHA、配置快照和版本、模板 SHA、最终 prompt hash、模型及 evidence manifest | 指定 runId 能重建原输入，hash 一致；“历史重放”和“用当前状态试新 prompt”分开命名；新修改不污染旧回放 |

P1-H 特别说明：`phase_runs.prompt_sha256` 已存在，它是组装输入的 hash，不能把 IT-10 描述成“完全没有 prompt hash”。缺少的是模板版本/运行配置等完整可追溯信息。`replay-phase.ts --round` 仍调用读取最新产物、反馈和验证历史的 `buildPhaseInput`，不会自动回到历史时点，且不支持 VERIFY。其现有用途适合“当前状态试跑”，不能作为第 7 轮历史原样复现的证明。

费用上限继续只约束计费调用；不增加余额估算预警。建议补需求级成本聚合视图，但不以此取代既有 per-card ceiling。

## 6. 单节点运行的 P2 收口

在功能闭环通过后补齐以下运行能力，无需等多机：

- 带凭据的真实 Linux 主机安装、重启、网络恢复演练；两个 systemd 单元的启动条件、进程退出、子进程残留和有限 drain 语义核实。现有 TimeoutStopSec=120 不等于所有在途任务必能在 120 秒内完成，应确保被强制停止后可恢复。
- 实际通道的带外告警演练；当前 MP 记录已披露关闭此门禁。新增“进程活着但无业务推进”“回归从未成功”“outbox 最老积压”等指标，不能用 PID 存活代替健康。
- 一致性备份、恢复演练与磁盘水位；按保留策略清理已交付 worktree、浏览器 session、构建缓存。证据 manifest 和关联任务保留，清理不能破坏复盘。
- 自举运行器用固定已发布 checkout，需求产品在独立 worktree 开发；受控 drain→版本切换→启动校验→失败回滚。先做好单节点版本切换，无需提前实现多机滚动发布。
- 小而真实的行为回归样本集：连接失败、旧页面、需求口径漂移、合流冲突、Notion 重放、验收补单。prompt 改动用固定样本比较，不以字数缩短或单卡偶然成功为优化依据。

## 7. 推荐实施顺序

| 批次 | 范围 | 出口 |
|---|---|---|
| 0 证据基线 | 固定运行版本与数据库快照；更新清单的证据口径；定义人工合并 gate | 可以明确回答“哪份代码、哪份库、哪个版本正在运行” |
| 1 环境与契约 | P0-A/C/D；先修 E2 浏览器漏判、环境身份和恢复语义 | 两张受阻 Story 不再因已知系统缺陷停牌；不靠调大预算 |
| 2 集成与回归 | P0-B；P1-E 的公平性和非阻塞 sweep | Epic 当前版本经过完整验证；真实回归闭环至少一轮 |
| 3 交付与验收 | P1-A/B/C/D/F | website 完成“合并→可访问验收→故意拒绝一个场景→补齐→DONE” |
| 4 可运营性 | P1-G/H 与 P2 | Linux 新需求从头无人工修复跑通，并完成重启/断网/恢复演练 |

同一批内按最小可独立验收的 PR 拆分，不把所有改动塞成一次大重构。测试顺序沿用仓库规定：单元→集成→端到端；涉及真实 pi 行为时补对应 smoke。错误样本来自此次实际轮次产物，不手写冒充契约 fixture。

现有 website 可以继续作为回归与恢复样本，但由于多次临时修复、人工恢复和历史库修补，不能在修完后追认成“从头无人干预成功”。最终需要新的、干净的 Linux 需求样本证明 MP-10。

## 8. 最终验收矩阵

| 场景 | 必须观察到的结果 |
|---|---|
| 正常需求 | 1 个需求至少 2 个有依赖 Story，自澄清到 DONE；所有业务 gate 有记录 |
| 业务否决 | 验收拒绝一项后只生成一份缺口工作，完成并回到验收；已接受项不丢 |
| 供应商窗口/传输故障 | 卡保持可恢复，代码收敛预算不变，按策略等待或换 provider；调用成本仍入账 |
| 浏览器与服务故障 | 旧服务不被误认；连接失败修环境再验；真实功能错误照常否决 |
| 集成破坏 | 通过单卡验证但破坏 Epic 的提交被检出；不会零回归记录就认定 clean |
| 主机/进程中断 | 重启恢复到正确边界，无重复执行、MR、Notion 页面与计费 |
| Notion 中断 | 中央执行状态可追溯；恢复后幂等同步；业务批准未到时不跳 gate |
| schema 不一致 | 启动探针明确拒绝不兼容状态；不会运行到费用停点才发现 CHECK 失败 |
| 费用耗尽上限 | 仅计费卡在 phase 边界停为 cost_ceiling_exceeded，人工提高额度后的恢复有审计 |
| 真实数据验收 | 页面反映本需求的真实执行数据，样本数据验证与真实数据验证明确区分 |

建议看板指标：非业务人工干预次数、无进展任务数及等待来源、首次验证通过率、环境重试占比、当前 SHA 回归覆盖率、outbox 最老年龄、按需求的计费金额和订阅参考量。验收样本要求非业务人工干预为 0；其余阈值先用实际运行建立基线。

## 9. 本次实际执行与限制

已执行：Git 状态与提交核对；sqlite3 只读查询；Python 对实际 schema 与在内存执行 0001 后的 schema 比较；`gh pr view 26 --repo xiayu1996/hivemind --json number,state,isDraft,mergeable,headRefOid,baseRefName,url`；当前分类函数的 tsx 只读复现；`npm test`（140 文件、1103 测试通过）；`npm run lint`；`npm run typecheck`。

分类复现结果：`ERR_CONNECTION_REFUSED=false`、`HTTP 500=true`、`Route GET:/results not found=true`，分别表示当前是否视作环境失败。这证明规则确有漏判/宽泛归类，不代表所有真实 500 都应当判代码错误。

没有执行：真实 pi smoke、应用启动、浏览器功能验收、Linux 带凭据部署、状态恢复、改库、合并 PR、Notion 写入。本次只新增本方案文档。数据是核验时快照，各循环仍可能继续更新。Notion 原始回答的现时有效性、运行进程准确代码版本、回归从未落账的直接运行时原因及早期费用标记均需后续专项确认。

主要证据索引：

- `docs/plan/tasks.md`：M2/MP/MQ/IT 的原判据。
- `docs/poc/mp-acceptance.md`：实际验收进度与人工干预披露。
- `data/decisions/2026-09-05-proxy-decisions.md`：D3 回答和已知恢复语义冲突；本地证据，不新增进 Git。
- `data/hivemind-mp.db`：requirements/epics/stories、verify_records、phase_artifacts、scenario_registry、regression_runs、cost_entries、notion_outbox。
- `src/orchestrator/acceptance-checklist.ts`、`src/orchestrator/epic-completion.ts`：验收补单与 PR 关闭后的状态路径。
- `src/orchestrator/story-execution-store.ts:860`、`scripts/replay-phase.ts`：历史回放当前实际读取语义。
- [GitHub PR #26](https://github.com/xiayu1996/hivemind/pull/26)：实时状态读取。
