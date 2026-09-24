# PoC-2：RPC Context 导出/载入与 mid-run 控制

> 执行日期 2026-08-27 · pi 0.84.3 · macOS 26.5.1 (arm64) · 结论：**PASS（含一项设计修订）**

## 为什么不用真实供应商跑

本机无任何 provider 凭据，且 Codex OAuth 登录属 M0-01 未决策项。改用自建 mock provider
（`poc/rpc-context/mock-provider-server.mjs` + `mock-provider-extension.mjs`）：OpenAI-completions 兼容、
脚本化确定性回复、可注入七类故障。pi 通过 extension 的 `registerProvider` 挂载，无需改 pi 本体。

**这带来一个额外收益**：mock 让"Context 往返是否等价"成为可判定命题——真实模型每次回复都不同，
无法区分"上下文丢了"与"模型换了个说法"；脚本化回复按 assistant 计数返回 ACK-1/2/3，
重载后若续答 ACK-3 就证明历史真被带上了。

## 判据与结果

| 面 | 机制 | 结果 |
|---|---|---|
| 导出 | RPC `get_messages` → AgentMessage[] | PASS，4 条消息 |
| 载入 | **session JSONL 文件 + `--session <path>`** | PASS，重载后 4 条消息 |
| 往返等价 | 剥离易变字段后 canonical JSON 全等 | PASS，diff 为空 |
| 历史真被带上 | 重载进程续跑返回 ACK-3（第三条脚本回复） | PASS |
| mid-run 注入 | RPC `steer` | PASS，进入会话且工具照常执行 |
| abort | RPC `abort` | PASS |
| abort 后进程可复用 | 同进程再发 prompt | PASS（进程存活，无需重建） |
| 跨进程恢复 | 另起进程 `--session` 同一文件 | PASS，历史完整 |

复现：`node poc/rpc-context/poc-2a-context-roundtrip.mjs` / `poc-2b-inject-abort.mjs`（需先起 mock server）。

## 设计修订：没有"载入 Context"的 RPC 命令

RPC 提供了导出面（`get_messages`），但**没有任何命令可以把 Context 灌回一个运行中的会话**。
可用的载入面只有 session 文件（`--session` / `--session-id` / `--fork` / `--clone`）。

对 02 文档的影响：

- **崩溃恢复**：checkpoint 不能只存 `get_messages` 的产物，必须同时保留可被 pi 直接加载的
  session JSONL（或具备把 AgentMessage[] 回写成合法 v3 JSONL 的能力）。前者简单可靠，采用前者。
- **跨机重建 / 跨供应商 failover**：本来就走"无状态全量注入"（不依赖 session 续跑），不受影响。
  这反而进一步证明该决策的杠杆率——它绕开了 pi 唯一缺失的能力面。
- **易变字段**：`id / parentId / timestamp / sessionId / requestId / durationMs / usage / cost / api`
  每次运行必然不同，任何"Context 等价"判定都必须先剥离它们（见脚本 `VOLATILE`）。

## steer 的真实投递时机

`steer` 只在"当前回合的工具调用执行完、下一次 LLM 调用之前"投递。若一个回合没有工具调用
（纯文本回答），steer 实际等同于 follow_up。纠偏能力因此依赖于**回合内有工具调用**——
CODE/VERIFY 这类重工具阶段可纠偏，纯文本阶段（如 MR 文案生成）不可中途纠偏，只能整段重跑。
