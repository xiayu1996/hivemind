# 00 · 总览：主循环

本文是 hivemind 的架构。改动 `src/` 之前先读它；代码与本文冲突时以本文为准并回写代码或本文。
旧系统（`legacy/`）的设计文档 00–08 已冻结，只作为历史与实测结论的来源（见 [legacy-knowledge.md](../legacy-knowledge.md)）。

## 1. 为什么重写

「Hivemind 的 web 管理后台」这条需求多次重开、约 1.57 万轮之后，产出基本不可用、没有架构。
旧系统的失败不在某一道门禁，而在主循环本身缺了五样东西；此前每次失败都在卡的层面加关，主循环的前提从没动过，
所以每次重开都收敛到同一结果。新设计逐条补上：

| 旧主循环缺的 | 后果 | 新设计 |
|---|---|---|
| 产品级持久状态 | 每个阶段只看本卡，看不到 PRD、方案和兄弟卡 | 产品文件住在目标仓库 `.hivemind/`，每个会话都带着全部 |
| 地基 | 骨架不能单独成卡，方案关批准的栈没有消费者 | 技术方案是一个步骤，人批准；计划第一项就是地基（`enabling`） |
| 集成主干 | 各 Epic 并行从 main 切分支，彼此看不见 | 每个需求一条集成分支，逐项顺序落地，每项都建在上一项之上 |
| 全局判据 | 完成按卡判，产品级信号只在人验收时出现 | 每项验收时重放此前通过的全部场景；最后对整个产品终审 |
| 重规划 | 拆解之后回不到方案或 PRD | 评论与卡住都回到规划者修订计划；改了验收的已通过项自动重开 |

## 2. 主循环

```
Engine.tick()                                   src/loop/engine.ts
  ├─ intake：看板上的新需求 → requirement（选配方、建分支名）
  └─ 每个未完成的需求 → advance()               src/loop/requirement.ts
       1. 收人的输入（批准、评论）入库
       2. 停下的需求有评论 → 带着评论继续
       3. 在等的需求：等到了就放行，没等到就跳过
       4. 预算检查
       5. 确保 worktree（第一次从 origin 默认分支切出集成分支）
       6. 跑当前步骤一次 → StepOutcome：next / again / goto / wait / stop / done
```

一次 `advance` 只做一个单位的工作（一次作者会话、一项的一次尝试、一次终审），做完立刻落库。
全局只有一个写者、一次一个会话，所以没有并发、没有合流、没有冲突解决；进程在任何地方死掉，至多重做被打断的那个单位。

## 3. 产品文件（仓库就是记忆）

目标仓库的 `.hivemind/` 下，与代码同一个提交历史：

| 文件 | 谁写 | 作用 |
|---|---|---|
| `PRODUCT.md` | 规划者 | 为谁、解决什么、核心流程、不做什么 |
| `acceptance.yaml` | 规划者 | 验收契约（`domain/contract.ts`）：验收项 → 场景（given/when/then、`page` 或 `command`、`visible`、`seed`、`mutates`/`persistedBy`） |
| `DESIGN.md`、`prototype/` | 规划者 | 界面方向、token、组件、页面清单；原型是参考不是判据 |
| `ARCHITECTURE.md` | 规划者 | 技术栈与被否的备选、模块、数据与持久化、产品入口、测试策略 |
| `project.yaml` | 规划者 | 怎么装、怎么检查、怎么启动产品（`domain/project.ts`）；构建者改不了它，所以改不了"绿"的定义 |
| `plan.yaml` | 规划者 | 竖切片的顺序（`domain/plan.ts`）；每个验收项恰好归一片 |
| `research/` | 规划者 | 调研结论；`scratch/` 是试验目录，不进 git |
| `PROGRESS.md`、`acceptance/*.json` | 循环 | 进度与重放脚本，由循环按自己的记录生成 |

每个会话的系统 prompt 按固定顺序拼：基线 → 角色 → 步骤 → 需求原文 → 按路径排序的产品文件（原型与调研只列路径，按需读）。

## 4. 配方与步骤

步骤的**种类**是代码，步骤的**组合**是数据（`config/recipes/*.yaml`）：

