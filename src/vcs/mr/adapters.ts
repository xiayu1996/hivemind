import { processCliExecutor } from "./cli.js";
import type {
  CliExecutor, MergeRequestInput, MergeRequestResult, MergeRequestState, MergeRequestStatePort, MRPort, OpenMergeRequestQuery,
} from "./types.js";

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

/** Both CLIs list review requests as a JSON array; the first entry's URL field
 * is the one to reuse. Anything but an array is an error, not "none open". */
function firstListedUrl(output: string, cli: string, field: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error(`${cli} did not return JSON for the merge request list`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${cli} returned no merge request list`);
  const url = (parsed[0] as Record<string, unknown> | undefined)?.[field];
  return typeof url === "string" ? url : null;
}

/** gh reports OPEN/MERGED/CLOSED, glab reports opened/merged/closed/locked; an
 * unknown word is an error rather than a guess at whether the review landed. */
function normaliseState(raw: string, cli: string): MergeRequestState {
  switch (raw.toLowerCase()) {
    case "open":
    case "opened":
    case "locked":
      return "open";
    case "merged":
      return "merged";
    case "closed":
      return "closed";
    default:
      throw new Error(`${cli} returned an unknown merge request state: ${raw}`);
  }
}

export class GhMRAdapter implements MRPort, MergeRequestStatePort {
  constructor(private readonly cli: CliExecutor = processCliExecutor) {}

  async state(url: string): Promise<MergeRequestState> {
    const result = await this.cli.run("gh", ["pr", "view", url, "--json", "state"]);
    return normaliseState(stateOf(result.stdout, "gh"), "gh");
  }

  async findOpen(query: OpenMergeRequestQuery): Promise<string | null> {
    const result = await this.cli.run("gh", [
      "pr", "list", "--repo", query.repository, "--head", query.sourceBranch, "--base", query.targetBranch,
      "--state", "open", "--json", "url",
    ]);
    return firstListedUrl(result.stdout, "gh", "url");
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

  async state(url: string): Promise<MergeRequestState> {
    const result = await this.cli.run("glab", ["mr", "view", url, "--output", "json"]);
    return normaliseState(stateOf(result.stdout, "glab"), "glab");
  }

  async findOpen(query: OpenMergeRequestQuery): Promise<string | null> {
    const result = await this.cli.run("glab", [
      "mr", "list", "--repo", query.repository, "--source-branch", query.sourceBranch,
      "--target-branch", query.targetBranch, "--output", "json",
    ]);
    return firstListedUrl(result.stdout, "glab", "web_url");
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
