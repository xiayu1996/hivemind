# PoC 脚本

M0 地基验证用。结论文档在 `docs/poc/`。

## rpc-context/

无需真实供应商凭据即可跑 pi 的 RPC 面：mock provider 以 extension 形式注册，
脚本化确定性回复让"上下文是否真被带上"成为可判定命题，并可注入七类故障。

```bash
# 终端 A
node poc/rpc-context/mock-provider-server.mjs --port 8099
# 需要错误注入时加: MOCK_FAULT_FILE=/tmp/fault.txt

# 终端 B
node poc/rpc-context/poc-2a-context-roundtrip.mjs     # Context 往返
node poc/rpc-context/poc-2b-inject-abort.mjs          # steer / abort / resume
MOCK_FAULT_FILE=/tmp/fault.txt node poc/rpc-context/poc-5-error-catalog.mjs
```

`rpc-client.mjs` 是协议合规的 RPC 客户端（只按 LF 分帧，剥离结尾 `\r`，
不用 Node `readline`——它会在 JSON 字符串内合法的 U+2028/U+2029 处误切）。M1 的 PiRunner 以此为起点。

## codex-oauth/

`usage-limit-parser.mjs` + 单测。模板由 pi 二进制反推，非猜测。

```bash
node poc/codex-oauth/usage-limit-parser.test.mjs
```
