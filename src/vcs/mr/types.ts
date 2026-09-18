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

/**
 * Lands a review request that a person has already approved elsewhere.
 *
 * Only the interface contract goes through here. A Story's own request is a
 * person's to merge; the contract is not, because approving the solution is
 * approving it -- and every later card reads it off the target branch, so a
 * contract left on its own branch is a contract no card can see.
 */
export interface MergeRequestLandPort {
  land(url: string): Promise<void>;
}

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
