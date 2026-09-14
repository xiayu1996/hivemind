import type { EventSink } from "./drain.js";
import type { EventEnvelope } from "./event-buffer.js";
import type { LibsqlPhaseRecorder, PhaseEvidenceInput } from "./phase-recorder.js";

/** Envelope versions this sink knows how to read. An event outside the range is
 * counted and skipped rather than refused: a projection that dies on an
 * envelope newer than itself cannot be rebuilt after the emitter moves on. */
const SUPPORTED_VERSIONS = new Set([1]);

export interface PhaseEvidenceSink extends EventSink {
  /** Events skipped because their envelope version is outside the range. */
  readonly ignored: number;
}

/**
 * Ring 1's writer for a phase's evidence: the canonical provider log, the cache
 * analysis, the per-turn usage rows and the raw RPC events.
 *
 * Every one of those used to be written inline, awaited, in the middle of a
 * phase. A full disk stalled a card; a failed round-trip check killed one.
 */
export function phaseEvidenceSink(recorder: LibsqlPhaseRecorder): PhaseEvidenceSink {
  let ignored = 0;
  return {
    name: "phase-evidence",
    get ignored() { return ignored; },
    deliver: async (events: readonly EventEnvelope[]) => {
      const failures: unknown[] = [];
      for (const event of events) {
        if (event.type !== "phase.telemetry") continue;
        if (!SUPPORTED_VERSIONS.has(event.schemaVersion)) {
          ignored += 1;
          continue;
        }
        // One unwritable phase must not cost the rest of the batch its
        // evidence, so each is attempted and the failures reported together.
        try {
          await recorder.writeEvidence(event.data as PhaseEvidenceInput);
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) {
        throw new Error(`phase evidence failed for ${failures.length} event(s): ${failures.map(String).join("; ")}`);
      }
    },
  };
}
