# 运维手册：单机运行

## 1. 准备

- Node 26（`.nvmrc`）、git；目标仓库要推送和开 PR 时还要 `gh`（`gh auth login` 过）。
- `npm ci`，然后 `npx playwright install chromium`（评审与重放用的 headless 浏览器）。
- 订阅型 provider（如 openai-codex）要在 pi 里登录一次：`npx pi`，进去后 `/login`，登录存进 `~/.pi/agent/auth.json`。
- 计费型 provider 的密钥写进 `~/.hivemind/secrets.env`，每行 `NAME=value`，名字与 `config/models.yaml` 的 `apiKeyEnv` 一致：

  ```sh
  touch ~/.hivemind/secrets.env && chmod 600 ~/.hivemind/secrets.env
  # 用编辑器写入，例如 DEEPSEEK_API_KEY=... ；不要把密钥贴进终端历史或对话
  ```

  文件不是 600 会拒绝启动。secrets 只读进内存，只随请求发给对应的 provider，不进任何命令的环境。

## 2. 实例配置

`~/.hivemind/config.yaml`（或 `HIVEMIND_CONFIG` 指向的文件）。不存在时全部取默认：本地看板、没有仓库。

```yaml
workRoot: ~/.hivemind/work          # 仓库 checkout、每个需求的 worktree、验收截图、日志
database: ~/.hivemind/hivemind.db
board:
  kind: local                       # 本地看板：~/.hivemind/board
  # kind: notion
  # dataSourceId: <requirements 数据源 id>
  # botUserId: <integration 自己的 user id>
  # tokenSecret: NOTION_TOKEN       # secrets.env 里的名字
repositories:
  - name: demo                      # 提需求时用这个名字指定仓库
    url: git@github.com:acme/demo.git
    defaultBranch: main
    push: true                      # 每项通过后推集成分支，终审通过后开 PR
    recipe: feature                 # 提需求没指定流程时用：greenfield / feature / small-change
budgetUsd: 20                       # 每个需求的上限，API 等价价格，订阅也计入；0 表示不设
pollSeconds: 60
# limits: { maxItemAttempts: 3, maxReplans: 1, maxAuthorSessions: 2, maxInconclusive: 2, maxHandbacks: 3 }
# sessions: { builder: { maxTurns: 250, timeoutMinutes: 90 } }
# passEnv: [DATABASE_URL]           # 被测产品启动时需要、且不是凭据的变量
```

目标仓库的默认分支在 origin 上必须已有至少一个提交。模型与候选顺序改 `config/models.yaml`（或实例配置里 `models:` 指向自己的文件）。

## 3. 上线前检查

```sh
node src/main.ts preflight           # 配置、凭据在不在（不刷新登录）、git / gh、仓库可达、看板、浏览器
node src/main.ts preflight --probe   # 再给每个模型发一条最短请求：目录里有的 id 不一定是这个账号能用的
```

任何一项 FAIL 退出码非零。

## 4. 运行

```sh
node src/main.ts run
```

前台常驻；一个库只允许一个进程。`SIGINT` / `SIGTERM` 会结束在跑的会话和被测产品后退出，状态每做完一个单位就落库，
重启后接着做，至多重做被打断的那一个单位（被打断的会话记为 `interrupted`，它的用量随进程丢失）。
日志是 `~/.hivemind/work/logs/hivemind.jsonl`，每行一个 JSON，已脱敏。

作为常驻服务（Linux，systemd 用户单元）：

```ini
# ~/.config/systemd/user/hivemind.service
[Unit]
Description=hivemind

[Service]
WorkingDirectory=%h/hivemind
ExecStart=/usr/bin/env node src/main.ts run
Restart=on-failure
RestartSec=30

[Install]
WantedBy=default.target
```

`systemctl --user enable --now hivemind`；无人登录时也要跑就 `loginctl enable-linger $USER`。
改了本仓库的源码要重启服务才生效（它在进程内运行，不是每次重新加载）。

## 5. 日常操作（本地看板）

```sh
node src/main.ts submit --repo demo --title "任务看板" --body-file req.md [--recipe greenfield]
node src/main.ts status                 # 全部需求：状态、步骤、花费
node src/main.ts status <ref>           # 一条需求：在等什么、每一项的尝试次数、最近的事件
node src/main.ts approve <ref>          # 批准它正在等的那一版
node src/main.ts comment <ref> "列表要按截止日期排序"
node src/main.ts budget <ref> 40        # 调高预算；因预算停下的会自动继续
```

本地看板的目录（`~/.hivemind/board/`）也可以直接用编辑器看：`<ref>/approvals/` 下是待批准的内容，`questions/` 是问题，
`reports/` 是交付与停下的报告，`status.json` 是当前状态。回答问题就是写一条评论。

## 6. 出了状况

| 现象 | 看哪里 | 怎么办 |
|---|---|---|
| 状态"模型都不可用，需要有人处理凭据或额度" | `node src/main.ts providers` | 修好凭据（重新 `/login` 或换密钥）或额度后 `providers reset <provider>`；需求每 10 分钟自己再试 |
| 需求停下（没有进展） | `status <ref>` 的停止原因与最后的发现；`<ref>/reports/` | 评论告诉它该怎么做，它带着意见继续，尝试次数归还 |
| 需求停下（预算） | `status <ref>` | `budget <ref> <新上限>` |
| 验收一直判不了 | `<ref>/questions/` | 多半是场景的前提在产品里造不出来：评论说明怎么准备数据，或者让它改场景 |
| 启动时报库的迁移不存在 | — | 预发布期间迁移会被原地改写：删掉库文件重来 |

## 7. Notion 看板

在实例配置里把 `board.kind` 改成 `notion`，并把 integration 的令牌写进 secrets（默认名 `NOTION_TOKEN`）。
需求数据源需要：标题属性、「目标仓库」单选（值是实例配置里的仓库名）、系统专用的状态单选（为空表示新提交）；
可选的「流程」单选与「状态说明」文本在 `config/messages.yaml` 或实例配置 `board.properties` 里命名后才会读写。
状态属性只能由系统写：人改了它，下一次写入会改回来。旧系统用过的数据源要先核对属性含义再接入。
