# MP 验收记录（进行中）

> 判据见 tasks.md MP-10：一条真实模糊需求在 Linux 单机走完 澄清→PRD 确认→拆解→开发交付→场景化验收。
> ① 全程 Notion 单一信息源可追溯；② 四类设计内人工 gate 之外无人干预；③ 至少一个 Story 含真实浏览器 e2e 证据；④ 验收清单逐条对应 PRD 场景。
> 本文只记非秘密证据；任何人工干预（临时脚本、手改库）必须在此披露。

## 候选需求

`R-ae22432dbaaf`「hivemind web 客户端」——本项目自举。Requirements 库于 2026-09-01 在既有 Epics/Stories 看板旁新建（`--requirements-only`，未重建旧库）。

## 进度（按日期追加，不改旧行）

| 日期 | 环境 | 发生了什么 | 判据 |
|---|---|---|---|
| 2026-09-01 | macOS 本机 + 真实 Notion | 需求卡建立并被接单进 CLARIFY；PM 第一轮 6 个业务问题贴到需求页评论；人在评论里回答；回答逐字归档到「澄清记录」 | ①（澄清对话只存在于需求页评论与其归档） |
| 2026-09-01 | 同上 | PM 第二轮 5 个问题；回答归档署名为真名「雨 夏」（此前只有 user id，见「披露」） | ① |
| 2026-09-02 | 同上 | PM 第三轮 4 个确认型问题（首页图表范围、详情页历史深度、失败记录字段、按模型费用口径），等待回答 | — |
| 2026-09-02 | 同上 | `npm run preflight` 24 PASS / 1 WARN（无带外告警通道）；需求循环一轮通过，需求状态影子初始化为「澄清中」 | 单机就绪（Linux 待跑） |
| 2026-09-02 | macOS 本机 + 真实 Notion | 第三轮回答归档；PM 判充分 → PRD（1 个目标、4 条不做、11 个场景）写入需求页；人拖卡到「拆解执行中」批准 → PRD 冻结 → PM 拆成 3 个 Epic（E1ACTION / E2RESULTS / E3OVERVIEW）写入 Epics 库并关联需求 → 需求 EXECUTING。产品经理循环与 orchestrator 均以常驻进程运行 | ①④（PRD 与后续验收清单同源） |
| 2026-09-02 | macOS 本机 + 真实 Notion | orchestrator 常驻后接入 3 个 Epic：E3OVERVIEW 拆成 3 个 Story、E1ACTION 拆成 6 个 Story，方案写到 Epic 页、状态置「拆解待确认」等人批准；E2RESULTS 以阻塞问题停下（设计内停点），问题已投到 Epic 页等人回答 | ①② |
| 2026-09-02 | 本机 colima 虚拟机内干净 Ubuntu 24.04 arm64 容器（无凭据） | `deploy/linux/install.sh` 全程跑通；`npx vitest run` 726 全绿；`smoke-browser-e2e` 9/9（无沙箱模式，容器内核限制见下）；preflight 12 PASS，FAIL 全为无凭据预期项，并正确报出 AppArmor 用户命名空间限制 | Linux 部署机制成立；③ 的浏览器车道在 Linux 上可用 |
| 2026-09-05 | macOS 本机 + 真实 Notion（Ryan 授权 Claude 以本人账号在看板上做人工 gate） | 人批准 E1ACTION / E3OVERVIEW 拆解方案（拖到「进行中」），回答 E2RESULTS 阻塞问题（评论），随后批准 E2RESULTS 方案；三个 Epic 共 12 个 Story 入库并建页。S-E2RESULTS-01 走完 DESIGN→CODE→VERIFY（第 3 轮 accepted）→MERGE；S-E1ACTION-01 VERIFY 第 2 轮 accepted，证据目录含本会话 playwright-cli 截图 6 张 + 页面快照 + 被测服务日志。Codex 用量窗口撞墙后三张卡停下，等待窗口 | ①②（人工动作只有拆解批准、阻塞回答、停点恢复三类）③（浏览器 e2e 证据已在 Epic Story 上产生，交付尚未完成） |

## 活体接线时发现并修复的闭环缺口

这些都是在真实看板上把链路接起来时才暴露的：各自的单测在自己的边界内是对的，缺口在边界之间（同 M2 验收的结论）。

