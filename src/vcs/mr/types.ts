export interface MergeRequestInput {
  repository: string;
  sourceBranch: string;
  targetBranch: string;
  title: string;
  body: string;
  draft?: boolean;
}

export interface MergeRequestResult {
  url: string;
  provider: "github" | "gitlab";
}

export interface OpenMergeRequestQuery {
  repository: string;
  sourceBranch: string;
  targetBranch: string;
}

export interface MRPort {
  create(input: MergeRequestInput): Promise<MergeRequestResult>;
  /** The URL of an open review request between the two branches, or null; a
   * Story that comes back after its draft was opened reuses it instead of
   * tripping the platform's "already exists" refusal. */
  findOpen(query: OpenMergeRequestQuery): Promise<string | null>;
}

export type MergeRequestState = "open" | "merged" | "closed";

/** Reads where the review request at a URL stands: still open, landed on its
 * target, or closed without landing. */
export interface MergeRequestStatePort {
  state(url: string): Promise<MergeRequestState>;
}

export interface CliResult {
  stdout: string;
  stderr: string;
}

export interface CliExecutor {
  run(binary: string, args: string[]): Promise<CliResult>;
  available(binary: string): Promise<boolean>;
}
