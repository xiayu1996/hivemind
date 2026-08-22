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
| AI 状态 | select（看板列） | 双通道（见 §4） | 待启动/进行中/需要输入/待人确认/人工停靠/已完成/失败——仅 7 列，人可拖 |
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

### 2.3 Story 页面模板（人类视角）

```
┌─ 订单导出支持自定义列   [AI状态:进行中][阶段:验证中][P1][repo:xxx] ──────┐
│  元信息(callout,只读): 任务 a1b2 · 第 3 轮 · $4.20 · MR !2481          │
│                                                                        │
│  ## 需求描述                          (人写, agent 永不改写此区)        │
│                                                                        │
│  ## 需求规格                          (agent 生成; 人可评论/直接改文字) │
│    S1 [通过] 导出弹窗展示全部可选列, 默认勾选当前表格可见列              │
│    S2 [通过] 全部取消勾选时导出按钮置灰, 至少保留一列                    │
│    S3 [未过] 勾选状态按用户持久化, 下次打开保留上次选择                  │
│    S4 [待测] 超过 5 万行走异步导出, 完成后站内信通知                     │
│                                                                        │
│  ## 核心设计                          (≤15 行正文 + 至多 1 张 mermaid)  │
│                                                                        │
│  ## 验证记录                          (每轮一个 toggle, 最新展开置顶)   │
│    ▼ 第 3 轮 · 08-22 14:03 · 2/4 通过                                  │
│       S3 未过: 二次打开未保留勾选——偏好未落库, 下一轮修复               │
│       [截图: 导出弹窗.png]                                             │
│    ▶ 第 2 轮 …   ▶ 第 1 轮 …                                          │
│                                                                        │
│  ## 待人回答                          (仅 needs_input 时出现, @创建人)  │
│    Q1: "可见列"是否包含权限隐藏列? 直接在本块下评论回答即可              │
└────────────────────────────────────────────────────────────────────────┘
```

要点：

- **Spec 行格式**：每条 Spec 一个顶层块，`S{n} [状态] 业务语句`。稳定编号让人可在任何评论里口头引用（"S3 行为不对"）；状态标记每轮原位 update。libsql `spec` 表存 `(story_id, seq, text, status, notion_block_id)`——块 ID 映射是反馈锚定的基础。
- **测试轮次 = 页内 toggle**（不是子页面、不是独立 DB）：人只关心"这轮哪些场景过了"，折叠块 + 纯业务语言 + 截图即全部；>8 轮后旧轮批量搬入"历史验证记录"子页防膨胀。
- **核心设计区强制预算**：≤15 行正文 + 至多 1 张 mermaid + 零代码——代码细节属于 MR，不属于 Notion。
- Epic 页面：需求描述（人写）+ 拆解总览（系统写：每 Story 一行 page mention + 状态 + 一句话）+ Story 依赖 mermaid。API 不能创建 linked view，清单区由 orchestrator 维护，relation 属性兜底导航。

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

- 无全局"新评论"端点 → 维护**活跃集** = 非终态 Story ∪ 最近 7 天有变更页，逐页拉取。
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
| MR_CREATED（等人审） | MR 已建 | 待人确认 |
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
