# Linux 单节点部署

一台 Linux 主机跑两个常驻进程，共用一份中央 libsql 与一个 Notion outbox：

| 进程 | 入口 | 职责 |
|---|---|---|
| `hivemind-orchestrator` | `scripts/run-local-orchestrator.ts` | Epic 拆解与人批 gate、Story 派单与 worktree、盲审/合入/MR、Epic 完成判定、回归 loop |
| `hivemind-requirements` | `scripts/run-requirement-loop.ts` | 产品经理：需求接单、业务澄清、PRD 与人批、拆成 Epic 写回看板、场景化验收 |

支持的主机：Ubuntu/Debian、Arch 系（含 Omarchy）、Windows 上的 WSL2 Ubuntu。三者走同一条命令，脚本自行识别包管理器与 WSL。不需要 Redis：单节点 Story 作为本机子进程执行。浏览器 e2e 用本机 headless Chromium。

凭据只存在 `~/.hivemind/secrets.env`（600）与 `~/.pi/agent/auth.json`，不进命令行、日志、截图、对话。

## 1. 一条命令

前置只有两项：Node ≥ 26（Ubuntu 用 nvm/fnm；Arch 用 `pacman -S nodejs npm`）和 git。WSL 需先启用 systemd（脚本检测到未启用会给出 `/etc/wsl.conf` 写法并停下）。

```sh
git clone <hivemind> ~/hivemind
cd ~/hivemind
deploy/linux/install.sh --repository-path <被开发仓库的本地 checkout>
```

脚本幂等，可反复执行。它按顺序做：识别发行版与 WSL；校验 Node；`npm ci`（lockfile 未变则跳过）；装 Chromium 系统库（apt 走 Playwright 自带清单，Arch 走 pacman `--needed`）；Ubuntu 23.10+ 解除 AppArmor 对用户命名空间的限制并写入 `/etc/sysctl.d/`（否则 Chromium 沙箱报 `No usable sandbox!`，不要用 `--no-sandbox` 绕过）；装 pinned pi（版本在 `package.json` 的 `hivemind.piVersion`，SHA256 校验）；装 `deploy/pi/models.json` 到 `~/.pi/agent/`（hivemind 追加给 pi 的模型声明；已存在且内容不同时原地停下并打 diff，不覆盖手工配置）；装 headless shell；建 `~/.hivemind`、`secrets.env` 模板、`service.env`（systemd 不加载登录 shell，node 路径要写死）；渲染两个 systemd 用户单元。

之后进入需要人的阶段。每到一个未完成的阶段脚本以退出码 2 停下，只打印一件事：

| 停在 | 你要做的 |
|---|---|
| Credentials | 在 `secrets.env` 填 `NOTION_TOKEN`、`HIVEMIND_NOTION_PARENT_PAGE_ID`，以及一条告警通道（`FEISHU_WEBHOOK_URL` 或 `SMTP_*`） |
| pi provider login | 交互终端里脚本会直接拉起 `scripts/pi-login.sh`；无头机 ssh 进去选 device-code 流程 |
| gh / glab login | 交互终端里脚本直接拉起 `gh auth login`（或 `glab auth login`） |

再跑一次同一条命令即从停下处继续。Notion 三张库在 id 缺失时自动 bootstrap 并把 id 与 bot user id 写回 secrets 文件（已有 id 则跳过，不会重复建库）；看板视图按 [notion-bootstrap.md](notion-bootstrap.md) 手工建一次。最后跑就绪探针，全部 PASS 才启动并 `enable-linger`，之后打印 `journalctl` 命令。拉取新代码或改过 `secrets.env` 后重跑同一条命令，服务会被重启。

## 2. 凭据怎么来

