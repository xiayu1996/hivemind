# 从旧系统带过来的

旧系统完整保留在 `legacy/`（最后状态打了标签 `legacy-final`），冻结、不再运行。本文记录重写时逐块做的判定：
哪些搬了过来、哪些丢了、哪些实测结论继续有效。结论的原始证据在 `legacy/docs/`（设计 00–08、M0 PoC 记录、评审）。

## 搬过来的

| 现在 | 来自 | 变化 |
|---|---|---|
| `src/resilience/classify.ts` | runner 的错误提取与分类 | 规则与文案表原样保留，逐条断言也在 |
| `src/resilience/breaker.ts`、`reset-window.ts` | provider 熔断与额度窗口 | 状态存进 `provider_health` 表 |
| `src/gates/danger-rules.ts`、`path-glob.ts`、`tool-guard.ts` | guard 与 hive-guard extension | 从 pi 侧钩子变成 agent 的 `beforeToolCall` |
| `src/gates/evidence.ts` | 验证道的可访问性快照解析与 `visible` 比对 | 同一套比对也用于重放 |
| `src/gates/check-failures.ts` | 检查输出里的失败提取 | 不变 |
| `src/adapters/git.ts`、`app.ts`、`process.ts` | vcs、应用道、进程工具 | 去掉了 Story 分支、合流相关的部分 |
| `src/adapters/notion/` | NotionGateway 与页面 builder | 收成一个 `Board` 实现；文案移到 `config/messages.yaml` |
| 契约的 `page`、`visible`、`mutates`/`persistedBy`、`seed` | SHAPE 的 DoD 字段 | 从每张卡的 DoD 升到整个产品的 `acceptance.yaml` |
| `prompts/` | 旧 prompt 的基线、SHAPE、SOLUTION、PROTOTYPE、UI 走查 | 按新角色与步骤重写压缩 |
| `config/models.yaml` 的 command-code 声明 | 库里的 `model.providers` | 从库搬进版本化的文件 |

## 丢掉的，以及为什么

| 丢掉的 | 为什么 |
|---|---|
| pi RPC 运行器（JSONL 分帧、握手、checkpoint 与尾部修复、`auth.json.lock` 清理、`clear_queue` 后再 `abort`、`extension_ui_request`） | pi SDK 在进程内跑会话：没有子进程、没有分帧、没有会话文件，崩溃恢复就是用同样的输入重跑 |
| 需求 / Epic / Story 三层状态机、拓扑与 footprint 调度、per-Story 租约 | 每个需求一条集成分支、逐项顺序落地；没有并行就没有合流与冲突 |
| 7 道 Story 门禁与二十多条子检查、结构化判官、人话 lint、design-lint | 真实需求大量卡在门禁上而不是产品上。只留三道对落地有意义的门（见总览 §6），其余要么删掉、要么以后做成信号 |
| 回归调度器与归因二分 | 每一项验收前无模型重放全部已通过场景，坏了当场归到这一项 |
| SoL-Pi（Action Fusion、ObservationPack） | 用 pi 自带工具即可；重新引入 `then_run` 这类捎带命令时，必须让它过同一套命令红线 |
| Web 控制台、观测面板、告警、记忆蒸馏 | 没有消费者。`status` 命令、看板与 JSONL 日志够用；产品文件就是记忆 |
| 手写 SQL 迁移为权威 | drizzle schema 为权威，drizzle-kit 生成迁移；旧规则没留理由，旧 schema 也从没被用来查询 |

## 继续有效的实测结论

模型与 provider：
- **QUOTA 必须排在 RATE_LIMIT 之前**：配额耗尽也是 429，读反了会永远等一个不会打开的窗口。
- **UNKNOWN 失败即停、要人看**：DeepSeek 余额耗尽（402 "Insufficient Balance"）曾被当瞬时故障安静重试到底。
- **model id 存在 ≠ 这个账号能用**：ChatGPT 订阅会拒掉目录里照样列着的 id，只有真实往返能回答，所以 `preflight --probe`。
- **凭据检查不刷新登录**：refresh 会轮换 token，别的持有者手里那份随之作废。
- **额度窗口里的分钟数是相对值**，锚定错误发生的时间，不是读到它的时间。
- **不要用真实并发去压 429**：那是花钱买一个字符串，而且 DeepSeek 排队而不回 429。
- **用量四桶互斥**（未缓存输入 / 输出 / 缓存读 / 缓存写）；reasoning 是输出的一部分，不重复累加。
- **不让宿主机的上下文文件漏进会话**：旧系统里 pi 会向上层叠读 `CLAUDE.md` / `AGENTS.md`，把个人指令静默读进任务。
  现在系统 prompt 完全由我们自己拼，不经 pi 的资源加载。

验收：
- **屏幕场景必须有 `page`，而且要从产品的真实入口到得了**：写好了组件却没挂上，单测照样全绿。
- **`visible` 必填，证据由 harness 采集**：一轮服务 404 页的产出曾凭散文把四个场景报成通过。
- **改东西的页面必须有"重新打开还在"的场景**：每次打开都重置的假存储曾两次被验收通过。
- **`app.start` 必须是人打开产品用的那个入口**：只加在演示脚本里的功能，每一轮都绿，产品里却不存在。
  现在它写在 `project.yaml` 里、由人在技术方案关批准，构建者改不了。
- **观感永不否决，不做像素对齐**：给了否决权的评审每轮挑出不同的一处，失败集合永不重复，判据永不生效。
- **分清"做不到"与"判不了"**：反复判不了先问场景的前提造不造得出来，造不出来的前提会诱发假页面。

流程：
- **订阅也花钱**：预算按 API 等价价格计，订阅计入。
- **人的注意力是稀缺资源**：人只在产品定义、技术方案、交付验收三处被请求，外加真正挡路的问题。
- **轮次上限设在离散的尝试上**，不设在时长或 token 上。
- **Story 是竖切**：计划项从页面打通到存储，不拆"先后端、再前端"。
