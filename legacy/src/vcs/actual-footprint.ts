import type { Client, Row } from "@libsql/client";
import type { MergeGitPort } from "./merge-flow.js";

export interface ActualFootprintCapture {
  storyId: string;
  integrationBranch: string;
  baseRevision: string;
  storyRevision: string;
  actualFootprint: readonly string[];
}

/** The merge flow only records; listing pending captures belongs to recovery. */
export interface ActualFootprintRecorder {
  capture(capture: ActualFootprintCapture): Promise<void>;
  apply(storyId: string): Promise<void>;
}

export interface ActualFootprintStore extends ActualFootprintRecorder {
  pending(): Promise<ActualFootprintCapture[]>;
}

function value(row: Row, name: string): string {
  const item = row[name];
  if (typeof item !== "string") throw new Error(`actual footprint capture has invalid ${name}`);
  return item;
}

export function normalizeActualFootprint(nameStatus: string): string[] {
  const fields = nameStatus.split("\0");
  const directories = new Set<string>();
  for (let index = 0; index < fields.length - 1;) {
    const status = fields[index++];
    if (!status) continue;
    const paths = status.startsWith("R") || status.startsWith("C") ? 2 : 1;
    for (let count = 0; count < paths; count += 1) {
      const path = fields[index++];
      if (path === undefined) throw new Error("git diff returned an incomplete name-status record");
      if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) throw new Error(`git path is not repository-relative: ${path}`);
      const segments = path.split("/");
      if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
        throw new Error(`git path cannot be normalized: ${path}`);
      }
      directories.add(segments.length === 1 ? "." : segments.slice(0, -1).join("/"));
    }
  }
  return [...directories].toSorted();
}

export class LibsqlActualFootprintStore implements ActualFootprintStore {
  constructor(
    private readonly client: Client,
    private readonly now: () => number = Date.now,
  ) {}

  /** A re-merge supersedes an earlier capture: the newer revision pair is the accurate one. */
  async capture(capture: ActualFootprintCapture): Promise<void> {
    const footprint = JSON.stringify([...capture.actualFootprint]);
    await this.client.execute({
      sql: `INSERT INTO actual_footprint_captures
              (story_id, integration_branch, base_revision, story_revision, actual_footprint, state, created_at)
            VALUES (?, ?, ?, ?, ?, 'pending', ?)
            ON CONFLICT(story_id) DO UPDATE SET
              integration_branch = excluded.integration_branch,
              base_revision = excluded.base_revision,
              story_revision = excluded.story_revision,
              actual_footprint = excluded.actual_footprint,
              state = 'pending',
              created_at = excluded.created_at,
              applied_at = NULL`,
      args: [capture.storyId, capture.integrationBranch, capture.baseRevision, capture.storyRevision, footprint, this.now()],
    });
  }

  async apply(storyId: string): Promise<void> {
    const time = this.now();
    await this.client.batch([
      {
        sql: `UPDATE stories
                SET actual_footprint = (SELECT actual_footprint FROM actual_footprint_captures WHERE story_id = ?),
                    updated_at = ?
              WHERE id = ? AND EXISTS (SELECT 1 FROM actual_footprint_captures WHERE story_id = ?)`,
        args: [storyId, time, storyId, storyId],
      },
      {
        sql: "UPDATE actual_footprint_captures SET state = 'applied', applied_at = ? WHERE story_id = ? AND state = 'pending'",
        args: [time, storyId],
      },
    ], "write");
  }

  async pending(): Promise<ActualFootprintCapture[]> {
    const rows = (await this.client.execute(
      "SELECT story_id, integration_branch, base_revision, story_revision, actual_footprint FROM actual_footprint_captures WHERE state = 'pending' ORDER BY story_id",
    )).rows;
    return rows.map((row) => ({
      storyId: value(row, "story_id"),
      integrationBranch: value(row, "integration_branch"),
      baseRevision: value(row, "base_revision"),
      storyRevision: value(row, "story_revision"),
      actualFootprint: JSON.parse(value(row, "actual_footprint")),
    }));
  }
}

/** Applies only captures whose recorded Story revision is reachable from its integration branch. */
export async function recoverActualFootprints(
  git: MergeGitPort,
  integrationWorktree: string,
  store: ActualFootprintStore,
): Promise<void> {
  for (const capture of await store.pending()) {
    try {
      await git.run(integrationWorktree, ["merge-base", "--is-ancestor", capture.storyRevision, capture.integrationBranch]);
    } catch {
      continue;
    }
    await store.apply(capture.storyId);
  }
}
