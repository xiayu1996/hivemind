export interface AttributionProbe {
  /**
   * Whether the scenario fails at the state after `index` items of the sequence
   * have landed. `index` 0 means the base, before anything in the sequence.
   * "unknown" is for a revision where the scenario could not be judged at all,
   * which is not the same as one where it passed.
   */
  (index: number): Promise<boolean | "unknown">;
}

export type Attribution =
  | { kind: "introduced"; item: string; index: number; probes: number }
  | { kind: "pre_existing"; probes: number }
  | { kind: "not_reproduced"; probes: number }
  | { kind: "unattributable"; probes: number };

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
  const unattributable = (): Attribution => ({ kind: "unattributable", probes });
  // A revision where the scenario could not be judged answers nothing. Reading
  // it as a pass is what made a screen that has never worked come back "does
  // not reproduce": the application does not start at a revision predating the
  // code that starts it, so the base looked green and the break looked gone.
  const failsAfter = async (index: number): Promise<boolean | "unknown"> => {
    probes += 1;
    return probe(index);
  };

  const atBase = await failsAfter(0);
  if (atBase === "unknown") return unattributable();
  if (sequence.length === 0) return { kind: atBase ? "pre_existing" : "not_reproduced", probes };
  if (atBase) return { kind: "pre_existing", probes };

  const atTip = await failsAfter(sequence.length);
  if (atTip === "unknown") return unattributable();
  if (!atTip) return { kind: "not_reproduced", probes };

  // Invariant: it passes at `low` and fails at `high`.
  let low = 0;
  let high = sequence.length;
  while (high - low > 1) {
    const middle = low + Math.floor((high - low) / 2);
    const fails = await failsAfter(middle);
    if (fails === "unknown") return unattributable();
    if (fails) high = middle;
    else low = middle;
  }
  return { kind: "introduced", item: sequence[high - 1]!, index: high - 1, probes };
}
