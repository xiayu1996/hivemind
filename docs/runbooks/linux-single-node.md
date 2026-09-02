# Linux 单节点部署

一台 Linux 主机同时跑两个常驻进程，共用一份中央 libsql 与一个 Notion outbox：

| 进程 | 入口 | 职责 |
|---|---|---|
| `hivemind-orchestrator` | `scripts/run-local-orchestrator.ts` | Epic 拆解与人批 gate、Story 派单与 worktree、盲审/合入/MR、Epic 完成判定（MR 合并）、回归 loop |
| `hivemind-requirements` | `scripts/run-requirement-loop.ts` | 产品经理：需求接单、多轮业务澄清、PRD 与人批、拆成 Epic 写回看板、场景化验收 |

不需要 Redis：单节点不经 BullMQ 派单，Story 作为本机子进程执行（02 §3 的多机 worker 是 M3 的事）。Notion 变更靠 60s 兜底轮询收敛；webhook 只是加速，单节点可以不配隧道。浏览器 e2e 走本机 headless Chromium（02 §4.3 双车道），不依赖 Mac mini。

凭据规则不变：全部在 `~/.hivemind/secrets.env`（600）与 `~/.pi/agent/auth.json`，不进命令行、日志、截图、对话。

## 1. 安装

前置：Node ≥ 26（nvm/fnm 均可）、git、`gh`（GitHub）或 `glab`（GitLab）。

```sh
git clone <hivemind> ~/hivemind
cd ~/hivemind
deploy/linux/install.sh --repository-path <被开发仓库的本地 checkout>
```

脚本幂等，做的事：`npm ci`；安装 pinned pi（`scripts/install-pi.sh`，校验 SHA256）；安装 Playwright headless shell 及系统库（缺 root 时会提示 sudo）；建 `~/.hivemind`（700）与 `secrets.env` 模板（600）；写 `~/.hivemind/service.env`（node 路径与仓库参数，systemd 不加载登录 shell）；安装两个 systemd 用户单元。被开发仓库可以就是 hivemind 自己（自举）。

## 2. 凭据与看板

1. 填 `~/.hivemind/secrets.env`：`NOTION_TOKEN`、`HIVEMIND_NOTION_PARENT_PAGE_ID`（把该页共享给 integration），以及一条带外告警通道（`FEISHU_WEBHOOK_URL` 或 `SMTP_*`；没有它 `needs_input` 停点无人知道，启动会被拒）。
2. `scripts/pi-login.sh`：pi 的登录只在其 TUI 里，无头机 ssh 进去选 device-code 流程。
3. `gh auth login`（或 `glab auth login`）。
4. `npx tsx scripts/notion-bootstrap.ts`：建三张库并把 data source id 与 bot user id 原子写进 secrets 文件；看板视图按 `notion-bootstrap.md` 手工建。已有 Epics/Stories 看板只补 Requirements 库时加 `--requirements-only`。

## 3. 就绪探针

```sh
npm run preflight -- --repository-path <repo>
```

逐项 PASS/WARN/FAIL：Node 版本、pi 版本、secrets 文件权限与键、Notion 可达与三张库已共享、库迁移与配置断言（模型 id 存在于目录、provider 重试关闭、带外通道）、failover 链各 provider 凭据就绪、四个 purpose 档位都有 provider、`gh`/`glab` 已登录、git 身份、仓库 origin、headless Chromium 已装。任何一项 FAIL 不要启动服务；探针不打印任何凭据值。

## 4. 启动与观察

```sh
loginctl enable-linger $USER
systemctl --user enable --now hivemind-orchestrator hivemind-requirements
journalctl --user -fu hivemind-orchestrator
journalctl --user -fu hivemind-requirements
```

两单元 `Restart=always`；`--once` 模式下才会把失败抛出，常驻模式下单轮失败只记日志并触发 P0 告警（同一错误十分钟内只报一次）。

改配置：`data/hivemind.db` 的 `config_overrides`（控制台或 `scripts/`），热更语义见 registry；改 `secrets.env` 后需 `systemctl --user restart`。

## 5. 单节点闭环的验收顺序

1. 在 Requirements 看板建一张十句话级模糊需求卡 → 需求页评论出现 PM 的第一轮业务问题 → 在评论里回答（不要 resolve）。
2. PM 判充分后 PRD 写入需求页、状态置「PRD 待确认」→ 评论「批准」或拖列。
3. PM 拆出 Epic 写入 Epics 库（关联回需求）→ orchestrator 接单拆 Story → Epic 页出现拆解方案、状态「拆解待确认」→ 拖到「进行中」批准。
4. Story 依次 DESIGN/CODE/VERIFY/MERGE，落到 `epic/<id>` 分支；全部交付后 orchestrator 建 Epic MR，Epic 置 EPIC_ACCEPT。
5. 人在平台合并 MR → 下一轮 orchestrator 读到 merged，Epic → DONE、看板「已完成」→ 需求进 ACCEPTANCE，需求页出现按 PRD 场景的验收清单。
6. 逐条勾选 → 需求 DONE；有缺口的项留言不勾 → PM 立增量 Epic 回 EXECUTING。

四类设计内人工 gate 之外若出现人工干预（临时脚本、手改库），记入 `docs/poc/mp-acceptance.md`，不得静默。
