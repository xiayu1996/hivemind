export interface AttributionProbe {
  /**
   * Whether the scenario fails at the state after `index` items of the sequence
   * have landed. `index` 0 means the base, before anything in the sequence.
   */
  (index: number): Promise<boolean>;
}

export type Attribution =
  | { kind: "introduced"; item: string; index: number; probes: number }
  | { kind: "pre_existing"; probes: number }
  | { kind: "not_reproduced"; probes: number };

/**
 * Finds the first item in a merge sequence at which a scenario starts failing.
 *
 * The sequence is the order things landed on the branch, so the failure is
 * monotone in it: once broken it stays broken. That is what makes a bisect
 * sound here, and it is why the two ends are probed first — a failure that was
 * already there before the sequence belongs to nobody in it, and one that will
 * not reproduce at the tip must not be pinned on the last thing merged.
 */
export async function attributeRegression(
  sequence: readonly string[],
  probe: AttributionProbe,
): Promise<Attribution> {
  let probes = 0;
  const failsAfter = async (index: number): Promise<boolean> => {
    probes += 1;
    return probe(index);
  };

  if (sequence.length === 0) {
    return { kind: await failsAfter(0) ? "pre_existing" : "not_reproduced", probes };
  }
  if (await failsAfter(0)) return { kind: "pre_existing", probes };
  if (!(await failsAfter(sequence.length))) return { kind: "not_reproduced", probes };

  // Invariant: it passes at `low` and fails at `high`.
  let low = 0;
  let high = sequence.length;
  while (high - low > 1) {
    const middle = low + Math.floor((high - low) / 2);
    if (await failsAfter(middle)) high = middle;
    else low = middle;
  }
  return { kind: "introduced", item: sequence[high - 1]!, index: high - 1, probes };
}
