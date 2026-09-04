import { processCliExecutor } from "./cli.js";
import type { CliExecutor, MergeRequestInput, MergeRequestResult, MergeRequestStatePort, MRPort } from "./types.js";

function extractUrl(output: string): string {
  const match = output.match(/https:\/\/[^\s]+/);
  if (!match) throw new Error("MR CLI did not return a URL");
  return match[0].replace(/[),.;]+$/, "");
}

function stateOf(output: string, cli: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error(`${cli} did not return JSON for the merge request state`);
  }
  const state = (parsed as { state?: unknown })?.state;
  if (typeof state !== "string") throw new Error(`${cli} returned no merge request state`);
  return state;
}

export class GhMRAdapter implements MRPort, MergeRequestStatePort {
  constructor(private readonly cli: CliExecutor = processCliExecutor) {}

  async isMerged(url: string): Promise<boolean> {
    const result = await this.cli.run("gh", ["pr", "view", url, "--json", "state"]);
    return stateOf(result.stdout, "gh") === "MERGED";
  }

  async create(input: MergeRequestInput): Promise<MergeRequestResult> {
    const args = [
      "pr", "create",
      "--repo", input.repository,
      "--head", input.sourceBranch,
      "--base", input.targetBranch,
      "--title", input.title,
      "--body", input.body,
    ];
    if (input.draft) args.push("--draft");
    const result = await this.cli.run("gh", args);
    return { url: extractUrl(result.stdout), provider: "github" };
  }
}

export class GlabMRAdapter implements MRPort, MergeRequestStatePort {
  constructor(private readonly cli: CliExecutor = processCliExecutor) {}

  async isMerged(url: string): Promise<boolean> {
    const result = await this.cli.run("glab", ["mr", "view", url, "--output", "json"]);
    return stateOf(result.stdout, "glab") === "merged";
  }

  async create(input: MergeRequestInput): Promise<MergeRequestResult> {
    const args = [
      "mr", "create",
      "--repo", input.repository,
      "--source-branch", input.sourceBranch,
      "--target-branch", input.targetBranch,
      "--title", input.title,
      "--description", input.body,
      "--yes",
    ];
    if (input.draft) args.push("--draft");
    const result = await this.cli.run("glab", args);
    return { url: extractUrl(result.stdout), provider: "gitlab" };
  }
}

/** Selects gh first, then glab, so deployment images may carry either provider CLI. */
export async function discoverMRPort(cli: CliExecutor = processCliExecutor): Promise<MRPort & MergeRequestStatePort> {
  if (await cli.available("gh")) return new GhMRAdapter(cli);
  if (await cli.available("glab")) return new GlabMRAdapter(cli);
  throw new Error("neither gh nor glab is installed");
}
