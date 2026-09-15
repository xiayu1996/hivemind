/**
 * Glob matching limited to what the configured patterns actually use: `**`,
 * `*` and `?`. Shared so the phase that freezes a path, the guard that fences
 * it and the exit that re-checks it all agree on what a pattern covers; three
 * implementations of "is this a test file" is three chances to disagree.
 */
export function globToRegexSource(pattern: string): string {
  return pattern
    .split("**").map((part) => part.split("*").map((piece) => piece.split("?")
      .map((literal) => literal.replaceAll(/[.+^${}()|[\]\\]/g, "\\$&")).join("[^/]"))
      .join("[^/]*"))
    .join(".*");
}

export function matchesGlob(path: string, pattern: string): boolean {
  return new RegExp(`^${globToRegexSource(pattern)}$`).test(path);
}

export function matchesAnyGlob(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchesGlob(path, pattern));
}

/** The same patterns as the guard wants them: anchored regex sources. */
export function fencedSourcesFor(patterns: readonly string[]): string[] {
  return patterns.map((pattern) => `^${globToRegexSource(pattern)}$`);
}
