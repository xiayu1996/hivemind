# Notion bootstrap

数据库属性由脚本管理；看板视图仍按冻结设计人工创建。不要把 integration token 放进命令行、仓库或截图。

## 前置

1. 在 Notion 建立顶层 `Agent Delivery Hub` 页面，并把页面共享给 hivemind integration。
2. 在 `~/.hivemind/secrets.env` 写入 `NOTION_TOKEN`；文件权限只允许当前用户读取。
3. 运行：

   ```powershell
   npx tsx scripts/notion-bootstrap.ts --parent <Agent Delivery Hub page id>
   ```

4. 脚本会把 Stories data source ID 与 integration bot user ID 原子写入本机 secrets 文件；输出的其余 database/data source ID 只用于验收记录，不要贴进对话或无关日志。

Windows 上的完整 bootstrap、Webhook 验证和单卡验收顺序见 `m1-live-acceptance.md`。Webhook 首次发送的 verification token 由服务原子写入 secrets 文件，响应和日志均不包含 token。

## Stories 看板

1. 打开脚本创建的 Stories database，新增 Board view。
2. 以 `AI 状态` 分组，按以下顺序保留七列：
   `待启动 → 进行中 → 需要输入 → 待人确认 → 人工停靠 → 已完成 → 失败`。
3. 卡片预览设为 Page content；卡片显示 `执行阶段`、`优先级`、`目标仓库`、`成本(USD)`、`轮次`。
4. 隐藏空分组，关闭未分组列。
5. 新建一张临时卡，逐列拖动并确认七列都可落入；随后将临时卡移到回收站。

## Epics 视图

新增 Table view，显示 `Epic 状态`、`Story 总数`、`已完成数`、`成本汇总(USD)` 和 `目标日期`。

## 验收记录

把 database/data source ID、七列拖动截图和执行日期写入 `docs/poc/m1-acceptance.md`。截图不得包含 token、浏览器开发者工具请求头或 secrets 文件内容。
