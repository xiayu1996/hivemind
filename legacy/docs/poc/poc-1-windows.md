# PoC-1：pi 在 Windows（Git Bash）的 RPC 稳定性

> 执行日期：2026-08-29<br>
> 环境：Windows 11 x64 · Node 26.8.1 · pi 0.84.3 · Git for Windows bash 5.3.9<br>
> 结论：**PASS，10/10；不启用纯 Playwright 降级路径**

## 方法

用 `scripts/install-pi.ps1` 将固定版本安装到
`~/.hivemind/pi/0.84.3/pi/pi.exe`，校验 release `SHA256SUMS` 后，从 Git Bash 执行：

```sh
export PATH="/d/APP/nvm/v26.8.1:$PATH"
export PI_BIN="C:/Users/Ray/.hivemind/pi/0.84.3/pi/pi.exe"
npx tsx scripts/smoke-windows-rpc.ts
```

脚本连续启动 10 个全新的真实 pi RPC 子进程。每轮均完成 `get_state` 往返握手，
并由本地确定性 mock provider 发起一次真实 bash tool call：输出唯一 marker 与 `uname -s`。
mock 只替代远端模型服务；pi 二进制、RPC 协议、extension/provider adapter、工具调度与
Git Bash 子进程均为真实路径，因此不消耗供应商凭据也能稳定复现 Windows 边界。

每轮同时断言：

- marker 出现在 RPC 事件流，证明工具调用不是模型自报；
- `uname -s` 包含 `MINGW`，证明 pi 使用 Git for Windows 而非 PATH 中的 WSL bash；
- 无 `__unparseable__` 事件，覆盖 Windows CRLF/LF framing 边界；
- 45 秒内 settled，无挂死或握手失败。

## 结果

| 轮次 | 握手 | bash | framing | 事件数 |
|---:|---|---|---|---:|
| 1–10 | 10/10 | 10/10 `MINGW` | 0 unparseable | 每轮 36 |

总计 360 个事件，0 个无法解析的 record，0 次超时，0 次进程挂死。

同机另执行 `npx tsx scripts/smoke-guard.ts`，真实 pi 进程中的 guard 对 `rm -rf` 与
`git push origin main` 均 block，并在 RPC 事件流和 `tool-audit.jsonl` 两通道留痕；
普通 Git Bash 命令正常放行。

## 实测发现并修复

首次在 Node 26 / Windows 跑全套单测时暴露两处跨平台问题：

1. guard 将候选路径用 Windows 语义 resolve，却拿它和未 resolve 的 POSIX 风格 worktree
   根比较，导致合法相对写入被误拒；现统一 resolve 根与候选路径。
2. runner 契约测试把 `.mjs` fixture 直接当 executable spawn；Node 26 / Windows 返回
   `EFTYPE`。现由 `process.execPath` 启动 fixture，生产 pi 仍直接 spawn 固定二进制。

修复后相关 79 个 runner/guard 测试全过，随后 10 轮真实冒烟全过。

## 结论

PoC-1 的高风险假设未被证伪：pi 0.84.3 在目标 Windows + Git Bash 路径下可以稳定承担
RPC 探针任务。M5-01 保留 pi Windows worker 方案；M5-02 纯 Playwright 执行器仅保留为
应急设计，不作为当前实施路径。
