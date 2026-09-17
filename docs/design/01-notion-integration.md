# Notion 信息架构与集成层设计

> 前提：中央 orchestrator 是 Notion 的**单一读写方**（worker 永不直连）；中央 libsql 是执行真相源，Notion 是人机界面投影 + 人类输入的诞生地。API 现状核实基于 2026-08 官方文档（2025-09-03 版 data source 模型，@notionhq/client v5+）。

## 1. API 现状核实结论

| 能力 | 现状 | 对设计的影响 |
|---|---|---|
| 数据模型 | database 是容器，行在 data source 里；查询走 `/v1/data_sources/:id/query` | config 同时存 database_id 与 data_source_id |
| Webhook | at-most-once，8 次退避重试（~24h 窗口），错过不可重放，无顺序保证；`page.properties_updated/content_updated` 为聚合事件（典型 <1min，最迟 ~5min）；`comment.*` 非聚合较实时 | 只能当加速器，轮询兜底 |
| Rate limit | 平均 3 rps/integration + workspace 级共享限额；429 带 Retry-After | 中央网关统一限流 |
| 请求体限制 | 单请求 ≤1000 blocks / 500KB；children ≤100；嵌套 ≤2 层；rich_text 单段 2000 字符 | 报告分批写 + 浅嵌套 |
| Comments API | 可在 page 或 block 上评论；list 只返回**未 resolve** 的评论；无 resolve 端点 | 块级评论做 Spec 级反馈锚点；"人手快 resolve 导致漏抓"是真实风险（R1） |
| File Upload | ≤20MB 直传，更大分片；上传后 **1h 内必须 attach** 否则删除 | 截图先落本地证据库，异步上传，失败降级 |
| Mermaid | code block language 枚举含 "mermaid"，原生渲染 | 设计/流程图直接用 mermaid code block |
| Status 属性 / board view | status 类型 schema 与视图**不能经 API 创建** | 看板列用 select（schema 全代码管理）+ 一次性人工 bootstrap 视图 |
| last_edited_time | 页面级时间戳为分钟粒度 | 增量水位带重叠回看窗 + 内容 hash 去重 |

## 2. 信息架构

### 2.1 顶层结构（2 个核心 DB + 页内 blocks）

```
Agent Delivery Hub                    ← workspace 顶层页
├── Stories        (database, 人日常唯一操作面 = board view 看板)
├── Epics          (database, table/timeline view)
├── Frictions      (database, 系统写入, 人浏览/评论)
├── Agent 记忆      (单页, 只读投影, 整页重建)
└── 运行周报        (单页/子页, 后期可选)
```

**为什么是"2 个核心 DB + 页内 blocks"而不是更多 DB**：人的可读性是第一追求。Epic 与 Story 生命周期、属性集、视图形态不同必须分库（relation 关联）；而 Spec 清单、设计总结、测试轮次全部放 Story 页面内 blocks——人打开一张卡，一屏看完"要做什么、怎么做的、验到哪了"，零跳转。独立 Spec database 带来三次点击与碎片化阅读，换来的结构化过滤能力系统侧不需要（**结构化真相在 libsql，Notion 只承担呈现**）。块级评论（comments API 支持 block_id）让人的反馈天然锚定到具体 Spec 行。

### 2.2 Stories DB 属性 schema（select 全代码管理）

| 属性 | 类型 | Owner | 说明 |
|---|---|---|---|
| 标题 | title | 人 | |
| Epic | relation → Epics | 系统（拆解时）/人 | |
| AI 状态 | select（看板列） | 双通道（见 §4） | 待启动/进行中/需要输入/人工停靠/已完成/失败——仅 6 列，人可拖。Story 自己的 MR 不再要人逐张确认：把关点是 Epic MR |
| 执行阶段 | select | 系统 | 排队中/需求分析/开发中/验证中/端到端/MR 已建——细粒度只读 |
| 优先级 | select P0–P3 | 人 | |
| 目标仓库 | select（注册表名） | 人 | |
| 能力标签 | multi_select（web/browser-e2e/ios/windows…） | 人/系统 | worker 路由依据 |
| 目标分支 | rich_text | 人 | 空则默认 |
| MR | url | 系统 | 主 MR；多 MR 进页内元信息区 |
| 成本(USD) / Tokens / 轮次 | number ×3 | 系统 | 每轮收口累加 |
| 创建人 | created_by | — | needs_input 时 @ 的对象 |
| 任务 ID | rich_text | 系统 | libsql task uuid，双向对账锚点 |
| 同步指纹 | rich_text | 系统 | 属性集 hash，写前比对防无效请求 |

