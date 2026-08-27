# Notion 行为实测（R1 / R2 / 块规模与 mermaid）

> 执行日期 2026-08-27 · 实测页面：Home / `hivemind PoC · M0 Notion 行为实测（可删）`
> （测试页，验证完成后可删）
> 结论：**R1 证伪原方案（必须改协议）· 新发现一项高影响约束 · 块规模与 mermaid PASS**

## R1：resolve 掉的评论，API 永久取不回 —— 风险坐实

公共 REST API 的 `GET /v1/comments` **只返回未 resolve 的评论，且没有任何参数可以包含已 resolve 的**
（[Notion 官方文档](https://developers.notion.com/guides/data-apis/working-with-comments)；
[第三方导出工具的同一结论](https://restora.cc/tools/export-notion-comments)：唯一办法是回 UI 取消 resolve）。

注意区分：Notion 官方托管的 MCP server 的 `get-comments` **有** `include_resolved` 参数（默认 false），
说明能力在服务端存在，但**未开放给公共 API**。hivemind 用自己的 integration token 走 REST，拿不到这个能力。

**协议修订（写入 01 文档）**：不能指望"人 resolve 后我们还能补读"。必须

1. `comment.created` webhook 秒级 ingest 为主路径（评论诞生即入库，早于人 resolve）；
2. 轮询兜底窗口必须短于人的典型 resolve 时延；
3. 明确约定 **agent 回评确认后人再 resolve**，并在 Story 页模板里写死这句话给人看；
4. 已 ingest 的评论落库后就是本地真相，不再依赖 Notion 侧可读性。

## 新发现（高影响）：块级评论必须逐 block 拉取

按 page_id 查询**只返回页级评论**；锚定在具体行（block）上的评论不会出现在结果里。

实测：页面上有两个 discussion（1 个页级、1 个锚在 S1 规格行）。
- `include_all_blocks: true` → `total-count="2"`，两个都在
- 默认（等价于按 page_id 查 REST）→ `total-count="1"`，**S1 行上的评论完全不可见**

对设计的冲击：01 文档原写"活跃集逐页拉取"评论。但 Story 页恰恰把 Spec 清单做成一行一块、
并鼓励人在具体 Spec 行上评论——**这类反馈正是最有价值的那种，而它恰恰是页级拉取取不到的**。
而一个 Story 页有 300+ 块，在 2.5 rps 的全局预算下逐块轮询不可行。

**修订**：轮询按**已登记的锚点 block 列表**拉取，而不是全页块。Story 页 builder 本来就持久化了
每个 Spec 行的 blockId（区段锚块机制），锚点集合规模是每卡个位数到几十，完全在预算内。
非锚点块上的评论由 `comment.created` webhook 覆盖，轮询不负责。

## R2：@mention 推送 —— 待人确认

已通过 API 在测试页发出一条含 `mention-user` 的评论 @Ryan。**需要 Ryan 确认手机是否收到推送**。

一个必须记下的干扰项：本次评论经 claude.ai 的 Notion connector 发出，作者被记为 Ryan 本人
，而 Notion 通常不会因为"你 @ 你自己"而推送。
hivemind 用自己的 integration token 时作者是 bot，@人属于跨用户提醒，行为可能不同。
**因此本条无论结果如何都需在拿到 integration token 后用 bot 身份复测一次**，
否则 needs_input 这条命脉通道的可用性没有真凭据。

## 块规模与原位更新 —— PASS

| 项 | 结果 |
|---|---|
| 单次插入 300 块 | PASS，一次调用完成，无拒绝 |
| ~330 块页面上的定点原位更新 | PASS，一次调用内两处替换（含最末块）全部命中 |
| 原位更新后块级评论锚点 | **PASS，仍锚定同一 block id**（block id 不变），UI 上批注仍对准该行 |

最后一项是整个"区段内 diff-update 原位改"协议的前提：改 Spec 行状态不会打断人挂在该行上的讨论。
前提成立。

附带发现：Notion-flavored markdown 会转义方括号，`S1 [已通过]` 存为 `S1 \[已通过\]`。
block builder 读回做 diff 时必须先反转义，否则每轮都会误判为"内容变了"而重复写入。

## mermaid 渲染子集 —— PASS

`stateDiagram-v2` / `flowchart LR` / `sequenceDiagram` 三种全部真实渲染（证据：`evidence/m0-10-notion-mermaid.jpg`），
**中文节点标签与中文 participant 均正常**——这对"业务语言优先"的设计是硬需求。

可读性注意：代码块默认**同时显示源码和渲染图**，纵向占双倍空间。设计总结区段若放 mermaid，
一屏读完的目标会被源码挤掉。M1 的 Story 页 builder 需确认能否经 API 设置代码块为
"仅预览"显示模式；不能则把 mermaid 放在设计正文之后，避免顶掉正文。