- **Notion**：在 Notion 开发者后台建内部 integration，能力勾选读/写/插入内容、读/插入评论、用户信息（不含邮箱）。建一个顶层页面并把 integration 加进该页的 connections，只共享这一页及其子页。token 填 `NOTION_TOKEN`，页面 id 填 `HIVEMIND_NOTION_PARENT_PAGE_ID`。
- **pi provider（订阅制，如 openai-codex）**：pi 的登录只在其 TUI 里。每台机器各自登录，不复制 `auth.json`。探针一律 `pi auth check --no-refresh`，它在 `not_ready` 时退出码仍为 0，脚本解析 JSON 里的 `status`。
- **Command Code（包月计划，走 API key）**：在 Command Code Studio 建一个 Provider API key，写进 `secrets.env` 的 `COMMAND_CODE_API_KEY`。它是中脑与小脑两档的第一跳，承担 CODE/VERIFY 与所有机械调用（哪个 model id 服务哪个档是价格决定，在 `model.providers` 里改，console 或 `scripts/provider-add.ts` 都行）。大脑档由 `model.tierFailoverChains` 单独排序：`openai-codex` 的 `gpt-5.6-sol` 在前，Command Code 在后，官方 deepseek 兜底——ChatGPT 窗口打满只会让大脑降级，不会让看板停工；真正能让它停的只有最后那个计费 API 没钱。计划是包月定额、无超额计费，所以 profile 里写明 `billing: "subscription"`，单卡费用上限不对它计数。
- **pi provider（API key 制）**：把 key 写进 `secrets.env`，变量名以 pi 的 `docs/providers.md` 为准（如 `DEEPSEEK_API_KEY`）。两个 systemd 单元都以 `EnvironmentFile=-` 加载这个文件，runner 再把它透给 pi 子进程。`auth check` 对这类 provider 只验 key 是否存在——实测填一个假 key 也返回 `ready`——所以探针会另跑一次 cheap 档的真实往返来验有效性。
- **gh / glab**：`gh auth login --git-protocol ssh --web`。最小权限是仓库读写与 PR 创建，不给组织管理。
- **告警通道**：飞书群自定义机器人的 webhook，或一套 SMTP 应用密码（`SMTP_TO` 支持逗号分隔多人）。配好后 `npx tsx scripts/smoke-alert.ts` 发一条 P0 冒烟，脚本只打印通道名。

## 3. 就绪探针

安装脚本末尾会跑，也可单独跑：

```sh
npm run preflight -- --repository-path <repo>
```

逐项 PASS/WARN/FAIL：Node、pi 版本、secrets 权限与键、Notion 可达与三库已共享、库迁移与配置断言、failover 链各 provider 凭据与一次真实往返、四个 purpose 档位都有 provider、`gh`/`glab` 已登录、git 身份、仓库 origin、systemd 为 PID 1、内核允许 Chromium 沙箱、headless Chromium 已装。任何 FAIL 都不要启动服务；探针不打印凭据值。

## 4. 运行中

```sh
journalctl --user -fu hivemind-orchestrator
journalctl --user -fu hivemind-requirements
systemctl --user restart hivemind-orchestrator hivemind-requirements
```

两单元 `Restart=always`；常驻模式下单轮失败只记日志并触发 P0 告警（同一错误十分钟内只报一次）。改配置走 `data/hivemind.db` 的 `config_overrides`，热更语义见 registry；改 `secrets.env` 后重跑安装脚本或手动 restart。

## 5. 单节点闭环的验收顺序

1. 在 Requirements 看板建一张十句话级模糊需求卡 → 需求页评论出现 PM 的第一轮业务问题 → 在评论里回答（不要 resolve）。
2. PM 判充分后 PRD 写入需求页、状态置「PRD 待确认」→ 评论「批准」或拖列。
3. PM 拆出 Epic 写入 Epics 库 → orchestrator 接单拆 Story → Epic 页出现拆解方案、状态「拆解待确认」→ 拖到「进行中」批准。
4. Story 依次 DESIGN/CODE/VERIFY/MERGE，落到 `epic/<id>` 分支；全部交付后 orchestrator 建 Epic MR，Epic 置 EPIC_ACCEPT。
5. 人在平台合并 MR → 下一轮 orchestrator 读到 merged，Epic → DONE → 需求进 ACCEPTANCE，需求页出现按 PRD 场景的验收清单。
6. 逐条勾选 → 需求 DONE；有缺口的项留言不勾 → PM 立增量 Epic 回 EXECUTING。

四类设计内人工 gate 之外若出现人工干预（临时脚本、手改库），记入 `docs/poc/mp-acceptance.md`，不得静默。