Epics DB：标题、Epic 状态（待拆解/拆解待确认/进行中/已完成）、Story rollup（总数/完成数）、成本 rollup（sum）、目标日期、创建人。

> **补记（2026-09-02，MP 活体接线时）**：`Epic 状态` 是系统 owner 字段，由 orchestrator 经 outbox `sync_epic_status` 投影（呈现拆解方案→拆解待确认；批准→进行中；MR 合并→已完成；退回重拆→待拆解），并同步 `notion_status_shadow` 使后续轮询不把系统写入误读为人的拖动。人只在两处拖动作为输入被 ingest：`拆解待确认→进行中` = 批准拆解方案；`EPIC_ACCEPT` 期间拖到 `已完成` = 独立 Epic 的人工验收（隶属需求的 Epic 不需要此拖动，其验收在需求页按场景勾选，见 03 §7）。此前实现未投影该列，看板上 Epic 长期停在「待拆解」。

### 2.3 三层页面骨架（2026-09-17 重做：从"人在这一层做什么决定"倒推）

页面展示什么、确认什么、怎么交互，全部从人在该层的角色推出，而不是从系统有什么数据推出。

| 层级 | 人的角色 | 要做的决定 | 判断方向的信息（排在最前、最好读） | 交互 |
|---|---|---|---|---|
| 需求 | 提出者 / 产品负责人 | 答澄清、确认 PRD、中途变更或废弃 | PRD 的目标 / 不做 / 编号场景 | 评论回字母；拖列确认 PRD |
| Epic | **验收人** / 合并把关者 | 逐条验收本批承接的 PRD 场景、审 Epic MR、（可选，默认关）批准拆解 | 承接的 PRD 场景 + 拆解方案（每 Story 一行 page mention + 依赖） | 验收区逐条打勾；不勾 + 评论 = 本 Epic 下开补交付 Story |
| Story | 答疑者，**默认完全不打扰** | 回答阻塞问题、打回或继续、停靠 | 停下的原因与该怎么答；场景是 SHAPE 自推的实现级判据，不是人的验收对象 | 评论回字母、`打回:` / `缺陷:` 标记、拖列 |

由此四条跨层规则：

1. **每层页面只维护自己这一层的状态**，跨层状态看看板与 relation（需求页不跟踪 Epic 状态，Epic 页不显示 Story 实时进度）。
2. **不等人时页面不出状态 callout**：状态、等待人、费用看板属性已经有，页面不复述；轮到人时 callout 只写要做的动作。callout 随页创建且永不归档（块只能 `after` 追加，归档重建会把它甩到页底），不等人时原位改成一句「现在没有等你处理的事。」
3. **判断方向的信息排在进度信息之前**，且是全页最易读的块。
4. **人的注意力是稀缺资源**：同一件事只在一层出现一次；验收只在 Epic 层做，需求层自动汇总，Story 层默认不打扰。

所有给人看的枚举只经 `src/notion/display-text.json` 映射（状态、停点、verdict、层级、章节标题与旧名别名、每层的等人文案），`notion-write-language.test.ts` 扫全部投影的 outbox payload，裸枚举或英文模板即红。

**Story 页**

