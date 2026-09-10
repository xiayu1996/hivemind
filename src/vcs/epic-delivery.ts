import type { Client } from "@libsql/client";
import type { GitCommandPort } from "./story-delivery.js";
import { processGitCommand } from "./story-delivery.js";
import type { MRPort } from "./mr/types.js";

export interface EpicMrDeliveryOptions {
  worktreePath: string;
  /** Branch the review request lands on and the base of the evidence log; defaults to main. */
  targetBranch?: string;
  /** Holds the review request while the Epic's scenarios carry open regression cards. */
  regressionClean?: (epicId: string) => Promise<{ clean: boolean; reason?: string }>;
  git?: GitCommandPort;
  now?: () => number;
}

export type EpicMrDeliveryResult =
  | { kind: "delivered"; mrUrl: string }
  | { kind: "waiting"; reason: string };

interface DeliveredStory {
  id: string;
  title: string;
  outcome: string;
  verification: string;
}

const NO_PAIR_EVIDENCE = "no red/green commit pair on the branch; see the verification report";

/** Red and green commits are named after the scenario they cover, not after
 * the Story, so a Story's evidence is every scenario pair beneath its id. */
function evidenceForStory(storyId: string, subjects: readonly string[]): Array<{ red: string; green: string }> {
  const reds = new Map<string, string>();
  const pairs = new Map<string, { red: string; green: string }>();
  for (const subject of subjects) {
    const match = /^(test|feat)\(([^)]+)\): (red|green)$/.exec(subject);
    if (!match) continue;
    const [, kind, scenarioId, colour] = match as unknown as [string, string, string, string];
    if (scenarioId !== storyId && !scenarioId.startsWith(`${storyId}-`)) continue;
    if (kind === "test" && colour === "red") {
      if (!reds.has(scenarioId)) reds.set(scenarioId, subject);
      continue;
    }
    if (kind !== "feat" || colour !== "green") continue;
    const red = reds.get(scenarioId);
    if (red !== undefined && !pairs.has(scenarioId)) pairs.set(scenarioId, { red, green: subject });
  }
  return [...pairs.entries()].toSorted(([left], [right]) => left.localeCompare(right)).map(([, pair]) => pair);
}

function renderDescription(epicId: string, title: string, stories: readonly DeliveredStory[], subjects: readonly string[]): string {
  const chapters = stories.map((story) => {
    // The CODE exit gate also accepts trajectory evidence, so a Story without a
    // commit pair is still delivered; its verification report carries the proof.
    const evidence = evidenceForStory(story.id, subjects);
    const trail = evidence.length === 0
      ? NO_PAIR_EVIDENCE
      : evidence.map((pair) => `\`${pair.red}\` -> \`${pair.green}\``).join("; ");
    return `## ${story.id}: ${story.title}\n\nOutcome: ${story.outcome}\n\nVerification: ${story.verification}\n\nEvidence: ${trail}`;
  });
  return `# Epic ${epicId}: ${title}\n\n${chapters.join("\n\n")}\n`;
}

/** Creates the one review request for an Epic only after every Story has durable evidence. */
export class EpicMrDelivery {
  private readonly git: GitCommandPort;
  private readonly now: () => number;
  private readonly targetBranch: string;

  constructor(
    private readonly client: Client,
    private readonly mr: MRPort,
    private readonly options: EpicMrDeliveryOptions,
  ) {
    this.git = options.git ?? processGitCommand;
    this.now = options.now ?? Date.now;
    this.targetBranch = options.targetBranch ?? "main";
  }

  async deliver(epicId: string): Promise<EpicMrDeliveryResult> {
    const epic = (await this.client.execute({
      sql: "SELECT title, repo, integration_branch, mr_url FROM epics WHERE id = ?",
      args: [epicId],
    })).rows[0];
    if (!epic) throw new Error(`Epic ${epicId} does not exist`);
    if (typeof epic.mr_url === "string") return { kind: "delivered", mrUrl: epic.mr_url };
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
    if (this.options.regressionClean) {
      const gate = await this.options.regressionClean(epicId);
      if (!gate.clean) {
        return { kind: "waiting", reason: gate.reason ?? `Epic ${epicId} has open regression cards` };
      }
    }
    const subjects = (await this.git.run(this.options.worktreePath,
      ["log", "--format=%s", "--reverse", `${this.targetBranch}..${epic.integration_branch}`]))
      .split("\n").filter(Boolean);
    const body = renderDescription(epicId, String(epic.title), stories, subjects);
    const result = await this.mr.create({
      repository: epic.repo,
      sourceBranch: epic.integration_branch,
      targetBranch: this.targetBranch,
      title: `[${epicId}] ${String(epic.title)}`,
      body,
    });
    const update = await this.client.execute({
      sql: "UPDATE epics SET mr_url = ?, updated_at = ? WHERE id = ? AND mr_url IS NULL",
      args: [result.url, this.now(), epicId],
    });
    if (update.rowsAffected !== 1) {
      const current = (await this.client.execute({ sql: "SELECT mr_url FROM epics WHERE id = ?", args: [epicId] })).rows[0];
      if (typeof current?.mr_url === "string") return { kind: "delivered", mrUrl: current.mr_url };
      throw new Error(`Epic ${epicId} MR delivery lost a race`);
    }
    return { kind: "delivered", mrUrl: result.url };
  }
}
