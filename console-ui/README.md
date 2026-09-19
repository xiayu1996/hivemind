# console-ui

The browser screen for the operations console, built against the interface
contract in `docs/prototype/`.

The overview is the first screen and lives at `/`. It is rendered on the server
from the central store, so an open page is readable before any script runs; the
small `/assets/overview.js` then refreshes the same block every thirty seconds
while the page is visible.

Each row of the waiting rail links to `/todo?requirement=<id>`, the item page
behind that action: the item's own question, the requirement it belongs to and
how long it has waited, with the handling controls the interface contract
declares. A requirement with nothing waiting gets a named state instead of a
missing page. The console stays read-only, so the page presents the item rather
than keeping a reply.

## Running it

```sh
npx tsx scripts/serve-console.ts --port 4319
```

The entry opens a temporary store and fills it with the declared dataset where
every section has content, so a round always judges the sample its scenarios are
written about -- not whatever work the environment happens to hold. Point it at
a database on purpose with `--db <url>` to read that store instead; nothing is
seeded then. The orchestrator mounts the same server in-process against the
central store, and that in-process mount is the console a person reads.

## Looking at the four content states

`?state=empty`, `?state=loading`, `?state=error` and `?state=waiting` force the
page into one of the four states the requirement names. Each renders through the
same code path a real empty store, a failed read or a pending result takes, so a
reviewer can see the wording and the re-read action without breaking the
service. A normal open reads the store and picks the state from what it found.