| 缺口 | 后果 | 修复 |
|---|---|---|
| `EPIC_ACCEPT → DONE` 无任何代码触发 | 需求永远进不了 ACCEPTANCE | `EpicCompletion` 经 `gh`/`glab` 读回 MR merged；隶属需求的 Epic 合并即 DONE（人的验收在需求页按场景勾选），独立 Epic 还需人拖到「已完成」（03 §7.2 带日期补记） |
| 看板 `Epic 状态` 从未被系统投影 | Epic 永远停在「待拆解」；退回重拆时也无法回到 intake 过滤条件 | outbox `sync_epic_status`，投影同时写 `notion_status_shadow`（01 §2.2 带日期补记） |
| 需求页人类输入解释器只在测试里被调用 | PRD 批准/修改意见、验收勾选与缺口留言、停靠/恢复在活体上无人读取 | `NotionRequirementInputSync` 接进需求循环，每个决定按评论/勾选 id 只认领一次 |
| 需求循环与 orchestrator 共用 outbox，互相把对方的行判为不支持 | attempts 虚增；一侧积压超过 100 行时另一侧饿死 | `replay(delivery, { operations })` 按操作过滤 |
| Story worker 浏览器白名单硬编码 `localhost/127.0.0.1` | 三层红线不再同源 | 读 `guard.e2eHostAllowlist`（worker 与回归 sweep 两处） |
| Epic 拆解遇阻塞问题后是死路：问题只在 event_log 与控制台，看板不显示，BLOCKED 也没有任何出口 | E2RESULTS 拆解时问「失败记录的『已恢复』如何判定」，无人能看到、也无法回答 | 问题以评论写到 Epic 页（按正文幂等、每轮为所有 BLOCKED Epic 补发）；人在该 Epic 页的评论即回答，按评论 id 只认领一次，Epic 回到 DECOMPOSE 并把问答附进拆解输入 |
| 两个常驻进程共用一个 libsql 文件时读到 `SQLITE_BUSY`，整轮失败 | 单节点两进程必然并发 | 每个连接设 `busy_timeout=5000` 与 WAL |
| VERIFY 会话既不知道也拿不到 `playwright-cli`；`prompts/phases/verify.md` 从未装载 | 判据 ③ 无从产生：盲审只会跑单测，不会打开页面 | 白名单非空时 prompt 注入浏览器车道说明（session 名=卡 id、只列 host）；hivemind 的 `node_modules/.bin` 进 VERIFY/回归会话 PATH（不往 worktree 装任何东西，保住 tree-pin）；VERIFY 系统提示装载基线+verify.md |


## 2026-09-05 接线 Epic 下 Story 全流水线时暴露并修掉的缺口

Story 首次由 Epic 拆解生成（而非看板建卡），暴露出一批只在「Epic → Story」这条边上才会走到的缺口。全部修复经单测 + 活体重跑验证；完整逐条记录（含代人决策依据）见本机 `data/decisions/`（不进版本库）。

