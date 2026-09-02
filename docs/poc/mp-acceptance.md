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

## 尚未发生

- Linux 主机上执行 `deploy/linux/install.sh` → `npm run preflight` → 两个 systemd 单元起来；同机重跑 `smoke-browser-e2e`。
- 第三轮回答 → PM 判充分 → PRD 写入需求页 → 人批（评论「批准」或拖到「拆解执行中」）。
- 拆解为 ≥1 Epic（≥2 Story）→ Epic 拆解方案人批 → Story 开发交付 → Epic MR → 人合并 → 需求进 ACCEPTANCE → 逐场景勾选。
- 判据 ③：至少一个 Story 的 VERIFY 含真实浏览器 e2e 证据（截图/trace 落在证据目录，host 在白名单内）。
- 带外告警通道（`FEISHU_WEBHOOK_URL` 或 `SMTP_*`）：orchestrator 在无通道时拒绝启动，本机 preflight 的唯一 WARN。
