# hivemind

24x7 自主编码 agent 服务：自动从 Notion 看板接取需求，分析拆解后以 TDD 驱动开发，覆盖单测/集成/snapshot/e2e/UI 五层测试，交付 MR 并将业务语言的验证报告回写 Notion。人几乎不写代码，Notion 是唯一的人机交互与内容归档空间。

- 执行底座：[pi](https://github.com/earendil-works/pi)（provider 无关，day1 供应商：Codex / GLM / Grok，预留 Claude）
- 编排拓扑：中心 orchestrator（Linux, systemd）+ 多机 worker（Mac mini / Windows），编排式流水线 + 解耦并行（CODE 按 footprint 并行、E2E 持续回归 loop）
- 血统：busybee（作者的上一代 agent 服务，私有仓库）的下一代独立系统，移植其约 60% 已验证的 harness 基础设施与全部生产教训

## 设计文档

| 文档 | 内容 |
|---|---|
| [docs/design/00-overview.md](docs/design/00-overview.md) | 总览：背景、决策、总体架构、路线图、风险与 PoC 清单 |
| [docs/design/01-notion-integration.md](docs/design/01-notion-integration.md) | Notion 信息架构与集成层：双 DB + 页内区段、读写协议、人操作语义、故障降级 |
| [docs/design/02-distributed-execution.md](docs/design/02-distributed-execution.md) | 分布式执行层：多机队列、pi 运行器、守卫审计、模型分层与 failover、部署自更新 |
| [docs/design/03-pipeline-quality.md](docs/design/03-pipeline-quality.md) | 流水线与质量闭环：两层状态机、并行调度、TDD 契约、E2E 回归 loop、反馈自迭代 |
| [docs/design/04-observability.md](docs/design/04-observability.md) | 可观测性与成本账本：事件溯源三层模型、TokenUsage 归一、循环检测、invariants |
| [docs/design/05-web-console.md](docs/design/05-web-console.md) | 内网 Web 控制台：节点健康、动态配置子系统、Prompt 工作台、成本/统计读面 |
| [docs/design/06-codex-oauth.md](docs/design/06-codex-oauth.md) | Codex（ChatGPT 订阅 OAuth）集成机制：登录/刷新/多机分发/失效告警 |
| [docs/plan/tasks.md](docs/plan/tasks.md) | 实施任务清单：M0–M5 全量任务拆解，每项含输出物与验证方式 |
| [AGENTS.md](AGENTS.md) | 面向 agent 的仓库工作约定：架构不变量、pi 运行器铁律、代码风格、移植 checklist（`CLAUDE.md` 为其符号链接） |

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
  console/        内网 Web 控制台(Vue3 SPA + REST): 节点健康/动态配置/prompt 工作台/成本统计
  verify/ report/ memory/ observability/ alert/ persistence/ config/ util/   busybee 移植为主
prompts/          基线层 + per-phase prompt(独立文件)
extensions/       pi extensions(hive-guard / mcp-adapter vendor / model-policy 兜底)
```

## 状态

设计冻结于 2026-08-22。当前进度：

- **M0 地基 PoC**：14/16 结案（PoC-1 Windows 与 C5 Mac mini 因目标机未组网顺延至 M3）。执行记录与逐项 go/no-go 见 [docs/poc/](docs/poc/)，产出 6 项设计修订与 2 项新增高影响约束。
- **M1 单机闭环**：8/37 进行中（工程骨架、中央 schema、config 子系统、租约 CAS、pi 运行器全套已落地）。

任务级拆解与验收判据见 [docs/plan/tasks.md](docs/plan/tasks.md)。
