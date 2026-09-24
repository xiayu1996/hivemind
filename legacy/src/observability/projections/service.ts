import type { Client } from "@libsql/client";
import { checkInvariants, type InvariantFinding } from "../invariants.js";
import { loadRejections, rankRejections, type RejectionGroup } from "../reject-signature.js";
import {
  foldFleet,
  loadCardSummary,
  type CardSummary,
  type FleetSummary,
} from "./cascade.js";

/**
 * Keeps the card and fleet views current, entirely outside the delivery path.
 *
 * Push and poll both, for the same reason dispatch and configuration do: a
 * nudge makes the common case immediate, and the timer makes a missed nudge
 * cost latency rather than correctness. The cursor is `event_log.id`, which is
 * a single monotonic sequence over everything recorded, so "what changed since
 * I last looked" is one comparison rather than a scan.
 */

export interface ProjectionServiceOptions {
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onError?: (error: unknown) => void;
}

const DEFAULT_INTERVAL_MS = 2_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

export class ProjectionService {
  private cursor = 0;
  private readonly cards = new Map<string, CardSummary>();
  private fleetSummary: FleetSummary = foldFleet([]);
  private invariantFindings: InvariantFinding[] = [];
  private rejectionGroups: RejectionGroup[] = [];
  private running = false;
  private loop: Promise<void> | null = null;
  private wake: (() => void) | null = null;
  private readonly intervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly client: Client, private readonly options: ProjectionServiceOptions = {}) {
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.sleep = options.sleep ?? delay;
  }

  /** Recomputes the cards touched since the cursor. Returns how many it redid. */
  async refresh(): Promise<number> {
    const rows = (await this.client.execute({
      sql: "SELECT MAX(id) AS head, COUNT(DISTINCT card_id) AS touched FROM event_log WHERE id > ? AND card_id IS NOT NULL",
      args: [this.cursor],
    })).rows[0];
    const head = rows?.head === null || rows?.head === undefined ? this.cursor : Number(rows.head);
    if (head <= this.cursor && this.cards.size > 0) return 0;
    const changed = (await this.client.execute({
      sql: "SELECT DISTINCT card_id FROM event_log WHERE id > ? AND card_id IS NOT NULL",
      args: [this.cursor],
    })).rows.map((row) => String(row.card_id));
    // A first pass has no cursor to work from and has to take the whole board;
    // afterwards only the cards that produced an event are recomputed.
    const ids = this.cards.size === 0
      ? (await this.client.execute("SELECT id FROM stories")).rows.map((row) => String(row.id))
      : changed;
    for (const cardId of ids) {
      const summary = await loadCardSummary(this.client, cardId);
      if (summary) this.cards.set(cardId, summary);
    }
    this.cursor = head;
    this.fleetSummary = foldFleet([...this.cards.values()].toSorted((a, b) => (a.cardId < b.cardId ? -1 : 1)));
    // Ring 3 reads the same store and produces findings, never blocks: a
    // violated invariant is a hole in the process to be looked at, and a
    // checker that could stop a card would be a second, weaker gate.
    this.invariantFindings = await checkInvariants(this.client);
    this.rejectionGroups = rankRejections(await loadRejections(this.client));
    return ids.length;
  }

  /** Ask for a refresh now instead of at the next tick. */
  nudge(): void {
    this.wake?.();
  }

  card(cardId: string): CardSummary | undefined {
    return this.cards.get(cardId);
  }

  fleet(): FleetSummary {
    return this.fleetSummary;
  }

  /** Process invariants that do not hold right now. Never empty by policy. */
  findings(): readonly InvariantFinding[] {
    return this.invariantFindings;
  }

  /** Why work came back, ranked by how many cards a reason touched. */
  rejections(): readonly RejectionGroup[] {
    return this.rejectionGroups;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = (async () => {
      while (this.running) {
        try {
          await this.refresh();
        } catch (error) {
          // A projection that cannot be computed is a reader's problem; the
          // next tick tries again and no card ever hears about it.
          this.options.onError?.(error);
        }
        await new Promise<void>((resolve) => {
          this.wake = resolve;
          void this.sleep(this.intervalMs).then(resolve);
        });
        this.wake = null;
      }
    })();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop?.catch(() => undefined);
    this.loop = null;
  }
}
