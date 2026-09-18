import { describe, expect, it } from "vitest";
import { planDispatchAcrossRepositories } from "./repository-dispatch.js";

const story = (id: string, overrides: Partial<{ state: string; dependsOn: string[]; predictedFootprint: string[] }> = {}) => ({
  id,
  state: overrides.state ?? "QUEUED",
  dependsOn: overrides.dependsOn ?? [],
  predictedFootprint: overrides.predictedFootprint ?? [`src/${id}.ts`],
});

describe("planDispatchAcrossRepositories", () => {
  it("gives every repository a slot in the same cycle", () => {
    const plan = planDispatchAcrossRepositories([
      { slug: "acme/widget", stories: [story("S-A-01"), story("S-A-02")], hotspotPaths: [] },
      { slug: "acme/gadget", stories: [story("S-B-01")], hotspotPaths: [] },
    ]);
    expect(plan.batch).toEqual([
      { slug: "acme/widget", cardId: "S-A-01" },
      { slug: "acme/widget", cardId: "S-A-02" },
      { slug: "acme/gadget", cardId: "S-B-01" },
    ]);
  });

  it("dispatches one card into a repository that has no interface contract yet", () => {
    const plan = planDispatchAcrossRepositories([
      {
        slug: "acme/widget",
        stories: [story("S-A-01"), story("S-A-02")],
        hotspotPaths: [],
        hasInterfaceContract: false,
      },
      { slug: "acme/gadget", stories: [story("S-B-01"), story("S-B-02")], hotspotPaths: [] },
    ]);

    expect(plan.batch).toEqual([
      { slug: "acme/widget", cardId: "S-A-01" },
      { slug: "acme/gadget", cardId: "S-B-01" },
      { slug: "acme/gadget", cardId: "S-B-02" },
    ]);
  });

  it("serialises Stories that share a hotspot only inside their own repository", () => {
    const plan = planDispatchAcrossRepositories([
      {
        slug: "acme/widget",
        stories: [story("S-A-01", { predictedFootprint: ["src/db"] }), story("S-A-02", { predictedFootprint: ["src/db"] })],
        hotspotPaths: ["src/db"],
      },
      {
        slug: "acme/gadget",
        stories: [story("S-B-01", { predictedFootprint: ["src/db"] })],
        hotspotPaths: ["src/db"],
      },
    ]);
    // The hotspot belongs to a repository's tree; a same-named path in another
    // repository is a different file.
    expect(plan.batch).toEqual([
      { slug: "acme/widget", cardId: "S-A-01" },
      { slug: "acme/gadget", cardId: "S-B-01" },
    ]);
  });

  it("keeps a broken dependency graph inside the repository that has it", () => {
    const plan = planDispatchAcrossRepositories([
      {
        slug: "acme/widget",
        stories: [story("S-A-01", { dependsOn: ["S-A-02"] }), story("S-A-02", { dependsOn: ["S-A-01"] })],
        hotspotPaths: [],
      },
      { slug: "acme/gadget", stories: [story("S-B-01")], hotspotPaths: [] },
    ]);
    expect(plan.cycles).toEqual([{ slug: "acme/widget", cycle: expect.arrayContaining(["S-A-01", "S-A-02"]) }]);
    expect(plan.batch).toEqual([{ slug: "acme/gadget", cardId: "S-B-01" }]);
  });

  it("does not let a Story wait on an id its own repository does not hold", () => {
    // Dependencies are declared inside an Epic, and an Epic lives in one
    // repository; an id from elsewhere is not a constraint this plan can
    // honour, so it is dropped rather than stranding the card forever.
    const plan = planDispatchAcrossRepositories([
      { slug: "acme/widget", stories: [story("S-A-01", { dependsOn: ["S-B-01"] }), story("S-A-02")], hotspotPaths: [] },
      { slug: "acme/gadget", stories: [story("S-B-01")], hotspotPaths: [] },
    ]);
    expect(plan.stranded).toEqual([]);
    expect(plan.batch).toEqual([
      { slug: "acme/widget", cardId: "S-A-01" },
      { slug: "acme/widget", cardId: "S-A-02" },
      { slug: "acme/gadget", cardId: "S-B-01" },
    ]);
  });

  it("plans nothing for a repository with no dispatchable Story", () => {
    const plan = planDispatchAcrossRepositories([
      { slug: "acme/widget", stories: [story("S-A-01", { state: "DELIVERED" })], hotspotPaths: [] },
    ]);
    expect(plan).toEqual({ batch: [], cycles: [], stranded: [] });
  });
});
