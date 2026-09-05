import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Client } from "@libsql/client";
import type { PhaseTelemetryInput } from "../orchestrator/pi-phase-port.js";
import {
  analyzeCacheTurns,
  diagnosticsFromMessages,
  turnUsageFromMessages,
} from "./cache-analysis.js";
import { CostLedger } from "./cost-ledger.js";
import {
  CanonicalLogWriter,
  readCanonicalLog,
  rebuildProviderPayload,
} from "./canonical-log.js";

export interface PhaseRecorderOptions {
  evidenceRoot: string;
  provider: string;
  modelId: string;
  hostId?: string;
  promptVersion?: string;
  isSubscription?: boolean;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Persists exact model requests, raw RPC events and pi-reported cost for a phase. */
export class LibsqlPhaseRecorder {
  private readonly ledger: CostLedger;

  constructor(
    private readonly client: Client,
    private readonly options: PhaseRecorderOptions,
    private readonly now: () => number = Date.now,
  ) {
    this.ledger = new CostLedger(client, undefined, now);
  }

  async record(input: PhaseTelemetryInput): Promise<void> {
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
    const cost = await this.ledger.record({
      runId: input.runId,
      cardId: input.cardId,
      phase: input.phase,
      purpose: "phase",
      tier: "standard",
      provider: this.options.provider,
      modelId: this.options.modelId,
      ...(this.options.hostId ? { hostId: this.options.hostId } : {}),
      ...(this.options.promptVersion ? { promptVersion: this.options.promptVersion } : {}),
      ...(this.options.isSubscription === undefined ? {} : { isSubscription: this.options.isSubscription }),
    }, input.result.usage);
    await writer.append("cost.recorded", cost.data);
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
        this.options.provider,
        this.options.modelId,
        turn.input,
        turn.cacheRead,
        turn.cacheWrite,
        turn.output,
        lossByTurn.get(turn.turn) ?? 0,
        time,
      ],
    }));
    if (turnStatements.length > 0) await this.client.batch(turnStatements, "write");
    const statements = input.result.events.map((event) => ({
      sql: `INSERT INTO event_log (run_id, seq, card_id, phase, type, ts, data)
            VALUES (?, (SELECT COALESCE(MAX(seq), -1) + 1 FROM event_log WHERE run_id = ?),
                    ?, ?, ?, ?, ?)`,
      args: [
        input.runId,
        input.runId,
        input.cardId,
        input.phase,
        `rpc.${event.type}`,
        time,
        JSON.stringify(event),
      ],
    }));
    if (statements.length > 0) await this.client.batch(statements, "write");
  }
}
