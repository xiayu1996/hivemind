import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Client } from "@libsql/client";
import type { PhaseTelemetryInput } from "../orchestrator/pi-phase-port.js";
import {
  analyzeCacheTurns,
  diagnosticsFromMessages,
  turnUsageFromMessages,
} from "./cache-analysis.js";
import { CostLedger, type CostRecordedEvent } from "./cost-ledger.js";
import {
  CanonicalLogWriter,
  readCanonicalLog,
  rebuildProviderPayload,
} from "./canonical-log.js";

/** A phase's telemetry plus the cost row the delivery path already wrote, so
 * the canonical log can carry it without writing it a second time. */
export interface PhaseEvidenceInput extends PhaseTelemetryInput {
  cost?: unknown;
}

export interface PhaseRecorderOptions {
  evidenceRoot: string;
  hostId?: string;
  promptVersion?: string;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Persists exact model requests, raw RPC events and pi-reported cost for a phase.
 *
 * Two entry points, deliberately, because they answer to different rules. The
 * cost row is execution state: a stop point is derived from it, so it is
 * written on the delivery path and a failure to write it is a failure. Every
 * other byte here is observation, written from the drain loop, where a slow or
 * broken disk costs a reader their evidence and costs the card nothing.
 */
export class LibsqlPhaseRecorder {
  private readonly ledger: CostLedger;

  constructor(
    private readonly client: Client,
    private readonly options: PhaseRecorderOptions,
    private readonly now: () => number = Date.now,
  ) {
    this.ledger = new CostLedger(client, undefined, now);
  }

  /**
   * The one write on the delivery path. Attributed to what this execution
   * actually ran on: the purpose and tier used to be the literals "phase" and
   * "standard", which made cost unattributable per call site, and the provider
   * used to come from process startup, which charged a failed-over card to the
   * provider it was no longer running on.
   */
  async recordCost(input: PhaseTelemetryInput): Promise<CostRecordedEvent> {
    return this.ledger.record({
      runId: input.runId,
      cardId: input.cardId,
      phase: input.phase,
      purpose: input.spec.purpose,
      tier: input.spec.tier,
      provider: input.spec.model.provider,
      modelId: input.spec.model.id,
      ...(this.options.hostId ? { hostId: this.options.hostId } : {}),
      ...(this.options.promptVersion ? { promptVersion: this.options.promptVersion } : {}),
      isSubscription: !input.spec.metered,
    }, input.result.usage);
  }

  /** Everything a person or a projection reads afterwards. Never called from
   * the delivery path. */
  async writeEvidence(input: PhaseEvidenceInput): Promise<void> {
    if (input.providerPayloads.length === 0) throw new Error("cannot record a phase without a provider payload");
    const runDirectory = join(this.options.evidenceRoot, input.runId);
    await mkdir(runDirectory, { recursive: true });
    const logPath = join(runDirectory, "run-events.jsonl");
    const writer = new CanonicalLogWriter(logPath, 0, this.now);
    await writer.append("turn_start", { turn: 1 });
    for (const [index, payload] of input.providerPayloads.entries()) {
      const step = index + 1;
      await writer.append("step_start", { turn: 1, step });
      await writer.append("request/provider-payload", payload);
      await writer.append("step_end", { turn: 1, step });
    }
    // The RPC stream lives here and only here. event_log is the orchestration
    // decision stream that Epic and requirement state are derived from (04
    // section 3); mirroring every token delta into it duplicated this file into
    // the table those reads go through, and 2.4 million message_update rows had
    // grown the central database past a gigabyte. Nothing reads them there --
    // inspect-round excludes rpc.% explicitly.
    for (const event of input.result.events) {
      await writer.append("rpc/event", event, { ignorable: true });
    }
    await writer.append("assistant_message", { messages: input.messages });
    await writer.append("usage", input.result.usage);
    const turns = turnUsageFromMessages(input.messages);
    const cache = analyzeCacheTurns(turns);
    await writer.append("cache.analysis", cache);
    for (const diagnostic of diagnosticsFromMessages(input.messages)) {
      await writer.append("provider/diagnostics", diagnostic);
    }
    await writer.append("turn_end", { turn: 1, reason: "completed" });
    if (input.cost) await writer.append("cost.recorded", input.cost);
    await writer.flush();

    const rebuilt = rebuildProviderPayload(await readCanonicalLog(logPath));
    if (!sameJson(rebuilt, input.providerPayloads.at(-1))) {
      throw new Error("canonical provider payload did not round-trip exactly");
    }

    const time = this.now();
    const lossByTurn = new Map(cache.losses.map((loss) => [loss.turn, loss.lostTokens]));
    const turnStatements = turns.map((turn) => ({
      sql: `INSERT INTO turn_usage (run_id, turn, card_id, phase, provider, model_id,
              uncached_input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, cache_loss_tokens, ts)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        input.runId,
        turn.turn,
        input.cardId,
        input.phase,
        input.spec.model.provider,
        input.spec.model.id,
        turn.input,
        turn.cacheRead,
        turn.cacheWrite,
        turn.output,
        lossByTurn.get(turn.turn) ?? 0,
        time,
      ],
    }));
    if (turnStatements.length > 0) await this.client.batch(turnStatements, "write");
  }
}
