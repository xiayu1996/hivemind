# Web 控制台与动态配置设计

> 2026-08-25 增补（用户要求：从一开始就提供内网 Web UI，支持展示与动态配置时常变化的东西——agent 节点健康、持续优化的 prompt、token 消耗、session 时长等）。

## 1. 定位与职责边界

两个人机界面各司其职，不互相越界：

| 界面 | 受众视角 | 承载 |
|---|---|---|
| **Notion** | 业务面 | 需求卡、拆解批准、验证报告、needs_input 问答、验收——一切"关于需求"的交互 |
| **Web 控制台** | 运维面（内网） | 节点健康、动态配置、prompt 工作台、成本/用量、运行统计、供应商健康、trace 浏览——一切"关于系统自身"的观测与调参 |

此前设计中散落的读面（状态 API、trace HTML、Bull Board、HTML 报表）全部收拢进控制台，**day1（M1）就提供基础版**。

## 2. 承载与技术形态

- **部署**：orchestrator（Linux）同进程挂载——Fastify 静态托管 SPA + 同一套 REST API；仅内网可达（Tailscale 网段），不暴露公网；可选简单 token 鉴权（单用户场景不引入账号体系）。
- **前端**：Vue 3 + Vite 轻 SPA（与既有项目技术栈一致，维护心智统一）；图表用 ECharts；不引重型 admin 框架。Bull Board 以 iframe/路由挂载复用（队列深度与 job 明细不重造）。
- **数据源**：全部来自中央 libsql 的既有表与投影（cost_entries / EventLog / 投影缓存 / worker 注册表 / config_entries），控制台**只是读面 + 配置写面，不新增执行语义**。

## 3. 页面模块

| 模块 | 内容 | 数据来源 |
|---|---|---|
| **节点健康** | worker 列表：hostId、**内网 IP**、OS/CPU/内存/磁盘余量、能力标签、版本三元组（hivemind/protocol/pi）、心跳状态与最后心跳、当前卡与 phase、并发度；离线/宽限期状态色条 | 心跳 payload（见 §5 扩展）+ worker 注册表 |
| **任务视图** | 活跃卡列表（phase、内环轮次、耗时、成本、收敛曲线缩略）、真停点卡待办、卡详情页 → EventLog 时间线 + trace HTML + 证据目录索引 | EventLog + 投影 |
| **成本/用量** | per 卡/phase/provider/purpose/day 聚合曲线；大脑花费占比、缓存命中率；软护栏阈值与当前水位；Codex 订阅窗口观测（retryAfter 历史） | cost_entries |
| **运行统计** | run/session 时长分布、llmMs/toolMs/ttft/吞吐、内环轮次分布、**闭环流速指标面板**（memory 蒸馏量、footprint 偏差率、triage 流量、双 outbox 深度、429 率……断流告警在此可视化） | stats 投影 |
| **供应商健康** | per-provider 熔断三态、探针历史、错误分类分布（AUTH/QUOTA/RATE_LIMIT/…）、failover 事件流 | CredentialHealth + EventLog |
| **动态配置** | config_entries 的 schema 化编辑（见 §4） | config 子系统 |
| **Prompt 工作台** | prompt 版本管理与灰度（见 §6） | prompt overlay 表 |
| **队列** | Bull Board 复用 | Redis |

## 4. 动态配置子系统

### 4.1 数据模型

```
config_entries(scope_id, key, value_json, version, updated_by, updated_at)
config_history(scope_id, key, version, value_json, diff, updated_by, ts)     -- 全量留痕, 可一键回滚
```

- **schema 即真相**：每个 key 在代码里有 zod schema（busybee env.ts 模式扩展）+ 元信息：`{ scope: global|per-host|per-repo, reload: hot|drain-restart, description }`。非法值在保存时拒绝；控制台表单由 schema 生成，不手写。
- **默认值在代码，覆盖在 DB**：代码内 defaults 是兜底真相（DB 清空系统仍可跑）；config_entries 是 overlay。启动时 merge，运行期热更。`scope_id` 与 key 联合唯一；per-repo 键使用仓库标识作为 scope_id。

### 4.2 day1 纳入动态配置的键（预期时常变化的东西）

