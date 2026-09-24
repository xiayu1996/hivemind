# hivemind

7x24 自主交付服务。它从看板接一条需求，写成产品契约、技术方案与构建计划请人确认，
然后在一条集成分支上一项一项地测试先行实现；每一项都由一个看不到构建过程的独立评审，
在真实运行的产品上、用真实浏览器对着契约验收，通过才落地。全部做完再整体终审，推送并开 PR，交给人做交付验收。

```
需求 ─> 定义产品 ─(人批准)─> 界面设计 ─> 技术方案 ─(人批准)─> 计划 ─> 逐项：构建 → 检查 → 验收 ─> 终审 ─(人验收)─> 交付
                                                                        ↑____ 失败的发现回到同一会话 ____|
```

## 快速开始

```sh
npm ci
npx playwright install chromium
npx pi                                  # 订阅型 provider 在这里 /login 一次
node src/main.ts preflight --probe      # 配置、凭据、仓库、浏览器、每个模型都通一遍
node src/main.ts submit --repo demo --title "任务看板" --body-file req.md
node src/main.ts run
```

实例配置写在 `~/.hivemind/config.yaml`（仓库、看板、预算），密钥写在 `~/.hivemind/secrets.env`（chmod 600）。
完整步骤见 [docs/runbook.md](docs/runbook.md)。

## 文档

- [docs/design/00-overview.md](docs/design/00-overview.md)：架构与主循环
- [docs/runbook.md](docs/runbook.md)：配置、运行、日常操作、排障
- [docs/legacy-knowledge.md](docs/legacy-knowledge.md)：从旧系统带过来的代码与实测结论
- [AGENTS.md](AGENTS.md)：在这个仓库里工作的规则

## 许可

MIT
