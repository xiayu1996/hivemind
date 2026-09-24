import { basename, resolve } from "node:path";

/**
 * Where a declared evidence file may be, in the order to try.
 *
 * A round's captures land directly in that round's own evidence directory, and
 * the prompt tells the verifier to name them bare. A session that instead
 * spells the same file from one level up -- with the directory's own name in
 * front -- means exactly the same file, and refusing it is refusing evidence
 * that is on disk: S-R237511OV-02 round 5 declared fourteen captures that way,
 * every one of them written, and lost every scenario to "does not exist"
 * (2026-09-19). The round before it, the same lane named them bare.
 *
 * A convention a session follows only sometimes is one the box has to resolve;
 * the prompt is the weakest of the three layers and cannot be the only reader
 * of it. Nothing is loosened by this: both candidates are still checked against
 * the evidence root by the caller, so a path that escapes still escapes.
 */
export function evidenceCandidates(root: string, declared: string): string[] {
  const direct = resolve(root, declared);
  const prefix = `${basename(root)}/`;
  if (!declared.startsWith(prefix)) return [direct];
  return [direct, resolve(root, declared.slice(prefix.length))];
}
