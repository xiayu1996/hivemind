# impeccable detect captures

Real `impeccable detect --json --no-config <files>` output, captured 2026-09-18
from the pinned engine (`engine-v0.1.5`, which reports `--version` as `4.0.0`)
on two hand-written prototype pages. Nothing here is written by hand: the
wrapper in `src/verify/design-lint.ts` is judged against what the binary
actually prints, including the parts that read like mistakes.

- `clean-exit-0.json` — a page built out of custom properties. Exit code 0.
- `findings-exit-2.json` — a page with a violet gradient, the default font, a
  skipped heading level and a flat type scale. Exit code 2.

Two properties of the capture matter to the wrapper:

- `file` is always absolute, on the machine that scanned. The wrapper makes it
  relative to the scan root so a finding reads the same on every host.
- `severity` is `warning` on every row here, and the tool's own documentation
  calls it a routing field ("which command should fix this"), not a severity.
  Nothing grades findings by it; every finding is recorded as friction and none
  of them refuses a prototype.

Exit code 1 means a target could not be scanned at all; the capture for it is a
one-line stderr (`Warning: cannot access sample/missing.html`) with `[]` on
stdout, which is why an empty array alone is not read as a clean scan.
