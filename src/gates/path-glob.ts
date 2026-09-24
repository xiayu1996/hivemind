// Repo-relative glob matching, limited to what configured patterns use: `**`,
// `*` and `?`, with every other character literal. One matcher is shared so
// the step that fences a path, the guard that refuses writing it and the check
// that re-reads the tree afterwards all agree on what a pattern covers.
//
// A whole-segment `**` is zero or more directories: `**/*.test.ts` covers a
// test file at the root and `src/**` covers `src` itself. Requiring at least
// one directory there let a root-level file walk past a fence written that
// way. Inside a segment (`a**b`) it crosses directories like `.*`.
//
// Paths are posix and relative to the repository root, with no leading `./`.

export interface GlobOptions {
  /** Fences want this: on macOS a pattern that matches one casing only is bypassable. */
  ignoreCase?: boolean;
}

function literal(text: string): string {
  return text.replaceAll(/[.+^${}()|[\]\\]/g, String.raw`\$&`);
}

function segmentSource(segment: string): string {
  return segment
    .split("**")
    .map((part) =>
      part
        .split("*")
        .map((piece) => piece.split("?").map(literal).join("[^/]"))
        .join("[^/]*"),
    )
    .join(".*");
}

function globSource(pattern: string): string {
  // Consecutive globstars mean the same as one.
  const segments = pattern.split("/").filter((segment, index, all) => !(segment === "**" && all[index - 1] === "**"));
  let source = "";
  let separator = "";
  for (const [index, segment] of segments.entries()) {
    if (segment !== "**") {
      source += separator + segmentSource(segment);
      separator = "/";
      continue;
    }
    const first = index === 0;
    const last = index === segments.length - 1;
    if (first && last) source += ".*";
    else if (first) source += "(?:.*/)?";
    else if (last) source += "(?:/.*)?";
    else source += "/(?:.*/)?";
    separator = "";
  }
  return source;
}

/** Whether the whole of `path` matches `pattern`; a newline in a path does not stop a `**`. */
export function matchesGlob(path: string, pattern: string, options: GlobOptions = {}): boolean {
  return new RegExp(`^${globSource(pattern)}$`, options.ignoreCase ? "is" : "s").test(path);
}

export function matchesAnyGlob(path: string, patterns: readonly string[], options: GlobOptions = {}): boolean {
  return patterns.some((pattern) => matchesGlob(path, pattern, options));
}
