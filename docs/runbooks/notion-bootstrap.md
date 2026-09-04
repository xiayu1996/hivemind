# Notion bootstrap

数据库属性由脚本管理；视图与首页布局仍按本文人工（或经 Notion MCP）创建。不要把 integration token 放进命令行、仓库或截图。

## 前置

1. 在 Notion 建立顶层 `Hivemind · Agent Delivery Hub` 页面，并把页面共享给 hivemind integration。
2. 在 `~/.hivemind/secrets.env` 写入 `NOTION_TOKEN`；文件权限只允许当前用户读取。
3. 运行：

   ```sh
   npx tsx scripts/notion-bootstrap.ts --parent <Agent Delivery Hub page id>
   ```

4. 脚本会把 Stories data source ID 与 integration bot user ID 原子写入本机 secrets 文件；输出的其余 database/data source ID 只用于验收记录，不要贴进对话或无关日志。

脚本创建的属性里有三类只服务于人的可读性，orchestrator 不读写它们：

| 属性 | 库 | 作用 |
|---|---|---|
| `最近更新` | 三库 | last_edited_time，供「等待时长」与排序 |
| `等待人` | 三库 | formula：状态落在需要人的列时显示 `🙋 等你… N 小时`，否则为空 |
| `进度` | Epics | formula：`已完成数 / Story 总数` 的百分比 |

选项配色写在 `src/notion/notion-schema.json` 的 `optionColors`，**只在创建时生效**：Notion API 拒绝给已存在的选项改色（`Cannot update color of select with name`）。对已建成的看板，配色要在 Notion UI 里手动按该表设置一次。

Windows 上的完整 bootstrap、Webhook 验证和单卡验收顺序见 `m1-live-acceptance.md`。Webhook 首次发送的 verification token 由服务原子写入 secrets 文件，响应和日志均不包含 token。

## 视图

每个库的默认 table 视图重命名为 `全部`，隐藏 `任务 ID` / `同步指纹` / `完成值`，按 `最近更新` 倒序，冻结首列。

### Stories

| 视图 | 类型 | 配置 |
|---|---|---|
| 看板 | board | 按 `AI 状态` 分组，七列顺序 `待启动 → 进行中 → 需要输入 → 待人确认 → 人工停靠 → 已完成 → 失败`；卡片显示 `等待人`、`执行阶段`、`优先级`、`Epic`、`目标仓库`、`轮次`、`成本(USD)`、`MR`；排序 `优先级` 升序、`最近更新` 倒序 |
| 🙋 需要我 | table | 过滤 `AI 状态 ∈ {需要输入, 待人确认, 失败}`，按 `最近更新` 升序（等得最久的在最上） |
| 按 Epic | table | 按 `Epic` 分组，显示状态/阶段/轮次/成本/MR |

新建一张临时卡，逐列拖动确认七列都可落入，随后移到回收站。

### Epics

| 视图 | 类型 | 配置 |
|---|---|---|
| 看板 | board | 按 `Epic 状态` 分组；卡片显示 `等待人`、`需求`、`进度`、`Story 总数`、`成本汇总(USD)`、`目标日期` |
| 时间线 | timeline | 按 `目标日期` |

### Requirements

| 视图 | 类型 | 配置 |
|---|---|---|
| 看板 | board | 按 `需求状态` 分组；卡片显示 `等待人`、`优先级`、`Epics`、`成本(USD)`、`创建人` |

## 首页布局

首页是人的唯一入口，目标是一屏看完、无横向滚动、先看到「agent 在等我什么」。从上到下：

1. **说明 callout（一段）**：只做三件事——评论回答、拖列批准或打回、拖到「人工停靠」暂停；链接到子页「使用指南」。
2. **📋 看板**：三列，每列一个整页数据库入口（`💡 需求` / `🧩 Epics` / `🔧 Stories`）加一句话说明。看板本身在各自数据库页里，不内嵌到首页（七列 board 必然横向滚动）。
3. **🙋 等我处理**：三个 linked **list** 视图（table 会撑出横向滚动条），分别过滤 需求 `∈ {澄清中, PRD 待确认, 待验收}`、Epic `= 拆解待确认`、Story `∈ {需要输入, 待人确认, 失败}`，都按 `最近更新` 升序，卡片只显示 `等待人` 与状态。三个都为空即 agent 没有在等人。
4. **📖 资料**：子页「使用指南」（三个动作的细则、页面各区段谁维护、状态速查、如何建需求）；历史探针页收进折叠块。

数据库标题带 emoji（`💡 需求` / `🧩 Epics` / `🔧 Stories`）只为侧栏与 linked view 标题可辨识；代码只按 data source ID 访问库，不依赖标题。

## 验收记录

把 database/data source ID、七列拖动截图和执行日期写入 `docs/poc/m1-acceptance.md`。截图不得包含 token、浏览器开发者工具请求头或 secrets 文件内容。