```
[callout]  轮到人时写要做的动作，否则「现在没有等你处理的事。」
           第 N 轮 · 本段预算 x/6 · 费用 $… · MR <link>
## 需求描述      （人写，系统只读）
## 验收场景      （✅/❌/⚪ 场景 N · 标题 + code(id)；子块 前提/操作/结果/证明方式）
## 设计摘要      （≤15 行中文业务语言 + 至多 1 张 mermaid，零代码）
## 验证记录      （每轮一个 toggle「第 N 轮 · MM-DD HH:mm · k/n 通过 ✅」，
                  内含表格 场景|测试|走查|说明，末尾列不影响验收的界面建议）
## 技术细节（折叠）（设计技术稿、各轮代码级原因、addressed 记录、分支与 MR 名）
```

- **Spec 行格式**：每条场景一个顶层 `paragraph` 块，块类型与 blockId 永不重建——人的评论挂在上面。libsql `story_specs` 存 `(story_id, seq, title, given, when_, then_, layers, notion_block_id, notion_detail_hash)`，子块只在 hash 变化时重建。
- **测试轮次 = 页内 toggle**（不是子页面、不是独立 DB）；>8 轮后旧轮批量搬入「历史验证记录」子页防膨胀。Notion 一次 append 只嵌两层，所以 toggle 内的表格是先建 toggle、再 PATCH 其 children。
- **默认不打扰**：Story 只在阻塞提问、失败、八轮不收敛三种情况进看板「等我处理」并出 callout。

**Epic 页**

```
[callout]  验收中：在「验收」区逐条打勾；否则「现在没有等你处理的事。」
## 目标          （业务目标 + 本批承接的 PRD 场景 bullets）
## 拆解方案      （只追加；每 Story 一行 page mention + 一句话 + 依赖）
## 依赖          （仅 depends_on 非空时，mermaid）
## 技术细节（折叠）（集成分支、Epic MR）
```

没有「进展」区：Story 实时状态由看板「按 Epic」视图与「进度」rollup 呈现。`epic_prd_scenarios(requirement_id, epic_id, prd_scenario_id, PK(requirement_id, prd_scenario_id))` 的主键即「一条场景恰好一个 Epic 承接」，是「目标」区与 Epic 层验收的共同依据。

## 3. 读写协议

### 3.1 webhook 加速 + 轮询兜底

**原则：webhook 只是"让轮询提前发生"的信号，轮询才是收敛保证**（24x7 无人值守下任何"错过一条评论"都会变成卡死数小时）。

| 事件 | webhook | 兜底轮询 |
|---|---|---|
| 人拖列/改属性 | page.properties_updated（聚合 ~1min） | data source query filter `last_edited_time > 水位`，活跃集 60s 一轮 |
| 人改页内文字 | page.content_updated（聚合） | 仅对收到信号的页拉区段 blocks diff，不全量扫 |
| 新评论 | comment.created（秒级） | 活跃集逐页 GET /v1/comments |
| 新建卡/Epic | page.created | 属性轮询一并发现 |

webhook 只投递到 orchestrator（HTTPS + HMAC X-Notion-Signature 校验）。

### 3.2 评论水位（替代 busybee 的 MySQL 自增 id 方案）

- 无全局"新评论"端点 → 维护**活跃集** = 非终态 Story ∪ 最近 7 天有变更页。
- **按 page_id 拉取只返回页级评论；锚定在具体行（block）上的评论必须逐 block 拉取**（2026-08-27 实测，见 docs/poc/notion-behavior.md）。Story 页恰恰把 Spec 清单做成一行一块并鼓励人在具体 Spec 行上评论——最有价值的那类反馈正是页级拉取取不到的。而一个 Story 页有 300+ 块，全页逐块轮询在 2.5 rps 预算下不可行。
- 因此轮询按**已登记的锚点 blockId 集合**拉取（Spec 行 + 区段锚块，每卡个位数到几十，预算内），非锚点块上的评论由 `comment.created` webhook 覆盖，轮询不负责。
- **已 resolve 的评论 API 永久取不回**（无参数、无绕过；Notion 官方托管 MCP 有 `include_resolved` 但未开放给公共 REST）。故 webhook 秒级 ingest 是主路径（评论诞生即入库，早于人 resolve），轮询窗口须短于人的典型 resolve 时延，并在 Story 页模板里对人写明"等 agent 回评确认后再 resolve"。评论一旦 ingest 落库即为本地真相，不再依赖 Notion 侧可读性。
- 水位表 `comment_watermark(page_id, max_created_time_seen, seen_ids_ring)`：created_time 水位 + **回看重叠 2min** + comment_id 唯一约束去重（时间粒度与乱序都被 id 去重兜住）。
- 过滤本 integration bot 自家评论。评论轮询划 0.5 rps 预算；webhook 到达时插队立即拉该页，P50 延迟秒级。

