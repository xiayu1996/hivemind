/**
 * The directory a footprint entry names, whichever way it was spelled.
 *
 * A trailing slash and a trailing glob both name the subtree they are attached
 * to, and neither may change the answer. Untrimmed, `src/console/` and
 * `src/console/**` each failed to contain `src/console/tabs` while
 * `src/console` contained it, so two Stories in one subtree could be planned
 * side by side. All three spellings come from real cards: the DoD rewrites the
 * footprint the decomposition validated and asks only for non-empty strings.
 *
 * Only a whole segment is dropped, so `src/consoles` and a file named `*`
 * keep their own names.
 *
 * Shared, because the scheduler decides what a path covers with it and the
 * exit that judges a footprint has to judge the same path the scheduler will
 * use: two copies would let a gate pass an entry the scheduler then widens
 * into something else.
 */
export function directoryOf(path: string): string {
  let end = path.length;
  for (;;) {
    while (end > 1 && path[end - 1] === "/") end -= 1;
    const segment = path.lastIndexOf("/", end - 1) + 1;
    const last = path.slice(segment, end);
    if (segment === 0 || (last !== "*" && last !== "**")) return path.slice(0, end);
    end = segment;
  }
}