| 类别 | 键（示例） | reload |
|---|---|---|
| 重试上限族 | maxInnerLoopRounds / maxPhaseReentries / maxContinueRetries / maxRegressionReopens（见 03 文档 §1.5 修订） | hot |
| 调度 | 轮询周期、活跃集窗口、worker 失联宽限期、并发度 per-host | hot |
| 模型策略 | 三档 × provider 的 model id 映射表、failover 链顺序、purpose→档位白名单 | hot |
| 护栏 | 日/月成本阈值（全局 + per-provider）、单卡成本 p95 倍数告警 | hot |
| 并行调度 | hotspot 文件清单（高冲突路径，随项目演化持续增补；非空仓库相对路径） | hot |
| 守卫 | extraWriteRoots 追加项、e2e host 白名单 | hot（下一次 spawn 生效） |
| 暂停开关 | intake 急停、per-provider 手动摘除、self-update 开关/钉版本 | hot |

### 4.3 分发机制（复用心跳通道，不新增连接）

- worker 心跳请求 → orchestrator 响应 piggyback `configVersion`；
- worker 发现版本变化 → 拉全量 config → 按 reload 元信息应用：`hot` 立即生效；`drain-restart` 标记 pending，空闲 drain 后重启生效；
- **每次心跳都重申期望态而不只在 diff 时**（busybee RemoteControl 教训：漏事件能自愈）；
- 所有 UI 写操作落 EventLog `config.changed` 事件（含 diff 与操作人），审计与告警共用。

## 5. 心跳 payload 扩展（支撑节点健康页）

```ts
{ hostId, intranetIp, os, arch, capabilities[], concurrency,
  versions: { hivemind, protocol, pi },
  machine: { loadavg, memFreeMb, diskFreeGb },   // 新增
  currentCards: [{ cardId, phase, sinceTs }],
  configVersion, credentialProbe: { [provider]: ok|failed|expired } }
```

## 6. Prompt 工作台（"持续优化的 prompt"的承载）

**双层真相**：repo 内 `prompts/` 目录是默认版本（代码评审可控、随部署分发）；DB `prompt_overlay(prompt_key, version, content, status, created_by, source)` 是运行期覆盖层。

```
编辑（UI 手工 / 反思提案被批准） → 新版本(draft)
  → 灰度: 指定某目标仓/某几张卡试跑该版本
  → 对比: 行为回归统计（新旧版本 N trials 通过率置信区间, 03 文档 §6）+ 灰度卡的实际产出
  → 发布(active) / 废弃 —— 任何时刻可一键回滚到任意历史版本
```

- runner 组装 prompt 时按 `prompt_key` 取 active 版本（无 overlay 则用 repo 文件）；**每次 run 记录使用的 prompt 版本号进规范日志**（可观测铁律 Model-visible ⟺ logged 的自然延伸），事后任何行为变化可归因到 prompt 版本。
- **与反思闭环的关系**（修订 03 文档 §4）：反思提案卡仍贴 Notion 保证可见性与讨论，但"应用"动作收敛到 Prompt 工作台执行——提案被人批准后自动生成一个 draft 版本进入上述灰度流程，不再直接走 self-update 改文件。prompt 之外的配置类提案（调度参数/契约条款）同理落到 §4 的 config draft。

## 7. 实施排期修订

- **M1 新增**：控制台骨架（节点健康 + 任务视图 + 成本只读 + config 只读）——与单机闭环同期，因为调 PoC/调 prompt 本身就需要这个读面；
- **M2**：动态配置写面 + 重试上限族接入；
- **M4**：Prompt 工作台完整版（灰度 + 行为回归对比）+ 供应商健康页。

## 8. 风险

| 风险 | 处置 |
|---|---|
| 配置改坏导致系统行为异常 | schema 校验 + 全量历史可回滚 + config.changed 告警；高危键（急停/钉版本）二次确认 |
| prompt 灰度版本与 repo 默认漂移遗忘 | 控制台首页展示"overlay 与 repo 默认的 diff 数"；发布满 N 天的稳定 overlay 提示回沉 repo |
| 控制台成为第二个"真相源" | 铁律：控制台只读投影 + 写 config/prompt overlay 两张表，绝不直写任务状态；任务干预（重投/停靠）走已有 orchestrator API 并留审计 |
