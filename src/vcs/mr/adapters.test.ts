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

  it("reads whether a review request is open, landed, or closed without landing, from either CLI", async () => {
    const gh = fake('{"state":"MERGED"}\n');
    await expect(new GhMRAdapter(gh).state("https://github.com/owner/repo/pull/7")).resolves.toBe("merged");
    expect(gh.run).toHaveBeenCalledWith("gh", ["pr", "view", "https://github.com/owner/repo/pull/7", "--json", "state"]);
    await expect(new GhMRAdapter(fake('{"state":"OPEN"}')).state("u")).resolves.toBe("open");
    await expect(new GhMRAdapter(fake('{"state":"CLOSED"}')).state("u")).resolves.toBe("closed");

    const glab = fake('{"state":"merged"}');
    await expect(new GlabMRAdapter(glab).state("https://gitlab.com/o/r/-/merge_requests/3")).resolves.toBe("merged");
    expect(glab.run).toHaveBeenCalledWith("glab", ["mr", "view", "https://gitlab.com/o/r/-/merge_requests/3", "--output", "json"]);
    await expect(new GlabMRAdapter(fake('{"state":"opened"}')).state("u")).resolves.toBe("open");
    await expect(new GlabMRAdapter(fake('{"state":"closed"}')).state("u")).resolves.toBe("closed");
    await expect(new GlabMRAdapter(fake('{"state":"weird"}')).state("u")).rejects.toThrow(/unknown merge request state/);
    await expect(new GlabMRAdapter(fake("not json")).state("u")).rejects.toThrow(/did not return JSON/);
  });

  it("finds the open review request between two branches, or reports none, from either CLI", async () => {
    const query = { repository: "owner/repo", sourceBranch: "story/one", targetBranch: "main" };
    const gh = fake('[{"url":"https://github.com/owner/repo/pull/9"}]\n');
    await expect(new GhMRAdapter(gh).findOpen(query)).resolves.toBe("https://github.com/owner/repo/pull/9");
    expect(gh.run).toHaveBeenCalledWith("gh", [
      "pr", "list", "--repo", "owner/repo", "--head", "story/one", "--base", "main", "--state", "open", "--json", "url",
    ]);
    await expect(new GhMRAdapter(fake("[]")).findOpen(query)).resolves.toBeNull();

    const glab = fake('[{"web_url":"https://gitlab.com/o/r/-/merge_requests/5","state":"opened"}]');
    await expect(new GlabMRAdapter(glab).findOpen(query)).resolves.toBe("https://gitlab.com/o/r/-/merge_requests/5");
    expect(glab.run).toHaveBeenCalledWith("glab", [
      "mr", "list", "--repo", "owner/repo", "--source-branch", "story/one", "--target-branch", "main", "--output", "json",
    ]);
    await expect(new GlabMRAdapter(fake("[]")).findOpen(query)).resolves.toBeNull();
    await expect(new GlabMRAdapter(fake('{"web_url":"x"}')).findOpen(query)).rejects.toThrow(/no merge request list/);
    await expect(new GhMRAdapter(fake("not json")).findOpen(query)).rejects.toThrow(/did not return JSON/);
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
