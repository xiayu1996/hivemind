# M1 worktree R-5 review

The M1 worktree implementation was reviewed against the multi-host constraints before it was added.

- It does not use a process-local lock as execution ownership. The central lease remains authoritative.
- It does not treat local worktree files as execution truth. Local files are scratch state only.
- It never invokes BullMQ `obliterate` or clears shared queues during startup.
- Quarantine is a recoverable move within the managed layout. It does not delete worktrees or evidence.
- All source and destination paths are resolved and checked against explicit managed roots before a move.

No `single-process` assumption was carried into the implementation.
