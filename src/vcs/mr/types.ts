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

export interface MRPort {
  create(input: MergeRequestInput): Promise<MergeRequestResult>;
}

/** Answers whether the review request at a URL has landed on its target. */
export interface MergeRequestStatePort {
  isMerged(url: string): Promise<boolean>;
}

export interface CliResult {
  stdout: string;
  stderr: string;
}

export interface CliExecutor {
  run(binary: string, args: string[]): Promise<CliResult>;
  available(binary: string): Promise<boolean>;
}
