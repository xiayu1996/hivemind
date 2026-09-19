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

With no database argument the entry opens a temporary demonstration store and
fills it with a dataset where every section has content, so the screen can be
opened on its own. Point it at the real store with `--db <url>` (or
`HIVEMIND_DB_URL`) to read the central database instead; nothing is seeded then.
The orchestrator mounts the same server in-process and serves the same screen.

## Looking at the four content states

`?state=empty`, `?state=loading`, `?state=error` and `?state=waiting` force the
page into one of the four states the requirement names. Each renders through the
same code path a real empty store, a failed read or a pending result takes, so a
reviewer can see the wording and the re-read action without breaking the
service. A normal open reads the store and picks the state from what it found.