- `author`：规划者写产品文件，写完即校验（schema + 跨文件规则），不合格回喂同一会话；可要求人批准（`always` / `on_change` / `never`）。
- `build`：逐项构建，见 §6。
- `review`：对整个产品重跑仓库检查与全部场景的验收，通过则推送、开 PR、请人做交付验收；不通过就把发现作为反馈送回构建（至多 3 次）。
- `revise` 不是配方里的步骤：构建途中人评论了、或某项卡住了，构建步骤调用它修订计划。

现有三个配方：

| 配方 | 步骤 |
|---|---|
| `greenfield` | define（产品关）→ design（有页面时）→ architecture（技术方案关，可调研）→ plan → build → review（交付关） |
| `feature` | 同上，但技术方案只在产品文件自上次批准后有变化时才请人看（`on_change`） |
| `small-change` | scope（一步写完契约、计划、项目配置）→ build → review |

审批时给人看的是**自上次批准以来改动过的全部产品文件**，所以不单独审批的界面设计会出现在技术方案关里。

## 5. 三个角色

| 角色 | 写权限 | 工具 |
|---|---|---|
| 规划者 | 只有 `.hivemind/**`（循环维护的 `PROGRESS.md`、`acceptance/` 除外） | read、bash、edit、write、grep、find、ls |
| 构建者 | `.hivemind/**` 以外的一切 | 同上 |
| 评审 | 无 | 只读工具 + 浏览器工具（begin_scenario、open_page、click、fill、press、snapshot、screenshot、run_command） |

写权限两层执行：工具层拒绝越权写入（`gates/tool-guard.ts` + 命令红线 `gates/danger-rules.ts`），
会话结束后 `gates/fence.ts` 把越权改动原样撤回（bash 能绕过第一层）。评审改动了工作区，它的结论作废。

每个会话以调用 `submit_result` 结束，参数由 zod schema 校验；模型停下却没提交，催一次；
提交之后的检查不通过，发现回喂同一会话（`maxHandbacks` 次），它已经读过的东西都还在。

## 6. 一项的一次尝试（三道门）

```
build step
  ├─ 有未消化的评论 → revise（规划者修订计划）
  ├─ 读产品文件 → 同步计划项（已通过项的验收内容变了 → 重开）
  └─ pickNext → attempt(item)
        第一次尝试从 trunk（最后一个被接受的提交）硬重置开始；重试接着上一次的树
        构建者会话 ── submit_result ──> check()：
            G3 围栏：撤回构建者对产品文件的改动
            G1 仓库检查：project.yaml 的 setup + checks
            提交候选
            G2 验收：起产品 → 无模型重放此前通过的场景 → 评审判本项场景
          任一不过 → 发现回喂同一会话
        通过 → 保存重放脚本、写 PROGRESS.md、把全部尝试压成一个提交 `item <id>: <title>`、trunk 前移
        失败 → 记一次尝试；超过次数 → revise（卡住）；返工也超过 → 停
```

验收的确定性部分（`domain/verdict.ts` + `gates/evidence.ts`）：
- `passed` 必须引用 harness 自己拍下的证据 id；快照必须拍在该场景的 `page` 上，且**同一份**快照里有 `visible` 列的每一条角色与文字；
- `failed` 必须逐字引用契约里被违背的那一句——契约没写的问题只是 `findings`，永不否决；
- `inconclusive` 重跑 `maxInconclusive` 次仍判不了，问人（多半是场景的前提造不出来）。

重放：评审判过的 web 场景，其动作按"角色 + 可访问名"录成脚本（`.hivemind/acceptance/<场景>.json`），
之后每一项验收前都无模型重放一遍并用同样的规则比对快照；cli 场景直接重跑命令。弄坏了旧功能，当场就被发现。

## 7. 停点与等待

只有三种停点（`domain/stop.ts`）：

| 停点 | 触发 | 怎么继续 |
|---|---|---|
| `no_progress` | 一项尝试与返工都用尽；终审打回超过 3 次；循环自身连续出错 5 次 | 人评论这个需求，带着意见继续（尝试次数归还） |
| `budget` | 已花费 ≥ 预算（API 等价价格，订阅计入） | `hivemind budget <需求> <美元>` 调高后自动继续 |
| `question` | 只有人能回答的问题（作者提问、构建者 blocker、评审判不了） | 人回复评论 |

