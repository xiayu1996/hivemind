/**
 * Node builds a failed command's message from stderr alone, and git says some
 * of the most consequential things on stdout: "nothing to commit, working tree
 * clean" is one of them. A SPECIFY freeze that found the phase had already
 * committed its own red therefore reached the coordinator as
 * `Command failed: git commit -m test(S-CARD-01): red` and nothing else, was
 * classified UNKNOWN because no rule can match an empty reason, and parked the
 * card on a crash nobody could name.
 *
 * Attaching what git printed does not change which failures happen; it changes
 * whether the one that happened can be read.
 */
export function describeGitFailure(cause: unknown): unknown {
  if (!(cause instanceof Error)) return cause;
  const said = (cause as { stdout?: unknown }).stdout;
  const printed = typeof said === "string" ? said.trim() : "";
  if (printed === "" || cause.message.includes(printed)) return cause;
  return new Error(`${cause.message.trim()}\n${printed}`, { cause });
}
