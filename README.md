# hivemind

24x7 自主编码 agent 服务：自动从 Notion 看板接取需求，分析拆解后以 TDD 驱动开发，覆盖单测/集成/snapshot/e2e/UI 五层测试，交付 MR 并将业务语言的验证报告回写 Notion。人几乎不写代码，Notion 是唯一的人机交互与内容归档空间。

- 执行底座：[pi](https://github.com/earendil-works/pi)（provider 无关，day1 供应商：Codex / GLM / Grok，预留 Claude）
- 编排拓扑：中心 orchestrator（Linux, systemd）+ 多机 worker（Mac mini / Windows），编排式流水线 + 解耦并行（CODE 按 footprint 并行、E2E 持续回归 loop）
- 血统：[busybee](../busybee) 的下一代独立系统，移植其约 60% 已验证的 harness 基础设施与全部生产教训

## 设计文档

| 文档 | 内容 |
|---|---|
| [docs/design/00-overview.md](docs/design/00-overview.md) | 总览：背景、决策、总体架构、路线图、风险与 PoC 清单 |
| [docs/design/01-notion-integration.md](docs/design/01-notion-integration.md) | Notion 信息架构与集成层：双 DB + 页内区段、读写协议、人操作语义、故障降级 |
| [docs/design/02-distributed-execution.md](docs/design/02-distributed-execution.md) | 分布式执行层：多机队列、pi 运行器、守卫审计、模型分层与 failover、部署自更新 |
| [docs/design/03-pipeline-quality.md](docs/design/03-pipeline-quality.md) | 流水线与质量闭环：两层状态机、并行调度、TDD 契约、E2E 回归 loop、反馈自迭代 |
| [docs/design/04-observability.md](docs/design/04-observability.md) | 可观测性与成本账本：事件溯源三层模型、TokenUsage 归一、循环检测、invariants |

## 目录结构

```
src/
  orchestrator/   状态机(Epic/Story 两层) + intake + 调度纯函数(拓扑/footprint/hotspot)
  notion/         gateway(令牌桶+优先级+outbox) / sync(水位) / blocks(页面 builder) / intent-interpreter
  runner/         PiRunner port + rpc adapter + context-checkpoint + continue-retry
  guard/          danger-rules(移植) + per-phase policy 组装
  queue/          BullMQ 封装(busybee 移植 + 多机化改造)
  worker/         worker daemon: 心跳/能力声明/粘性恢复/探针 job
  pipeline/       DoD schema / 收敛判据 / verdict 校验 / completion-verifier / 业务语言 lint
  regression/     RegressionScheduler + 场景注册表 + 归因二分 + 失败签名
  vcs/            worktree(移植) + mr(gh 优先, glab 第二)
  verify/ report/ memory/ observability/ alert/ persistence/ config/ util/   busybee 移植为主
prompts/          基线层 + per-phase prompt(独立文件)
extensions/       pi extensions(hive-guard / mcp-adapter vendor / model-policy 兜底)
```

## 状态

设计冻结于 2026-08-22，实施路线 M0（地基 PoC）尚未开始。见 00-overview.md §路线图。