| 缺口 | 后果 | 修复 |
|---|---|---|
| 批准后 Story 行带合成 page id 就被投影 | `sync_story_*` 永远 404，轮询活跃集反复报 page gone；新页在属性投影落地前缺「AI 状态」，一页抛错让整轮兜底轮询失败 | 投影跳过 `create_story_page` 未落地的 Story 并清理指向旧 target 的 pending 行；缺状态视为「尚未投影」 |
| Story 分支从 `epic/<id>` 切出，但 Epic 集成 worktree 在其之后才创建 | Epic 下首个 Story 必然 `invalid reference` 失败 | 先建 Epic worktree 再切 Story |
| run-story 构造合流校验器时立刻读 DoD | DESIGN 之前 DoD 不存在，QUEUED Story 起跑即崩 | DoD 读取推迟到合流校验时 |
| 状态机无 `NEEDS_INPUT → QUEUED` | 在 QUEUED 停下的 Story 无法被人恢复 | 补该迁移；人工恢复重置 phase 重入预算 |
| 停在 NEEDS_INPUT 的 Story 的下游仍进调度 batch | 下游每轮 claimStart 即阻塞，却占住 footprint 重叠者的槽位 | 依赖指向非 DELIVERED 且不可派发的 Story 时，下游整体剔出计划 |
| VERIFY 写模式启发式把 `=>` 当重定向；任何 `>` 一刀切 | 盲审起不了被测服务，浏览器场景全失败且不给理由 | `>` 前排除 `=`/`-`；允许重定向到证据目录与 /dev/null；车道说明教 `nohup … > "$HIVEMIND_EVIDENCE_DIR/service.log" &` |
| verdict 只有 pass/fail，无理由；校验错误不进失败集 | 人看不出为何停；「rejected 但 failed 为空」直接触发收敛停 | 每场景 `reason` 入 artifact 并投影到 Story 页；校验拒绝的场景并入 failedScenarios |
| completion judge 只看最后 20 条工具结果，且要求 CODE 出口有浏览器证据 | 已 commit 且 worktree 干净的 CODE 被否决三次而停 | 会话结束后由 orchestrator 实测 worktree 交给 judge；契约声明 ui/e2e 层证据属 VERIFY |
| worker 进程级失败与供应商故障混入 Story 预算 / 熔断归因 | 系统缺陷伪装成供应商故障，或供应商撞墙伪装成需求侧停点 | 不可分类的失败不计熔断；可分类的供应商故障不计重入、不停卡 |
| `usage limit` 无窗口时熔断被凭据探针立刻关回 | 三张卡几分钟内烧光预算 | 无窗口的用量撞墙保持 `provider.quotaHoldMs`（默认 30 分钟） |
| Story 页在 Notion 读延迟下重复插入轮次 toggle / 停点段落 | 页面越来越乱 | 单次 send 内不重复插同一键；轮次以库内 10 分钟记录为准 |
| orchestrator 关停不等在途 Story | 重启后同一张卡被再派一次 | stop() 先 drain `inFlight` |
| 用量撞墙 / 传输中断等供应商故障被记成卡的失败 | MERGE 一次撞墙即停卡；CODE 烧重入预算；VERIFY 里的 WebSocket 中断被算成一轮失败并触发收敛停 | 可分类的供应商故障只记熔断、不计重入、不停卡；VERIFY 走 continue-retry，重试耗尽抛出而不落 verify_records |
| 合流复验失败回 CODE 时内环预算已满 | worker 直接抛错三次 → `retry_limit_exceeded` | 预算耗尽干净停成 `verify_loop_exceeded`；内环预算改为自上次人工动作起计数（轮次号累计） |
| 从 MERGE 停下的卡拖回后又回到 MERGE | MERGE 无权改代码，原地再停，人怎么拖都出不来 | NEEDS_INPUT 恢复目标：VERIFY / MERGE 一律回 CODE |
| MERGE 否决与 Epic 头退回的原因不回灌 CODE | 同一 trailing whitespace 被否决两次，CODE 不知道要修什么 | CODE 的 phase 输入并入 MERGE 失败与 `merge.*` 事件原因 |
| Story VERIFY 与合流复验共用 playwright-cli 会话名 | 会话守护进程记住旧 outputDir，合流复验截图落进 Story 轮次目录 → 校验拒绝 → 全场景失败 | 每次运行独立会话名 |
| 合流子集复验失败不带理由 | 人和 CODE 都不知道 Epic 头为何拒绝 | SubsetVerifier 返回 reasons，写进事件与 CODE 提示 |
| guard 把词内 `>`（`=>`、`<unset>`）与带引号 / `$HIVEMIND_EVIDENCE_DIR` 的重定向都判为写；`playwright-cli route` 可伪造接口 | 盲审起不了服务；或对着假数据截图过关 | 重定向须以词首 `>` 出现且展开变量与引号后判定；只读浏览阶段拦截 `route/unroute` |
| 盲审截图带文件名落进 worktree；并发盲审共用固定端口 | tree-pin 变化让 worker 崩而非判 rejected；打到别人的服务 | run-story 接上 quarantine；车道说明：不带文件名、选空闲端口、结束前杀进程 |
| completion judge 只看最后 20 条工具结果 | 已提交且干净的 CODE 被否决三次而停 | orchestrator 实测 worktree（status / HEAD / 最近提交）交给 judge |

## 披露（2026-09-05 追加）

