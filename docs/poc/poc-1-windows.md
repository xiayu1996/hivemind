# PoC-1：pi 在 Windows(Git Bash) 的 RPC 稳定性

> 结论：**未执行 —— 无法从当前机器触达 Windows 主机**

本轮 M0 在一台 macOS 笔记本上执行。该机：

- 未安装 Tailscale，三机内网尚未组网；
- 不是设计里的任何一个目标节点（目标是 Linux 主机 / Mac mini / Windows）。

因此 Windows 冒烟（以及 C5 的 Mac mini 登录态持久性）在本轮物理上无法执行。

## 执行前置

1. 三机组网（M3-07，可提前做）；
2. Windows 上装 Git Bash 与 pi（`scripts/install-pi.sh` 已覆盖 Linux/macOS，
   **Windows 分支尚未实现**——release 里是 `pi-windows-x64.zip`，需补一段 PowerShell 或在 Git Bash 下用 unzip）；
3. 一份可跑的 provider 凭据。

## 已可提前判定的一点

RPC 协议文档明确要求：分帧只按 LF 切，输入侧容忍并剥离结尾的 `\r`，且**不能用 Node `readline`**
（它还会在 U+2028/U+2029 处切分，而这两个字符在 JSON 字符串里合法）。
本轮实现的 `poc/rpc-context/rpc-client.mjs` 已按此规则手写分帧，Windows CRLF 场景在客户端侧
已有正确处理；剩下待验的是 pi 自身在 Git Bash 下的进程与流稳定性。
