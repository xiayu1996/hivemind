# M0 评审：逐项 go/no-go

> 评审日期 2026-08-27 · 执行环境：macOS 笔记本 · pi 0.84.3 pin
> 总体结论：**架构无致命证伪，可进 M1**；产出 4 项设计修订、1 项新增高影响约束、6 项待活体复测。

## 逐项结论

| ID | 项 | 结论 | 说明 |
|---|---|---|---|
| M0-01 | 账号策略拍板 | **待 Ryan 决策** | 唯一卡住多项活体 PoC 的前置。理由已精确化，见下 |
| M0-02 | pi 安装与 pin | **PASS** | `scripts/install-pi.sh`，校验和 + 幂等 + 全新环境安装均验证；GLM/Grok 冒烟待凭据 |
| M0-03 | PoC-2a Context 往返 | **PASS** | canonical diff 为空，重载后按序续跑 |
| M0-04 | PoC-2b 注入/abort/resume | **PASS** | steer 投递、abort 后进程可复用、跨进程 resume 全通 |
| M0-05 | PoC-5 错误目录 | **PASS** | 7 类样本入 fixtures，单一提取契约 + 优先级分类规则 |
| M0-06 | Windows 冒烟 | **未执行** | 物理不可达（本机非目标节点、未组网） |
| M0-07 | prompt A/B | **部分** | 默认 prompt 已量化读全并得出结论修订；质量盲评待凭据 |
| M0-08 | R1 评论 resolve | **原方案被证伪** | REST 永久取不回已 resolve 评论；协议已修订 |
| M0-09 | R2 @mention 推送 | **待 Ryan 确认** | 已发出测试 @；且需 bot 身份复测（见下） |
| M0-10 | 块规模与 mermaid | **PASS** | 300 块、大页定点更新、锚点保全、三种图含中文均渲染 |
| M0-11 | C1 device code 登录 | **机制核实，活体待决策** | 存在但入口在 TUI，非 CLI |
| M0-12 | C2 usage-limit 解析 | **PASS（源码级）** | 解析器 + 8 单测全绿，模板由二进制反推非猜测 |
| M0-13 | C3 探针零副作用 | **参数语义确认，mtime 待活体** | 另发现退出码陷阱 |
| M0-14 | C4 并发刷新锁 | **机制确认** | proper-lockfile 锁 auth.json，同机安全 |
| M0-15 | C5 Mac mini 登录态 | **未执行** | Mac mini 不可达 |

## 必须回写设计的四项修订

1. **RPC 无 Context 载入命令**（02 文档）。导出有 `get_messages`，载入只能靠 session JSONL 文件。
   → checkpoint 必须保留可被 pi 直接加载的 session 文件，不能只存消息数组。
   （对"无状态全量注入"零影响，反而印证该决策绕开了唯一的能力缺口。）

2. **块级评论必须按锚点 block 拉取**（01 文档，**新增高影响约束**）。按 page_id 查只返回页级评论，
   Spec 行上的评论——最有价值的那类反馈——完全取不到。原"活跃集逐页拉取"会静默漏掉它们。
   → 轮询改为按已登记的 Spec 锚点 blockId 集合拉取（每卡个位数到几十，预算内），
   非锚点块交给 `comment.created` webhook。

3. **已 resolve 的评论 API 永久不可见**（01 文档）。无参数、无绕过。
   → webhook 为主 + 短轮询兜底 + 在 Story 页模板里对人写明"等 agent 回评确认后再 resolve"。

4. **prompt 是追加而非替换**（02/03 文档）。pi 默认 prompt ≈2.3k token，内容全是自家工具的正确用法；
   自建基线层提供的是工程纪律，两者互补。→ 用 `--append-system-prompt` 叠加，
   `--system-prompt` 完全替换降级为备选；A/B 对照相应改为三臂。

## 两个必须记住的运维陷阱

- `pi auth check` **not_ready 时退出码仍为 0**，健康探针必须解析 JSON `status` 字段。
- usage-limit 文案里的分钟数是 pi **生成字符串那一刻**折算的相对值，
  必须锚定事件自身时间戳；事件在 outbox 积压过再解析就会算错恢复窗口。

## 给 Ryan 的两个待办

1. **账号策略拍板（M0-01）**：推荐一机一账号。本轮把理由精确化了——
   `~/.pi/agent/auth.json` 与 `~/.codex/auth.json` 相互独立，同一台机器上给 pi 登录**不会**
   弄坏你现有的 codex CLI；真正互踩的是把同一份 auth.json 复制到多台机器（refresh token 轮换）。
   所以问题只剩一个：跑 pi 的 Linux 与 Mac mini 是否各配一个 ChatGPT 账号（即是否再买一份订阅）。

2. **确认 @mention 推送（M0-09）**：测试页已发出一条 @你的评论
   （页面「hivemind PoC · M0 Notion 行为实测（可删）」）。收到推送与否都请告知——
   注意本次是以你自己的身份发的，Notion 一般不推送"自己 @ 自己"，
   所以即使没收到也不能判死刑，仍需拿到 integration token 后用 bot 身份复测。

## 进入 M1 的前置

- 阻塞 M1 的只有 **provider 凭据**（GLM/Grok key 或 Codex 登录）——没有它无法跑真实卡。
- Windows/Mac mini 相关项（M0-06/C5）不阻塞 M1（M1 是 Linux 单机闭环），
  顺延到 M3 组网后与 M3-08 一并执行。
