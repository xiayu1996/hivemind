import type { Client } from "@libsql/client";
import type { MergeResult, MergeStory } from "../vcs/merge-flow.js";
import type { StoryExecutionStore } from "./story-execution-store.js";

export interface EpicMergePort {
  merge(input: {
    epicId: string;
    story: MergeStory;
    integratedStories: readonly MergeStory[];
  }): Promise<MergeResult>;
}

/**
 * Puts one Story onto its Epic's integration branch. Everything that can go
 * wrong here is the Story's problem, not the Epic's: a conflict and a failed
 * subset re-verification both send the Story back to CODE with its worktree
 * untouched, because resolving either one is work an agent has to do in the
 * tree, not a choice the orchestrator may make on its own.
 */
export class EpicIntegrator {
  constructor(
    private readonly client: Client,
    private readonly store: StoryExecutionStore,
    private readonly flow: EpicMergePort,
  ) {}

  async integrate(cardId: string, runId: string): Promise<MergeResult> {
    const row = (await this.client.execute({
      sql: "SELECT epic_id, branch, predicted_footprint FROM stories WHERE id = ?",
      args: [cardId],
    })).rows[0];
    if (!row) throw new Error(`Story does not exist: ${cardId}`);
    const epicId = String(row.epic_id ?? "");
    if (!epicId) throw new Error(`Story ${cardId} belongs to no Epic`);
    const branch = String(row.branch ?? "");
    if (!branch) throw new Error(`Story ${cardId} has no branch to integrate`);

    const scenarioIds = (await this.client.execute({
      sql: "SELECT spec_id FROM story_specs WHERE story_id = ? ORDER BY seq",
      args: [cardId],
    })).rows.map((spec) => String(spec.spec_id));
    // The subset the merge re-verifies is built from these; with none, the
    // merge would verify nothing and call that a pass.
    if (scenarioIds.length === 0) throw new Error(`Story ${cardId} declares no scenario to re-verify`);

    const integrated = (await this.store.integratedStories(epicId)).filter((story) => story.id !== cardId);
    const result = await this.flow.merge({
      epicId,
      story: {
        id: cardId,
        branch,
        predictedFootprint: JSON.parse(String(row.predicted_footprint ?? "[]")) as string[],
        scenarioIds,
      },
      integratedStories: integrated.map((story) => ({
        id: story.id,
        branch: story.branch,
        predictedFootprint: story.predictedFootprint,
        scenarioIds: story.scenarioIds,
      })),
    });

    if (result.kind === "merged") {
      await this.store.markIntegrated(cardId);
      return result;
    }
    if (result.kind === "conflict") {
      await this.store.recordMergeConflict(cardId, runId, result.reason);
      return result;
    }
    await this.store.recordIntegrationRejection(
      cardId,
      runId,
      result.reason ?? `subset re-verification failed for ${result.scenarioIds.join(", ")}`,
    );
    return result;
  }
}
