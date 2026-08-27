# 分布式执行层与 pi 底座适配设计

> 一句话版：中心 orchestrator（Linux/systemd）只做卡级调度与全局策略；每台机器一个胖 worker daemon，领卡后在本机跑完整个 phase 状态机；pi 以 `--mode rpc` 子进程每 phase 一次 run，跨 phase 用全量 prompt 注入的无状态延续；守卫走 pi extension 的 tool_call block；模型三档 + purpose 白名单强制；failover 以 phase 级重入为主。

## 1. 多机拓扑与任务分发

### 1.1 拓扑

- **Redis 与中央 libsql 都放 Linux 主机**（与 orchestrator 同机，消除一跳网络故障域）。三台机器 Tailscale 组网 + Redis requirepass。
- 任务/phase/事件/成本在中央 libsql；worker 本地只留 scratch（worktree、pi session 文件、evidence 暂存后经 orchestrator HTTP 端点上传）。
- **租约上移**：busybee LeaseService 的 CAS 条件更新语义（`INSERT ... ON CONFLICT DO UPDATE ... WHERE owner=self OR expired`）原样搬到中央 libsql，即为跨机安全的分布式租约；worker 经 orchestrator API 在 phase 边界续租。**不引 Redlock**——卡所有权已有单一数据库仲裁。

### 1.2 分发机制：BullMQ over Redis（验证通过），但废除两条 busybee 单机不变量

BullMQ worker 本质是 Redis 客户端，跨主机是原生场景。必须改造：

1. **obliterate/StartupRecovery 上移 orchestrator 独占**（busybee 的"一个 prefix 一个进程，启动清空队列安全"在多机下会互删 job）；worker 启动只回扫自己的本地 worktree 孤儿。
2. **capability 路由用按能力命名的 queue，不用 job 属性过滤**（BullMQ 无服务端筛选，"拉了不匹配再放回"正撞 requeue 深坑）。队列集合：`cap.web` / `cap.browser-e2e` / `cap.ios`（未来）/ `cap.windows`。**路由键 = 卡需求能力集合中的最稀缺能力**（需要 web+browser-e2e 的卡直接进 cap.browser-e2e——Mac mini 本身具备 web 能力），避免组合队列爆炸。目标队列无存活 worker → "能力真空"告警而非让 job 沉底。

jobId 幂等规则（`task-<cardId>[-r<N>][-c<M>]`）、removeOnComplete:true、TaskInFlightError 语义全部原样移植——踩坑换来的，不重新发明。

### 1.3 job 粒度：整卡 + 主机粘性 + 派单信封

**分发单位是"卡"不是"phase"，同卡全程同机**：

- worktree、pi Context 快照、构建缓存全在本地盘；VERIFY 依赖 CODE 刚构建出的环境状态，跨机重建成本 > 任何并行收益；跨机传 WIP（untracked/.env/构建产物）失败模式一堆；phase 级分发把 orchestrator↔worker 交互放大一个量级，每次都是分布式故障面。
- **胖 worker**：phase 状态机代码以库形式在 worker 进程内执行；orchestrator 保留控制面——收 phase.enter/exit/escalation 事件写中央 EventLog、执行 escalation 决策、Notion 同步、成本账本。状态转移规则是同一份代码，只是执行位置贴着数据。
- **派单信封模式**（驯服 BullMQ stalled 自动重派与粘性租约的冲突）：cap.* 队列的 job 只是"派单信封"——worker 领单后立即在中央 DB 落卡级租约并 ack 完成 job；执行进度不由 BullMQ job 生命周期承载，靠中央 DB phase checkpoint。stalled/重试只影响"派单"这个瞬时幂等动作，绝不会把执行中的卡重派给没有 worktree 的机器。
- **跨平台验证不破坏粘性**：建模为独立"探针 job"（如 web 卡需要 Windows 浏览器兼容检查）——投 cap.windows，对**已 push 分支**只读 clone + 跑 e2e + 回传证据，绝不触碰主 worktree。

### 1.4 worker daemon 与失联语义

每机一个 Node daemon，注册时声明 hostId、能力标签、并发度（建议 1；Mac mini 跑 e2e 时并发 2 会互抢浏览器）、hivemind/pi/协议版本。

