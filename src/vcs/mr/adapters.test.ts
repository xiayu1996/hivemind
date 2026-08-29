import { describe, expect, it, vi } from "vitest";
import { GhMRAdapter, GlabMRAdapter, discoverMRPort } from "./adapters.js";
import type { CliExecutor, MergeRequestInput } from "./types.js";

const input: MergeRequestInput = {
  repository: "owner/repo",
  sourceBranch: "story/one",
  targetBranch: "main",
  title: "Deliver story one",
  body: "Verified scenarios",
  draft: true,
};

function fake(stdout: string): CliExecutor & { run: ReturnType<typeof vi.fn>; available: ReturnType<typeof vi.fn> } {
  return {
    run: vi.fn(async () => ({ stdout, stderr: "" })),
    available: vi.fn(async () => false),
  };
}

describe("MR CLI adapters", () => {
  it("maps MRPort input to gh without invoking a shell", async () => {
    const cli = fake("https://github.com/owner/repo/pull/7\n");
    await expect(new GhMRAdapter(cli).create(input)).resolves.toEqual({
      url: "https://github.com/owner/repo/pull/7",
      provider: "github",
    });
    expect(cli.run).toHaveBeenCalledWith("gh", [
      "pr", "create", "--repo", "owner/repo", "--head", "story/one", "--base", "main",
      "--title", "Deliver story one", "--body", "Verified scenarios", "--draft",
    ]);
  });

  it("maps MRPort input to glab", async () => {
    const cli = fake("Created merge request: https://gitlab.com/owner/repo/-/merge_requests/3\n");
    await expect(new GlabMRAdapter(cli).create(input)).resolves.toEqual({
      url: "https://gitlab.com/owner/repo/-/merge_requests/3",
      provider: "gitlab",
    });
    expect(cli.run).toHaveBeenCalledWith("glab", [
      "mr", "create", "--repo", "owner/repo", "--source-branch", "story/one",
      "--target-branch", "main", "--title", "Deliver story one",
      "--description", "Verified scenarios", "--yes", "--draft",
    ]);
  });

  it("prefers gh and falls back to glab", async () => {
    const cli = fake("");
    cli.available.mockImplementation(async (binary: string) => binary === "glab");
    await expect(discoverMRPort(cli)).resolves.toBeInstanceOf(GlabMRAdapter);
    expect(cli.available).toHaveBeenNthCalledWith(1, "gh");
    expect(cli.available).toHaveBeenNthCalledWith(2, "glab");
  });

  it("fails loudly when no supported CLI exists", async () => {
    await expect(discoverMRPort(fake(""))).rejects.toThrow(/neither gh nor glab/);
  });
});
