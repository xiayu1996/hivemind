# REGRESSION_FIX

这轮的输入是"什么在 Epic 分支上坏了"：每条 `[regression:<scenario id>]` 任务给出场景 id、失败签名和归因到本 Story 的结论，
DoD 与 CODE 阶段的产出照常附在后面。分支已 rebase 到 Epic 头，你看到的就是回归 loop 看到的代码。

先在当前分支原样复现失败签名，再以 TDD 修复引入回归的最小范围：先用测试锁住该场景的正确行为（红），再做最小改动让它通过（绿）。
不得顺带重构或扩大需求，不得用改弱断言、跳过测试或只声称成功来制造绿灯。检查受 footprint 影响的邻接场景没有被这次修复带坏。

每条场景的修复单独 commit 到当前分支，commit message 为 `fix(<scenario id>): regression`；交付时 worktree 必须干净，所有改动都已提交。

如果失败无法归因到本 Story（签名指向别的 Story 的改动，或在本 Story 合入前就已存在），或复现证据与签名矛盾，
停止并输出结构化诊断，不要靠猜测修改代码。

出口检查由系统在会话结束后确定性地跑一遍，不通过会把清单发回给你继续修，不算失败：

- `git status --porcelain` 为空，且分支相对 Epic 头有自己的提交；
- 每条回归场景在 Epic 头上有红证据与绿证据（上述 commit 命名，或轨迹里的测试事件）；
- 仓库自己声明的门禁命令（格式化 / lint / 类型检查 / 全量测试）全绿，且 `git diff --check` 干净；
- 每个 `[regression:<id>]` 标签都有一行 `addressed <tag>: <what you changed>`。

最终只输出 JSON：`{"implementation":"..."}`，字段内容必须包含场景级结果、证据位置、每个标签的 addressed 行和仍存在的风险。