- **心跳**：Redis `SETEX hm:worker:<hostId>`（TTL 15s，每 5s 刷），payload 带能力/版本三元组/当前卡/**内网 IP 与机器指标（loadavg/内存/磁盘余量）/凭据探针结果**（供 Web 控制台节点健康页，05 文档 §5）；心跳响应 piggyback `configVersion` 实现动态配置分发（每次心跳重申期望态，漏事件可自愈——busybee RemoteControl 教训）。
- **失联两段式**：断 45s → offline 告警不打断（沿用"静默检测而非时长上限"哲学）；断 >30min（覆盖重启/更新窗口）→ orchestrator 撤销主机租约，卡带 freshWorktree 标记重投 capability 队列，当前 phase 从头重入（全量注入模式使跨机重建廉价，见 §2.3）；孤儿 worktree 等主机回归后本地回扫 quarantine。EventLog/证据都在中央，记录无损失。
- worker 带同 hostId 回归 → 本地 StartupRecovery：从中央 DB 回扫属于本机的 in-flight 卡 → 从 phase checkpoint 重入（worktree 还在本地盘，恢复廉价）。

### 1.5 Windows 兼容（已核实，真实问题）

pi 在 Windows 有安装失败史（#4399）、npm spawn ENOENT 回归（#4665）、假设 shell 有 unzip/tar（#1348，官方 workaround 是 Git Bash）。缓解：

- **Windows worker day1 定位二等公民**：只承接 cap.windows 探针 job，不承接 CODE；
- daemon spawn pi 强制 Git Bash 环境（PATH 注入 Git for Windows usr/bin）；pi 版本在 Windows 单独冒烟后 pin；
- git 侧：core.longpaths=true、autocrlf=false + 目标仓 .gitattributes；
- **danger-rules 的 Windows 路径漏洞必须修**：FENCED_PATTERNS 以 `/` 写死，Windows 反斜杠会漏——先 path.normalize 再统一 posix 分隔符后匹配（~3 行 + Windows 专项单测）；
- PoC-1 不过则 Windows 降级为"纯 Playwright 探针执行器"（不跑 pi，daemon 直接跑 e2e 脚本）——架构已预留探针 job 抽象。

## 2. pi 运行器

### 2.1 嵌入形态：`--mode rpc` 子进程（唯一推荐）

1. **协议面比 API 面稳**：pi pre-1.0 SDK 明说不稳；JSON-RPC 消息形状演进慢得多，可用录制 fixture 契约测试锁住，升版只回放验证。
2. **进程隔离即中止语义**：kill 进程组（detached + SIGTERM→10s→SIGKILL）；pi 崩溃不拖垮 daemon；多卡并发时每卡独立 pi 进程互不污染。
3. **RPC 双向通道**支撑两个刚需：mid-run 人工纠偏注入（phase 运行中把人的备注推进对话）与优雅 abort。`pi -p`/`--mode json` 是发射后不管。
4. extension 与嵌入方式正交（守卫/模型策略/成本采集都活在 pi 进程内 extension），SDK 的"直接挂 hook"优势不成立。

`PiRunner` port 接口（仿 busybee AGENT_QUERY seam）+ RPC adapter + 测试罐头流 fake；RPC 踩坑则退 `--mode json`（纠偏降级为 phase 边界注入）只换 adapter。pin exact 版本装 `~/.hivemind/pi/<version>/` 并排目录，统一灰度升级。

### 2.2 每 phase 一次 run 的生命周期

```
preparePhase: 组装 prompt(phase 模板 + 前序 phase 结构化产物 + memory 注入 + midflight notes + 附件)
              生成 run-config.json(phase/worktree/extraWriteRoots/disallowedTools/模型档位/审计路径)
spawn:        pi --mode rpc, cwd=worktree, --system-prompt <phase 基线文件>
              env HIVE_GUARD_POLICY 指向 run-config; extension 目录挂 hive-guard / mcp-adapter
consume:      事件流 → tee 本地 run-events.jsonl(append-only 原子写)
              → 喂投影(trace/cost/stats) → 喂 StallWatchdog lastActivityAt
              → 每 assistant turn 结束: Context JSON checkpoint(§2.4)
finalize:     终态 → finalText 结构化解析(复用 verify-parse/mr-parse 模式) → cost flush → 进程组清收
```

StallWatchdog 原样移植：静默检测而非时长上限，信号源换成 RPC 事件流即可。

### 2.3 跨 phase 上下文延续：无状态全量注入（不做 session fork）

- busybee 教训直接平移（跨仓 fork 失败 #247；MR-plan 的全量注入模式反而稳）：phase prompt 自包含，注入前序 phase 的**结构化产物**（分析文档/DoD/验证证据摘要），不注入原始对话。
- pi 下更成立：session 文件在本地盘（破坏可移植性）+ JSONL 尾部损坏 bug；且无状态模式是**跨机 fresh 重建（§1.4）与跨供应商 failover（§5）的共同前提**——三件事共享同一机制，本设计中杠杆率最高的一条决策。
- session 文件保留但降级为审计/trace 原料，不承载执行语义。

### 2.4 耐久性：不依赖 pi session JSONL

- 每 assistant turn 结束经 RPC 拉当前 Context（纯 JSON）→ 原子写（临时文件+rename）+ SHA-256 校验，保留最近 N 份；
- pi 进程死后恢复 = 最后一份好快照起新 run 续跑（与跨供应商 failover 同一条代码路径，一次投资两处收益）；
- 兜底：快照不可用 → 重跑整 phase（prompt 自包含损失有界）；
- resume 前跑 JSONL 校验器：逐行 parse，尾部坏行截断到最后一个完整消息边界（损坏特征是尾部，截尾即修复）；每 phase 结束把 session 复制为不可变 checkpoint 进 EvidenceStore。
- **PoC-2 已完成（2026-08-27，见 docs/poc/poc-2-context.md）**：导出面存在（RPC `get_messages`），但**没有任何 RPC 命令可以把 Context 灌回会话**——载入面只有 session 文件（`--session` / `--session-id` / `--fork` / `--clone`）。因此 checkpoint **必须保留可被 pi 直接加载的 session JSONL**，不能只存消息数组。往返等价、跨进程 resume、`steer` 中途注入、`abort` 后进程可复用均实测通过。
- Context 等价比对须先剥离每次运行必然不同的易变字段：`id / parentId / timestamp / sessionId / requestId / durationMs / usage / cost / api`。
- `steer` 仅在"当前回合的工具调用执行完、下一次 LLM 调用之前"投递：**回合内没有工具调用就等同于 follow_up**。故纯文本阶段（如 MR 文案）不可中途纠偏，只能整段重跑。

### 2.5 断线 continue-retry

RPC 下 pi 进程活着 session 就在内存：检测到流中断类终态错误 → 同一活 session 再发 "continue"，预算沿用 MAX_CONTINUE_RETRIES=8（宽松到网络真死才放弃）。错误模式表按 pi/各 provider 实测重建（busybee 那套是 Claude Code 专属文案不能照抄；优先消费 RPC 结构化错误事件——PoC-5）。

## 3. 守卫与审计

### 3.1 hive-guard extension

- danger-rules 纯函数（checkBash/checkFilePath）**原样移植**，仅两处修订：Windows 路径 normalize（§1.5）+ gh 侧红线增补（gh pr merge / gh workflow run 对齐 glab 红线）。
- 启动读 HIVE_GUARD_POLICY 指向的 run-config（phase/worktree/extraWriteRoots/disallowedTools/fencedPatterns/bannedBash），每次 spawn 由 runner 按 phase 注入；
- tool_call hook：工具名命中 disallowedTools → 无条件 block；bash 类 → checkBash；写文件类 → checkFilePath（fenced 优先于白名单、`../` 先 resolve 再比前缀的防逃逸保持不变）；**deny 带 reason**（让模型调整策略而非死磕）；红线无条件（rm -rf / push main / force push），VERIFY 的宽工具面也拦；**MCP 工具调用同样过 tool_call hook 纳入 guard**。

### 3.2 审计双通道

1. 主通道：runner 消费 RPC 事件流全部 tool 事件（含被 block 的）写中央 EventLog（append-only，审计 source of truth）；
2. 副通道：extension 自己往 `$EVIDENCE_DIR/tool-audit.jsonl` 追加（含 deny 决策与原因，payload 截断 500 字符）——runner 与 pi 之间管道出问题时的本地铁证。

### 3.3 VERIFY 物理禁写

真正的文件系统只读不可行（build/test 要写 node_modules/dist/缓存），三层界定：

1. **主控**：disallowedTools 全列写/编辑类工具 + bash 写模式启发式（重定向/sed -i/tee，承认枚举不完备所以有第 2 层）；extraWriteRoots 只留证据目录；若 pi 支持 per-run 工具注册裁剪（PoC-3），更进一步——不存在的工具比被拦的工具更"物理"；
2. **侦测**：CODE 结束 VERIFY 开始前记 tree-pin 指纹（busybee 现成资产），VERIFY 结束后比对，失配 → quarantine + verdict 作废；
3. evidence（截图等）经 extraWriteRoots 白名单落卡片证据目录，不污染 diff。

### 3.4 per-phase 工具矩阵

| Phase | 允许 | 禁止 |
|---|---|---|
| ANALYZE/DECOMPOSE | read/grep/glob/bash（受红线） | 全部写/编辑、git push |
| CODE | 全量（受红线+fenced+worktree 边界） | — |
| VERIFY / E2E runner | read/grep/bash（构建测试）、browser 工具 | 全部写/编辑（除证据目录）、git push、file:// 导航 |
| MR | git/gh CLI、read | 写/编辑源码 |
| DISTILL/REPORT | read | 一切写（产出经 runner 落中央存储） |

## 4. system prompt 与目标仓资产装载

### 4.1 自建两层 prompt 追加在 pi 默认之上

**2026-08-27 实测修订**（原为"完全替换"，见 docs/poc/poc-4-prompt-ab.md）：pi 默认 prompt 实测
8,062 字符 ≈ 2.3k token（单条 system 消息），内容几乎全是**自家工具的正确用法**
（用 bash 做 ls/rg/find、用 read 而非 cat、edit 的 oldText 必须精确匹配且不得重叠嵌套等）；
它**不含**任何角色契约、验证纪律、证据规范。换掉它会让模型用错 pi 的 edit 工具。

两者是互补而非竞争：默认段落管"怎么用 pi 的工具"，自建层管"hivemind 的工程纪律"。
故用 `--append-system-prompt`（可多次，接受文本或文件）叠加，`--system-prompt` 完全替换
降级为备选，仅在实测证明默认段落有害时启用。加上工具 schema ≈0.83k token，
每请求固定开销 ≈3.1k token，计入 04 文档的 Token effect 账。自建：

- **基线层**（全 phase 共享）：工具纪律、验证优先于声称、证据引用规范、禁止猜测、遵守 CLAUDE.md/rules 的元指令；
- **phase 层**：角色、输入契约（注入的上文 artifact 结构）、输出契约（机器可解析结构化产出）；
- **per-provider 风格微调段**：GPT-5.x-codex 系与 GLM 系对停止条件/主动性措辞响应差异显著，需 provider 变体开关。
- 起点大量借鉴 busybee prompts.ts 已打磨的 phase prompt；**PoC-4 用 3–5 张金标卡盲评守门**，对照改为三臂：默认 / 默认+追加 / 完全替换（再对比 provider 变体）。

### 4.2 CLAUDE.md / skills 层叠（pi 原生，零自研）

- **全局层**：worktree 统一在 `~/hivemind-work/worktrees/<repo>/<card>/`，上层 `~/hivemind-work/` 放全局 AGENTS.md（编码基线规范），pi 向上层叠自动生效；由 self-update 分发保持三机一致；
- **目标仓层**：repo 自己的 CLAUDE.md/.claude/rules 随 worktree 天然存在，且在 FENCED_PATTERNS 内 agent 改不了自己的规则；
- **skills**：pi 原生支持 agentskills.io 规范，直接挂现有 ~/.claude/skills 目录，技能库零迁移。per-phase 技能可见性粒度待核实（无则全量可见 + prompt 约束）。

### 4.3 浏览器自动化（无 MCP 的 pi）

生态已核实有现成件：pi-mcp-extension（pi.dev 官方包索引）、nicobailon/pi-mcp-adapter（单一 proxy tool ~200 token、server 懒连接）、guwidoe/pi-playwright。

**推荐：vendor pi-mcp-adapter + 微软官方 Playwright MCP**——token 面干净、MCP 是通用接缝（未来 iOS 自动化的 appium/XCUITest MCP server 走同一通道）、Playwright MCP 微软维护省长期负担。社区 extension 存续性不可赌 → fork 进仓 pin 死并审计其工具面。备胎：defineTool 手写 5 个最小 Playwright 工具（navigate/snapshot/click/fill/screenshot，~2 天）。iOS e2e 不走 MCP：XCUITest/simctl 走 bash + skills。

## 5. 模型分层与跨供应商 failover

### 5.1 三档抽象与 per-provider 映射

见 00-overview 决策与 03-pipeline 角色表。三档：**大脑**（重决策：拆解/根因/反思提案）/ **中脑**（执行：CODE/VERIFY/DESIGN/E2E）/ **小脑**（机械：triage/completion verifier/distiller/compaction/文案）。

| 档位 | openai-codex（day1 主力） | zai GLM | xai Grok | anthropic（预留） |
|---|---|---|---|---|
| 大脑 | gpt-5.x-codex · high | GLM 旗舰高思考档 | grok 旗舰 | opus |
| 中脑 | gpt-5.x-codex · medium | GLM 旗舰常规档 | grok-code | sonnet |
| 小脑 | gpt-5.x-mini | GLM 轻量档 | grok-code-fast | haiku |

**day1 配额调度策略**：大脑/中脑 → Codex（订阅制成本风险有限）；**小脑高频调用全部挪到 GLM/Grok 低成本档**——保护 ChatGPT 订阅时间窗配额留给重决策。具体 model ID 写配置不写代码（型号迭代快）。

### 5.2 enforceModelPolicy（cumora 移植，双 chokepoint）

- `resolveModel(purpose): {tier, provider, modelId}` 是所有 pi run model 参数的**唯一入口**；purpose → 最高允许档位白名单；超档请求强制降级 + P0 告警（fire-and-forget 不阻塞）。
- extension 侧 before_provider_request hook 兜底：payload.model 越级则改写强制降档 + 违规事件——兜住 run 内部漂移（skill/意外切换）。cumora 只有单点，pi 的 hook 给了纵深。

### 5.3 跨供应商 failover（phase 级重入为主，Context 重放为辅）

failover 链按档位横移：codex → GLM → grok。

| 类别 | 政策 | 理由 |
|---|---|---|
| 小脑单次调用（triage/distill/摘要/compaction） | 直接换 model 重发同一 prompt，立即切 | 无状态、廉价、结构化 |
| ANALYZE/REPORT 类 | 允许中途 Context 重放切换（thinking 降级为文本损伤小）；进度 <30% 改整 phase 重跑 | 只读叙事型工作 |
| CODE | 先 defer 后切换：rate_limited 且 retryAfter ≤15min → 延迟重投等 Codex 窗口；>15min 或连续 2 次 defer 仍不可用 → 整 phase 重跑于 fallback，**不中途混模** | 中途换模型 = 风格/隐式计划断裂；thinking 降级正好丢实现思路 |
| VERIFY | 单模型出单一判定；failover = 换供应商从头重跑整个 VERIFY | 判定一致性不能拼合；VERIFY 幂等且相对便宜 |

Context 跨供应商重放仅作为优化项后置（PoC-6 验证 codex→GLM 转换实际质量再决定启用）。

### 5.4 per-provider 熔断矩阵

busybee CredentialHealth 从全局单一扩展为 per-provider 三态机（closed/open/half-open）：

- 探针分两层：凭据层用 `pi auth check --provider <p> --json --no-refresh`（只读零副作用、不消耗 refresh token，06 文档 §6）；容量层经 pi 发一次小脑档最小补全（近零成本），half-open 探活通过则闭合；
- 错误分类优先消费 RPC 结构化错误事件（PoC-5，不带则退回按 provider 录制的文案正则）；区分"凭据死了（要人）"与"容量限了（等窗口）"，处置沿用 escalation-policy 的 delay/circuit_break 分流；
- 某 provider open → 新 run 按档位表横移 fallback 列；**三家全开才触发全局 intake 暂停**——单 provider 故障不再停摆全系统，多供应商的核心红利。

## 6. 部署与自更新

### 6.1 三平台进程管理

| 平台 | 方案 | 关键点 |
|---|---|---|
| Linux | systemd（orchestrator.service + worker.service 分 unit） | Restart=always；Redis 同机 systemd 管理；分开 drain |
| Mac mini | **LaunchAgent（用户会话）而非 LaunchDaemon** | 模拟器/浏览器 e2e 需要 GUI 会话；开机自动登录 + KeepAlive + caffeinate 防休眠；busybee launchd PATH 坑已知（幂等生成 plist 重写 PATH） |
| Windows | **自动登录用户的登录计划任务 + 看门狗任务**（不用 nssm 服务） | Session 0 隔离会弄死有头浏览器 e2e；nssm 仅在确认全程 headless 时可选 |

relaunch 统一抽象为 `process.exit(1)` + 守护器拉起——KeepAlive / Restart=always / 计划任务重触发行为同构，平台差异被守护器吸收。

### 6.2 self-update 滚动升级

busybee 骨架（drain→pull→deps→build→migrate→relaunch + build-info SHA handshake 防"重启未生效"）保留，改造：

- orchestrator 经配置下发目标版本；worker **空闲时**自查 → 自 drain（只 drain 自己的活）→ 升级 → handshake 上报 (hostId, sha)；
- **逐台滚动**：先 canary 一台 worker → 冒烟通过 → 其余分批 → orchestrator 自身最后；
- **版本握手进领卡协议**：worker 注册携带 {hivemindVersion, protocolVersion, piVersion}，protocol 不匹配拒绝领卡（滚更期间新旧共存的安全阀）；
- **pi 版本纳入同一机制**：与 hivemind 同一 drain 窗口升级，附三平台冒烟（Windows 必测）。