- **人工恢复三类停点**：当日所有 `retry_limit_exceeded` / `verify_loop_exceeded` 停点均由上表系统缺陷或 Codex 用量窗口造成，非需求问题；由 Ryan 授权的代理人在修复落地后把卡拖回「进行中」恢复。这些是设计内的人工动作，但它们**不应该发生**——每一次都对应上表一条修复。
- **orchestrator 重启**：为让修复生效重启过数次；重启前均确认无 `run-story` 子进程在跑（其中两次用一个临时外部守望脚本等到无 worker 时再重启，脚本放在 /tmp、未进仓库）。
- **代人决策**：PM 拆解方案的批准与阻塞问题的回答由代理人以 Ryan 身份作出，逐条依据记录在本机 `data/decisions/`。已发现 PM 拆解在三个 Epic 间重复横切场景（手机/电脑可读、首页顺序），以及 S-E2RESULTS-01 的 DESIGN 把「恢复」口径改成了与澄清回答相反的 successor 链接模型——留到需求级验收时按原口径核对。

## Linux 实跑发现的部署缺陷（已修）

| 缺陷 | 修复 |
|---|---|
| `install-pi.sh` 用 `gh release download`，而首装时 `gh` 尚未登录 | 直连公开 release 资产 + SHA256 校验，`gh` 仅兜底 |
| arm64 Ubuntu 的 Node 26 缺 `libatomic1` | runbook 前置 |
| Ubuntu 23.10+ AppArmor 限制非特权用户命名空间，Chromium 报 `No usable sandbox!` | preflight 新增内核检查并给出 sysctl 修法（首选）；`verify.chromiumSandbox` 显式开关（默认开、标 dangerous）供容器等无法改内核的主机使用；容器内冒烟即以该开关通过 |
| `install.sh` 从本地路径 origin 推不出 `owner/name` slug 却继续 | 无 `/` 的 slug 直接报错要求 `--repository-slug` |

## 披露（判据 ② 相关）

- **带外告警门禁关闭**：2026-09-02 由 Ryan 决定「可以关掉 alert.requireOutOfBandChannel，下次再配置」，以 `config.set` 写入本机库（version 1，updated_by 记录了决定人与日期），orchestrator 以 WARNING 启动。这不是人工修复，是设计内的配置项；但在该通道配好之前，`needs_input` 停点只能靠人看看板发现。

- **澄清记录第一轮两行署名为 user id 而非人名**：人名解析在第二轮之前才上线。澄清记录按设计只追加，未回头改写这两行；它们是当时真实发生的样子。
- **本机库手工建表**：`data/hivemind-mp.db` 建于 `notion_users` 表加入 `0001_init.sql` 之前；预发布立场不加 `0002+` 迁移，故用同一份 DDL 手工建了该表，未删库重建（删库会丢掉这条需求的澄清历史）。全新环境不受影响。Linux 验收环境将从零建库，不带此痕迹。

## MQ 主流程收敛（2026-09-09）

代码侧改动已完成（MQ-01..09，见 `docs/plan/tasks.md`），门禁 `npm run lint` / `npm run typecheck` / `npm test`（127 文件 827 测试）全绿。
Codex 订阅额度接近耗尽，本轮不跑 pi agent，卡片回归等配额恢复。

不需要 agent 的一次实测：把新的 CODE 出口确定性检查直接跑在 S-E3OVERVIEW-01 那棵停住的工作树上（`data/work/worktrees/hivemind/S-E3OVERVIEW-01`），结果全过——
树干净、相对 main 有 14 个提交、四条场景各有红绿提交与测试文件点名、`git diff --check` 干净、仓库三条门禁命令全绿（该分支自身 126 文件 768 测试通过）。
即这张卡的代码在 09-06 就已经满足出口条件，把它停在 `retry_limit_exceeded` 的是流程本身，新出口会放它过去。

## 尚未发生

- Linux 主机上执行 `deploy/linux/install.sh` → `npm run preflight` → 两个 systemd 单元起来；同机重跑 `smoke-browser-e2e`。
- 第三轮回答 → PM 判充分 → PRD 写入需求页 → 人批（评论「批准」或拖到「拆解执行中」）。
- 拆解为 ≥1 Epic（≥2 Story）→ Epic 拆解方案人批 → Story 开发交付 → Epic MR → 人合并 → 需求进 ACCEPTANCE → 逐场景勾选。
- 判据 ③：至少一个 Story 的 VERIFY 含真实浏览器 e2e 证据（截图/trace 落在证据目录，host 在白名单内）。
- 带外告警通道（`FEISHU_WEBHOOK_URL` 或 `SMTP_*`）：orchestrator 在无通道时拒绝启动，本机 preflight 的唯一 WARN。
