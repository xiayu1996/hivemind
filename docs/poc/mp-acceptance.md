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

## 活体接线时发现并修复的闭环缺口

这些都是在真实看板上把链路接起来时才暴露的：各自的单测在自己的边界内是对的，缺口在边界之间（同 M2 验收的结论）。

| 缺口 | 后果 | 修复 |
|---|---|---|
| `EPIC_ACCEPT → DONE` 无任何代码触发 | 需求永远进不了 ACCEPTANCE | `EpicCompletion` 经 `gh`/`glab` 读回 MR merged；隶属需求的 Epic 合并即 DONE（人的验收在需求页按场景勾选），独立 Epic 还需人拖到「已完成」（03 §7.2 带日期补记） |
| 看板 `Epic 状态` 从未被系统投影 | Epic 永远停在「待拆解」；退回重拆时也无法回到 intake 过滤条件 | outbox `sync_epic_status`，投影同时写 `notion_status_shadow`（01 §2.2 带日期补记） |
| 需求页人类输入解释器只在测试里被调用 | PRD 批准/修改意见、验收勾选与缺口留言、停靠/恢复在活体上无人读取 | `NotionRequirementInputSync` 接进需求循环，每个决定按评论/勾选 id 只认领一次 |
| 需求循环与 orchestrator 共用 outbox，互相把对方的行判为不支持 | attempts 虚增；一侧积压超过 100 行时另一侧饿死 | `replay(delivery, { operations })` 按操作过滤 |
| Story worker 浏览器白名单硬编码 `localhost/127.0.0.1` | 三层红线不再同源 | 读 `guard.e2eHostAllowlist` |

## 披露（判据 ② 相关）

- **澄清记录第一轮两行署名为 user id 而非人名**：人名解析在第二轮之前才上线。澄清记录按设计只追加，未回头改写这两行；它们是当时真实发生的样子。
- **本机库手工建表**：`data/hivemind-mp.db` 建于 `notion_users` 表加入 `0001_init.sql` 之前；预发布立场不加 `0002+` 迁移，故用同一份 DDL 手工建了该表，未删库重建（删库会丢掉这条需求的澄清历史）。全新环境不受影响。Linux 验收环境将从零建库，不带此痕迹。

## 尚未发生

- Linux 主机上执行 `deploy/linux/install.sh` → `npm run preflight` → 两个 systemd 单元起来；同机重跑 `smoke-browser-e2e`。
- 第三轮回答 → PM 判充分 → PRD 写入需求页 → 人批（评论「批准」或拖到「拆解执行中」）。
- 拆解为 ≥1 Epic（≥2 Story）→ Epic 拆解方案人批 → Story 开发交付 → Epic MR → 人合并 → 需求进 ACCEPTANCE → 逐场景勾选。
- 判据 ③：至少一个 Story 的 VERIFY 含真实浏览器 e2e 证据（截图/trace 落在证据目录，host 在白名单内）。
- 带外告警通道（`FEISHU_WEBHOOK_URL` 或 `SMTP_*`）：orchestrator 在无通道时拒绝启动，本机 preflight 的唯一 WARN。
