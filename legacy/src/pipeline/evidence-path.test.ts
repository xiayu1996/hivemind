import { describe, expect, it } from "vitest";
import { evidenceCandidates } from "./evidence-path.js";

const ROUND = "/work/evidence/story-1/story-1-verify-5-abc";

describe("evidenceCandidates", () => {
  it("takes a bare file name as the round's own directory", () => {
    expect(evidenceCandidates(ROUND, "page-1.yml")).toEqual([`${ROUND}/page-1.yml`]);
  });

  it("also offers the file a session spelled from one level up", () => {
    expect(evidenceCandidates(ROUND, "story-1-verify-5-abc/page-1.yml")).toEqual([
      `${ROUND}/story-1-verify-5-abc/page-1.yml`,
      `${ROUND}/page-1.yml`,
    ]);
  });

  it("leaves a path that climbs out of the root for the caller to refuse", () => {
    expect(evidenceCandidates(ROUND, "../other/page-1.yml")).toEqual([
      "/work/evidence/story-1/other/page-1.yml",
    ]);
  });
});