### 3.3 NotionGateway（中央网关）

全局令牌桶 **2.5 rps**（留余量）；优先级队列：人机交互写入（回答确认/@提醒）> 状态属性 > 验证报告 blocks > memory/周报投影；429 按 Retry-After 退避；同页属性更新 5s 窗口合并为一次 PATCH；属性值与同步指纹一致则丢弃（防抖）。

### 3.4 块级幂等协议

Story 页 5 个锚定区段以 heading 块为锚，锚块 blockId 持久化 libsql。写入规则：

1. **区段内 diff-update 原位改**（Spec 行状态、元信息 callout），块数变化才 append/delete——最小化请求数、保住人在旧块上的评论锚点；
2. **验证轮次只追加**（新轮 = append toggle，children ≤100/请求分批）；
3. **outbox 事务**：`notion_outbox(op_id, target, payload_hash, state, attempts)` 先落库后发请求；崩溃重启后按 payload_hash + target 判重回放——至少一次发送、恰好一次生效；
4. 图片：evidence store（本地）→ 异步 File Upload → 失败降级文字占位"截图见证据 #id"，不阻塞报告。

## 4. 状态机映射与人操作语义

### 4.1 映射表

| 内部状态机 | 执行阶段（属性） | 看板列（AI 状态） |
|---|---|---|
| INTAKE_PENDING / QUEUED | 排队中 | 待启动 |
| ANALYZE / DECOMPOSE | 需求分析 | 进行中 |
| CODE ⇄ VERIFY | 开发中/验证中 | 进行中 |
| E2E | 端到端 | 进行中 |
| MR_CREATED（等人审） | 合入 | 进行中 |
| NEEDS_INPUT | 等待回答 | 需要输入（+页内待人回答区 + 评论 @创建人） |
| HUMAN_PARKED | — | 人工停靠 |
| DONE | — | 已完成 |
| FAILED | — | 失败（+失败摘要写入验证区） |

### 4.2 人操作语义（拖列表达意图，评论表达内容，人不学指令）

| 人的意图 | 操作 | 系统行为 |
|---|---|---|
| 回答阻塞问题 | 页内直接评论 | needs_input 自动恢复运行，系统回评确认已收到 |
| 打回重做 / 继续开发 | 评论写意见 + 把卡拖回「进行中」 | 抓上轮 MR 后全部新评论作为反馈进新一轮 ANALYZE（系统不要求人区分两者，由 ANALYZE 语义判断）；否定性反馈物化 friction |
| 暂停 | 拖到「人工停靠」 | HUMAN_PARKED 最高优先级：撤 worker 冻结任务；恢复 = 拖出该列；orchestrator 永不抢回停靠卡 |
| 调整需求 | 直接改需求描述/Spec 文字 | content_updated → 区段 diff → 识别人为改动 → 需求变更 feedback 进下一轮 |

**人为编辑冲突处理（利用单写者简化，无需 CAS）**：libsql 保存每页属性影子值；「AI 状态」实际值 ≠ 影子值即判人工指令 → 意图解释器 → 内部状态机决定并写回最终列。**人拖列是"指令"不是"状态"**；人为修改后 120s human-wins window 内系统不反向覆盖（HUMAN_PARKED 教训的推广形态）。

## 5. 人类反馈 → 数据面

```
Notion 评论/拖列/改文字
  → ingest(comment_id 唯一约束幂等)
  → libsql human_feedback(原文·作者·block锚点→spec反查·轮次·分类)
  → 小脑 triage: answer | rework | preference | praise
       answer     → 回填 Spec(留痕), 解除 needs_input
       rework     → friction 累加(per repo × pattern)
       preference → 直接候选 lesson
  → friction 达阈值 → memory extractor 蒸馏 lesson
```

