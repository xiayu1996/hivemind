import { beforeEach, describe, expect, it } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { ConfigStore } from "../config/store.js";
import { migrate } from "../persistence/migrate.js";
import { planRepositoryStoryExecution, type SchedulableStory } from "./scheduler.js";

let client: Client;

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  await migrate(client);
});

const stories: readonly SchedulableStory[] = [
  { id: "S-ROUTES", dependsOn: [], predictedFootprint: ["src/routes/checkout"] },
  { id: "S-COPY", dependsOn: [], predictedFootprint: ["src/i18n/checkout"] },
];

describe("repository scheduling", () => {
  it("S-M2-04-serial separates disjoint stories that share a configured hotspot", async () => {
    const config = await ConfigStore.load(client, { repository: "acme/storefront" });
    await config.set("schedule.hotspotPaths", ["src"], "maintainer");

    await expect(planRepositoryStoryExecution(config, stories)).resolves.toEqual({
      kind: "planned",
      batches: [["S-ROUTES"], ["S-COPY"]],
    });
  });

  it("S-M2-04-clear uses a removed hotspot list on the next scheduling decision", async () => {
    const maintainerConfig = await ConfigStore.load(client, { repository: "acme/storefront" });
    await maintainerConfig.set("schedule.hotspotPaths", ["src"], "maintainer");
    const schedulerConfig = await ConfigStore.load(client, { repository: "acme/storefront" });
    await expect(planRepositoryStoryExecution(schedulerConfig, stories)).resolves.toMatchObject({
      batches: [["S-ROUTES"], ["S-COPY"]],
    });

    await maintainerConfig.set("schedule.hotspotPaths", [], "maintainer");

    await expect(planRepositoryStoryExecution(schedulerConfig, stories)).resolves.toEqual({
      kind: "planned",
      batches: [["S-ROUTES", "S-COPY"]],
    });
  });
});
