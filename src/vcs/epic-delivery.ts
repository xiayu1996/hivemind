import type { Client } from "@libsql/client";
import type { GitCommandPort } from "./story-delivery.js";
import { processGitCommand } from "./story-delivery.js";
import type { MRPort } from "./mr/types.js";

export interface EpicMrDeliveryOptions {
  worktreePath: string;
  git?: GitCommandPort;
  now?: () => number;
}

interface DeliveredStory {
  id: string;
  title: string;
  outcome: string;
  verification: string;
}

function evidenceForStory(storyId: string, subjects: readonly string[]): { red: string; green: string } | null {
  const red = `test(${storyId}): red`;
  const green = `feat(${storyId}): green`;
  const redIndex = subjects.indexOf(red);
  const greenIndex = subjects.indexOf(green);
  if (redIndex < 0 || greenIndex < 0 || redIndex >= greenIndex) return null;
  return { red, green };
}

function renderDescription(epicId: string, title: string, stories: readonly DeliveredStory[], subjects: readonly string[]): string {
  const chapters = stories.map((story) => {
    const evidence = evidenceForStory(story.id, subjects);
    if (!evidence) throw new Error(`invalid red-to-green evidence for Story ${story.id}`);
    return `## ${story.id}: ${story.title}\n\nOutcome: ${story.outcome}\n\nVerification: ${story.verification}\n\nEvidence: \`${evidence.red}\` -> \`${evidence.green}\``;
  });
  return `# Epic ${epicId}: ${title}\n\n${chapters.join("\n\n")}\n`;
}

/** Creates the one review request for an Epic only after every Story has durable evidence. */
export class EpicMrDelivery {
  private readonly git: GitCommandPort;
  private readonly now: () => number;

  constructor(
    private readonly client: Client,
    private readonly mr: MRPort,
    private readonly options: EpicMrDeliveryOptions,
  ) {
    this.git = options.git ?? processGitCommand;
    this.now = options.now ?? Date.now;
  }

  async deliver(epicId: string): Promise<{ mrUrl: string }> {
    const epic = (await this.client.execute({
      sql: "SELECT title, repo, integration_branch, mr_url FROM epics WHERE id = ?",
      args: [epicId],
    })).rows[0];
    if (!epic) throw new Error(`Epic ${epicId} does not exist`);
    if (typeof epic.mr_url === "string") return { mrUrl: epic.mr_url };
    if (typeof epic.repo !== "string" || typeof epic.integration_branch !== "string") {
      throw new Error(`Epic ${epicId} is missing repository or integration branch`);
    }
    const stories = (await this.client.execute({
      sql: `SELECT s.id, s.title, s.requirement AS outcome, a.body AS verification
            FROM stories s
            JOIN phase_artifacts a ON a.card_id = s.id AND a.phase = 'MERGE' AND a.kind = 'delivery-report'
            WHERE s.epic_id = ? AND s.state = 'DELIVERED'
            ORDER BY s.created_at, s.id`,
      args: [epicId],
    })).rows.map((row) => ({
      id: String(row.id), title: String(row.title), outcome: String(row.outcome), verification: String(row.verification),
    }));
    const allStories = Number((await this.client.execute({
      sql: "SELECT COUNT(*) AS count FROM stories WHERE epic_id = ?", args: [epicId],
    })).rows[0]?.count ?? 0);
    if (stories.length === 0 || stories.length !== allStories) {
      throw new Error(`Epic ${epicId} has Stories that are not delivered with verification summaries`);
    }
    const subjects = (await this.git.run(this.options.worktreePath, ["log", "--format=%s", "--reverse", `main..${epic.integration_branch}`]))
      .split("\n").filter(Boolean);
    const body = renderDescription(epicId, String(epic.title), stories, subjects);
    const result = await this.mr.create({
      repository: epic.repo,
      sourceBranch: epic.integration_branch,
      targetBranch: "main",
      title: `[${epicId}] ${String(epic.title)}`,
      body,
    });
    const update = await this.client.execute({
      sql: "UPDATE epics SET mr_url = ?, updated_at = ? WHERE id = ? AND mr_url IS NULL",
      args: [result.url, this.now(), epicId],
    });
    if (update.rowsAffected !== 1) {
      const current = (await this.client.execute({ sql: "SELECT mr_url FROM epics WHERE id = ?", args: [epicId] })).rows[0];
      if (typeof current?.mr_url === "string") return { mrUrl: current.mr_url };
      throw new Error(`Epic ${epicId} MR delivery lost a race`);
    }
    return { mrUrl: result.url };
  }
}
