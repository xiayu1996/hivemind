# PoC-5：RPC 错误事件目录与分类规则

> 执行日期 2026-08-27 · pi 0.84.3 · 结论：**PASS**

## 单一提取契约（最重要的结论）

pi 把**所有** provider 失败归一到同一个位置：assistant 消息的 `stopReason === "error"` +
`errorMessage`（字符串）。同一条消息在 `message_start` / `message_end` / `turn_end` / `agent_end`
四个事件里重复出现，因此 runner 只需一条提取规则：

```
遍历事件 → 取 message（及 agent_end.messages[]）→ stopReason === "error" → 读 errorMessage
agent_end.willRetry 表明 pi 自己是否还打算重试
```

没有独立的 `error` 事件类型；`extension_error` 只对应扩展抛错，与 provider 无关。

## 采集样本

自动重试先经 RPC `set_auto_retry {enabled:false}` 关闭，否则错误会被 pi 自身重试循环掩盖
（这也从实现侧印证了设计里 `retry.provider.maxRetries: 0` 的必要性——重试策略必须由 hivemind 独占）。

| 注入故障 | errorMessage 形态 | 归类 |
|---|---|---|
| 401 invalid_api_key | `401: {"message":"Incorrect API key provided...","code":"invalid_api_key"}` | AUTH |
| 429 rate_limit_exceeded | `429: {"message":"Rate limit reached for ... try again in 20s.","code":"rate_limit_exceeded"}` | RATE_LIMIT |
| 429 insufficient_quota | `429: {"message":"You exceeded your current quota...","code":"insufficient_quota"}` | QUOTA |
| 500 server_error | `500: {"message":"The server had an error...","type":"server_error"}` | SERVER |
| 400 invalid_value | `400: {"message":"Invalid value for 'messages[0].role'...","code":"invalid_value"}` | INVALID_REQUEST |
| socket 直接断开 | `Connection error.` | TRANSPORT |
| 流中途断开 | `Connection error.` | TRANSPORT |

样本落在 `fixtures/rpc-errors/*.json`（完整事件流 + 响应 + stderr），供 PiRunner 契约测试回放。

## 分类规则必须有优先级顺序

7/7 样本按预期归类，但 **quota 样本同时命中 QUOTA 与 RATE_LIMIT**（它既是 429 又是配额耗尽）。
因此分类器不能用"任意匹配"，必须**首个命中优先**且顺序固定：

```
QUOTA → AUTH → RATE_LIMIT → INVALID_REQUEST → SERVER → TRANSPORT
```

QUOTA 必须排在 RATE_LIMIT 之前——两者恢复路径完全不同（QUOTA 要人换凭据/加额度，
RATE_LIMIT 只需等窗口）。顺序写反会让配额耗尽被当成限流无限等待，即 cumora 的空转故障。

## 尚未覆盖

各家真实供应商的错误文案与此处的 OpenAI 兼容形态可能不同（尤其 GLM/Grok 的中文或自定义
错误体）。拿到凭据后需对每家补一轮真实样本进 `fixtures/rpc-errors/<provider>/`，
分类规则以样本驱动增补，不靠猜测。
