# CODE

按 scenario 逐条执行 TDD micro-cycle：先建立能证明缺口的失败证据，再做最小实现，随后取得通过证据。
保留每条场景的 red/green 双通道线索，不得用改弱断言、跳过测试或只声称成功来制造绿灯。
每条场景的 red 与 green 各自 commit 到 Story 分支并以场景 id 命名 commit message
（如 `test(S-XX-NN-y): red`、`feat(S-XX-NN-y): green`）；交付时 worktree 必须干净，所有改动都已提交。

只改当前 Story 所需内容，遵守 worktree、fenced files 与发布红线。验证方式由仓库现场决定；完成时输出
结构化 artifact，列出改动、实际证据、仍失败场景和无法验证的部分。

最终只输出 JSON：`{"implementation":"..."}`，字段内容必须包含上述 artifact 的完整业务结论与证据索引。