**Notion 承载 memory 归档面，但只做"可销毁的只读投影"**：busybee 漏账根因是 md 文件 + DB 条目级双写（两边都是可变真相）。修正方式是改变生成方式——libsql 是 memory 唯一真相源，「Agent 记忆」页在每次 memory 演化后**整页重建**（单向派生物，永远可从真相源再生，结构上消灭漏账）。人对记忆页/Frictions 的评论走同一 ingest 管道回流，形成"人审阅记忆 → 修正 → 再投影"闭环。regression 明细只存 libsql（Notion 侧仅展示"回归防护: N 条"计数）。

## 6. 故障与降级

- **执行面零依赖 Notion**：队列/worktree/CODE/VERIFY/E2E/MR 照常，写入全部堆积 outbox。
- 恢复后：outbox 顺序回放（payload_hash 判重）→ 全量对账 sweep（活跃卡逐一比对同步指纹修复漂移）。
- 受损语义仅两条，均有旁路：needs_input 无法问人 → 本地挂起 + 旁路告警（飞书/邮件）；新需求 intake 停摆（输入端在 Notion，不可避免，可接受）。
- 不可用 >30min 触发降级公告（告警渠道），恢复后自动补投，无需人工干预。

## 7. 风险与 PoC（Notion 侧）

| # | 风险/假设 | 级 | PoC |
|---|---|---|---|
| R1 | 人快速 resolve 评论导致反馈丢失 | 高 | 验证 comment.updated/deleted webhook 是否覆盖 resolve；不覆盖则约定"agent 回评确认后人再 resolve"+缩短轮询 |
| R2 | API 评论中 @mention 是否真触发通知 | 高 | 实测 rich_text user mention 通知行为 |
| R3 | webhook at-most-once + 聚合延迟 1–5min | 高（已缓解） | 实测延迟分布，校准兜底轮询周期 |
| R4 | last_edited_time 分钟粒度 + query filter 实际行为 | 中 | 验证 2min 回看窗；高频编辑下 hash 去重有效性 |
| R5 | 页面 block 膨胀（多轮验证后编辑/加载性能） | 中 | 构造 300+ 块页面实测；确认 8 轮归档阈值 |
| R6 | Notion mermaid 渲染器版本不可控 | 中 | flowchart/sequence 常用子集渲染矩阵测试，输出"安全语法子集"约束给报告 builder |
| R7 | status 属性/board view 不可 API 管理 | 低（已规避） | select + bootstrap 手册化写入 RUNBOOK |
| R8 | File Upload 1h attach 窗口 + 存储配额 | 低 | 批量截图上传实测；确认降级文案链路 |
| R9 | workspace 级共享限流被其他 integration 挤占 | 低 | 监控 429 率，网关预算可配置 |
| R10 | 假设"人不需要 Spec 的跨 Story 过滤视图" | 假设 | 上线后观察；被推翻则从 libsql 低成本追加投影一个 Specs DB，不动真相源 |

## 8. 增补（2026-09-01）：Requirements DB 与产品经理交互面

> 决策见 00-overview §2「产品经理层」。顶层结构从 2 核心 DB 扩为 3：Requirements 承载模糊大需求的完整生命周期。它与 Epic 的生命周期、属性集、视图形态均不同，且一个需求可拆出多个 Epic——符合 §2.1 自己的分库判据。Epic/Story 的结构与读写协议不变。

### 8.1 Requirements DB 属性 schema

| 属性 | 类型 | Owner | 说明 |
|---|---|---|---|
| 标题 | title | 人 | |
| 需求状态 | select（看板列） | 双通道（同 §4） | 待澄清/澄清中/PRD 待确认/拆解执行中/待验收/已验收/人工停靠——7 列，人可拖 |
| 优先级 | select P0–P3 | 人 | |
| Epics | relation → Epics | 系统（拆解时） | 一个需求 1..N 个 Epic |
| 成本(USD) | number | 系统 | 关联 Epic 成本汇总之和，由 orchestrator 写入 |
| 创建人 | created_by | — | 澄清问答与验收 @ 的对象 |
| 任务 ID / 同步指纹 | rich_text ×2 | 系统 | 同 Stories |