三种等待：等批准（绑定 gate + 那一版的 commit，别的版本的批准不算）、等回答、等模型恢复
（有恢复时间就到点重试；需要人处理凭据或额度的，每 10 分钟看一次）。

## 8. 人的触点

人只做四件事：提需求、批准产品定义、批准技术方案、做交付验收（中途可能被问问题、被请看一次里程碑）。
输入只有两种：**批准**（只对它绑定的那一版有效）与**评论**（任何时候都是反馈）。

看板是端口（`ports.ts` 的 `Board`）：
- `adapters/board-local.ts`：一个目录，人用编辑器或 `hivemind submit / approve / comment` 操作，默认使用；
- `adapters/notion/`：Notion 数据源，一条需求是一页，批准是页面末尾的勾选框，评论是页面评论。属性名与文案在 `config/messages.yaml`。

## 9. 模型运行时

- **pi 在进程内**（`adapters/pi.ts`，唯一 import pi 的模块）：`pi-agent-core` 的 Agent 跑会话，工具取自 `pi-coding-agent` 的各个工厂，
  模型与凭据经 `ModelRuntime`（pi 自带目录 + `config/models.yaml` 里声明的 provider）。没有子进程、没有 RPC 分帧、没有会话文件。
- **候选按顺序**：每个角色一串候选（provider + model + effort）。熔断打开的 provider 跳过；
  瞬时错误同模型退避重试（`retryDelayMs`，最多 4 次）；其他错误记入熔断并在**同一段对话里**换到下一家 provider 继续；
  都不可用时需求进入"等模型恢复"。
- **错误分类**（`resilience/classify.ts`）：QUOTA 排在 RATE_LIMIT 之前（配额耗尽也是 429）；UNKNOWN 失败即停（需要人）；
  上下文溢出单独分类，不碰熔断。额度窗口里的相对分钟数锚定错误发生的时间（`resilience/reset-window.ts`）。
- **KV 缓存**：系统 prompt 确定性拼装、工具顺序固定、`sessionId = runId`、`cacheRetention: "long"`。
- **记账**：每次会话一行 `runs`，四桶 token 与 API 等价价格；预算按它求和。

## 10. 持久化

中央 libsql（`store/`）：`requirements`、`items`、`runs`、`events`、`inputs`、`questions`、`approvals`、`provider_health`、`leases`。
drizzle schema 是唯一真相，迁移由 drizzle-kit 生成，约束写成 CHECK。一组相关的写用 `db.batch`（不用 `db.transaction()`，见 AGENTS.md）。
一个库只允许一个 `run` 进程：租约是原子 UPSERT + 单调 fence，续租失败立刻退出。

## 11. 刻意不做的

| 不做 | 理由 |
|---|---|
| 并行构建多项、多机调度 | 并行就要合流，合流就要解冲突；单写者顺序执行让"主干永远是所有已接受工作的叠加"成立。需要吞吐时按需求并行，不按项并行 |
| 会话 fork / 跨会话记忆 | 仓库与产品文件就是记忆；每个会话从同样的输入开始，崩溃恢复就是重跑 |
| 观感否决、像素对齐 | 品味不收敛：有否决权的评审每轮挑出不同的细节，失败集合永不重复。观感只做 `findings` |
| 概率判官兜底门禁 | 门禁要么确定性判定，要么由独立评审带着 harness 证据判定 |
| Web 控制台、NestJS | 目前没有消费者；`status` 命令与看板足够。需要定时任务或 REST 时再加，作为新的 adapter |
| 余额预警 | 没有可信的余额 API；唯一有意义的护栏是单需求预算 |

## 12. 路线图

1. 用本地看板在真实模型上跑一条小需求与一条新产品需求，按实测调 prompt 与候选顺序（选模型看实测，不看名字）。
2. 把 Notion 数据源的属性与本设计对齐（状态属性必须只由系统写），切换到 Notion 看板。
3. 需要吞吐时：按需求并行（每个需求一个 worker、各自一条分支），不按项并行。
