/**
 * The write fence for the phase that draws the interface contract.
 *
 * The drawing session may write the contract directory and nothing else. It is
 * not building the product, and a phase that decided to start the product
 * while drawing it would be making, in one unreviewed session, the repository
 * level decisions that the solution gate exists to put in front of a person.
 *
 * Expressed as fenced patterns rather than as a narrower write root because
 * the guard resolves a relative path against the write root: pointing that
 * root at the contract directory would let `src/app.ts` -- which pi writes
 * relative to the worktree -- resolve inside the root and pass.
 */

/** Escapes a directory for use inside a pattern; a contract root comes from
 * configuration and may hold characters a regular expression reads. */
function escape(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/**
 * Two patterns: everything that is not inside the contract root, and any path
 * that walks up out of one. The second is not redundant -- without it
 * `docs/prototype/../../src/app.ts` satisfies the first.
 */
export function prototypeFencePatterns(contractRoot: string): string[] {
  const root = escape(contractRoot.replaceAll("\\", "/").replace(/^\/+|\/+$/g, ""));
  return [
    String.raw`(^|/)\.\.(/|$)`,
    `^(?!(?:.*/)?${root}/).*$`,
  ];
}