> 更正（2026-09-01，MP-01 实现时）：成本原设计为 rollup(sum of Epic 成本汇总)，但 Epic 成本汇总本身是 rollup，Notion 不支持 rollup 聚合 rollup，故改为系统写入的 number。

### 8.2 需求页面区段（2026-09-17 重做）

```
（前言）             人 owner；页面正文即原始需求，系统永不改写，也永不复制第二份；
                    只有以标题建的空卡才由系统把 original_request 写进前言
[callout]           澄清中 / PRD 待确认时写要做的动作，否则「现在没有等你处理的事。」
## 澄清记录          系统 owner；每轮一个 toggle「第 N 轮 · k 题 · 已回答/等你回答」，
                    子块为加粗问题、quote 选项、「答：」原文 + 系统解读；只追加
## PRD              系统 owner；目标段落、「不做」列表、编号「场景 N · 结果 code(短 id)」
                    （子块 前提/操作/结果）、等你裁决；确认后只加一条冻结横幅，正文再不改写
## 交付结果          只读一行：场景由承接它们的 Epic 逐批验收，本页只汇总
```

没有「元信息」「原始需求」「待人回答」「场景化验收清单」四个区：前三个复述了看板属性、人自己的话和评论通道，第四个的验收已下沉到 Epic 层（见 2.3）。旧页上的这些标题连同其下的块一次性归档，`交付结果` 由「场景化验收清单」原位改名（别名在词表里），锚点与其上的评论不受影响。区段锚点存 `requirement_notion_sections(section IN ('callout','clarify','prd','delivery'))`。

### 8.3 澄清通道 port（为飞书等旁路预留）

人机澄清交互收敛为 ClarificationChannelPort，day1 唯一实现 = Notion 需求页评论（复用评论水位 + 块锚点 + 意图解释器，零新设施）。不变量：**Notion 是唯一信息源**——任何旁路通道（飞书对话等）的问答结论必须由 orchestrator 回写到需求页「澄清记录」后才对状态机生效；旁路通道只加速人机往返，不构成第二真相源。

### 8.4 提问格式：问题 + 背景 + 选项（2026-09-04 增补）

凡 agent 停下来等人回答（PM 澄清批次、Epic 拆解 blocking question），问题一律是结构化对象 `{question, context?, options[{label, recommended?}]}`，共享实现在 `src/orchestrator/human-question.ts`：

- **呈现**：评论里每题列出一句话问题、一行「背景：」、字母编号的选项（推荐项带「（推荐）」），末尾固定追加「其他：直接写你的答案」兜底——选项由 agent 提供，兜底由系统追加，agent 不自己写。无选项的问题只显示问题本身。回复提示按批次形态给出（单题「写字母如 A」，多题「1A 2B」，全开放题「按序号回答」）。
- **回答**：人仍然只在评论里回复，不学指令。系统从回复里识别「题号 + 字母」（`1A` / `问 1：B` / `Q2. a`；单题可只写字母），把字母代表的选项文字**追加**在原文之后（「（系统解读：问 1 选 B = …）」），原文永不改写。识别不到就按自由文本原样归档，所以选项全错时人直接写答案即可。
- **校验**：选项 2–6 个、至多一个推荐、不重复；问题、背景、选项同受业务语言 lint。1 个选项视为无效（等于没给人选择）。
- **存储**：`requirement_clarify_rounds.questions` 存对象数组（旧行为纯字符串，读取时按开放题归一化）；Epic 的问题随 `epic.transition` 事件的 `question` 字段落库，`reason` 行仍保留问题一句话以便日志可读。
- 不新增停点类别、不新增 Notion 属性：这是评论正文与解析规则的约定，不是新的数据面。