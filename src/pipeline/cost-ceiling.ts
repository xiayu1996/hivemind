import type { ConfigStore } from "../config/store.js";

export interface CardSpend {
  /** Spend on providers billed per token. This is the money at risk. */
  billedUsd: number;
  /**
   * Spend attributed to a flat-rate subscription. Recorded for accounting and
   * deliberately excluded from the ceiling: a ChatGPT plan costs the same
   * whether a card uses it or not, so counting it would park a card for money
   * nobody spent.
   */
  subscriptionUsd: number;
}

export interface CostCeilingVerdict {
  exceeded: boolean;
  billedUsd: number;
  ceilingUsd: number;
  remainingUsd: number;
}

/**
 * The spend a single card may put at risk before it stops and asks.
 *
 * This is not a loop bound and must never be used as one. Round ceilings
 * (03 section 1.5) answer "is the system going in circles", and a budget is a
 * poor proxy for that: it punishes genuinely hard work. This answers the other
 * question — "how much money can one card cost before somebody looks at it" —
 * and rounds are just as poor a proxy for that, since the same six inner-loop
 * rounds differ by an order of magnitude in cost depending on the model and the
 * context carried.
 *
 * It is read per dispatch, so a card mid-flight is measured against the ceiling
 * that was in force when its next phase started rather than one that moved
 * underneath it.
 */
export async function costCeilingUsd(config: ConfigStore): Promise<number> {
  await config.reload();
  return config.get("cost.perCardUsdCeiling");
}

export function costCeilingVerdict(spend: CardSpend, ceilingUsd: number): CostCeilingVerdict {
  const billedUsd = spend.billedUsd;
  return {
    exceeded: billedUsd >= ceilingUsd,
    billedUsd,
    ceilingUsd,
    remainingUsd: Math.max(0, ceilingUsd - billedUsd),
  };
}

/**
 * The report attached to the stopped card. It is read by whoever decides
 * whether this work is worth more money, so it says what was spent and on what
 * rather than naming a threshold and stopping.
 */
export function renderCostCeilingReport(
  cardId: string,
  verdict: CostCeilingVerdict,
  spend: CardSpend,
  byPhase: ReadonlyMap<string, number>,
): string {
  const lines = [
    `${cardId} stopped: it reached the spend a single card is allowed`,
    "",
    `Spent on metered providers: $${verdict.billedUsd.toFixed(2)} of $${verdict.ceilingUsd.toFixed(2)}`,
  ];
  if (spend.subscriptionUsd > 0) {
    lines.push(`Also used $${spend.subscriptionUsd.toFixed(2)} of subscription allowance,` +
      " which is flat-rate and not counted against the ceiling");
  }
  if (byPhase.size > 0) {
    lines.push("", "Where it went:");
    for (const [phase, usd] of [...byPhase].toSorted((left, right) => right[1] - left[1])) {
      lines.push(`  ${phase}: $${usd.toFixed(2)}`);
    }
  }
  lines.push(
    "",
    "This is a spend limit, not a verdict on the work: nothing here says the task",
    "cannot be finished. Raise the ceiling to continue, or split the card so each",
    "piece fits inside it.",
  );
  return `${lines.join("\n")}\n`;
}
