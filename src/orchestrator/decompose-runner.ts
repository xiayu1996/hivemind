import type { Client } from "@libsql/client";
import { evaluateDecomposition, type DecompositionCandidate } from "./decompose.js";
import type { PlanApprovalStore } from "./plan-approval.js";
import { assertEpicTransition, type EpicState } from "./state-machine.js";

export interface DecomposeRequest {
  epicId: string;
  title: string;
  requirement: string;
  /** Why earlier attempts were refused, so the next one does not repeat them. */
  previousRejections: readonly string[];
}

export interface DecomposePort {
  run(input: DecomposeRequest): Promise<DecompositionCandidate>;
}

export interface EpicIntake {
  id: string;
  notionPageId: string;
  title: string;
  requirement: string;
}

export type DecomposeOutcome =
  | { kind: "presented"; stories: number }
  | { kind: "rejected"; reasons: readonly string[] }
  | { kind: "blocking_question"; question: string };

const MAX_ATTEMPTS = 2;

/**
 * Produces the decomposition the approval gate waits for. Nothing else in the
 * system creates one, so an Epic without this never leaves intake.
 */
export class EpicDecomposer {
  constructor(
    private readonly client: Client,
    private readonly approvals: PlanApprovalStore,
    private readonly port: DecomposePort,
    private readonly now: () => number = Date.now,
  ) {}

  async decompose(epic: EpicIntake): Promise<DecomposeOutcome> {
    await this.enterDecompose(epic.id);
    const rejections: string[] = [];

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const candidate = await this.port.run({
        epicId: epic.id,
        title: epic.title,
        requirement: epic.requirement,
        previousRejections: [...rejections],
      });
      const evaluated = evaluateDecomposition(candidate);

      if (evaluated.kind === "blocking_question") {
        // The one stop the decomposition is allowed to take: a missing fact that
        // would change the split. Guessing past it produces plausible Stories
        // for the wrong requirement.
        await this.block(epic.id, `blocking question: ${evaluated.question}`);
        return { kind: "blocking_question", question: evaluated.question };
      }
      if (evaluated.kind === "accepted") {
        await this.approvals.present({
          epicId: epic.id,
          notionPageId: epic.notionPageId,
          title: epic.title,
          plan: candidate,
        });
        return { kind: "presented", stories: evaluated.stories.length };
      }
      rejections.push(...evaluated.reasons);
    }

    await this.block(epic.id, `decomposition rejected: ${rejections.join("; ")}`);
    return { kind: "rejected", reasons: rejections };
  }

  private async enterDecompose(epicId: string): Promise<void> {
    const state = await this.stateOf(epicId);
    if (state === "DECOMPOSE") return;
    assertEpicTransition(state, "DECOMPOSE");
    await this.transition(epicId, state, "DECOMPOSE");
  }

  private async block(epicId: string, reason: string): Promise<void> {
    const state = await this.stateOf(epicId);
    assertEpicTransition(state, "BLOCKED");
    await this.transition(epicId, state, "BLOCKED", reason);
  }

  private async stateOf(epicId: string): Promise<EpicState> {
    const row = (await this.client.execute({
      sql: "SELECT state FROM epics WHERE id = ?",
      args: [epicId],
    })).rows[0];
    if (!row) throw new Error(`Epic ${epicId} does not exist`);
    return String(row.state) as EpicState;
  }

  private async transition(epicId: string, from: EpicState, to: EpicState, reason?: string): Promise<void> {
    const time = this.now();
    const runId = `epic:${epicId}`;
    const [update] = await this.client.batch([
      {
        sql: "UPDATE epics SET state = ?, updated_at = ? WHERE id = ? AND state = ?",
        args: [to, time, epicId, from],
      },
      {
        sql: `INSERT INTO event_log (run_id, seq, card_id, phase, type, ts, data)
              VALUES (?, (SELECT COALESCE(MAX(seq), -1) + 1 FROM event_log WHERE run_id = ?),
                      NULL, 'DECOMPOSE', 'epic.transition', ?, ?)`,
        args: [runId, runId, time, JSON.stringify({ from, to, ...(reason ? { reason } : {}) })],
      },
    ], "write");
    if (update?.rowsAffected !== 1) {
      throw new Error(`Epic ${epicId} left ${from} while it was being decomposed`);
    }
  }
}
