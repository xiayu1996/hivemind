import { createClient } from "@libsql/client";
import { describe, expect, it } from "vitest";
import { ConfigStore } from "../config/store.js";
import { migrate } from "../persistence/migrate.js";
import { assertOutOfBandChannel } from "./required-channel.js";
import { AlertRouter } from "./index.js";

async function config(): Promise<ConfigStore> {
  const client = createClient({ url: ":memory:" });
  await migrate(client);
  return ConfigStore.load(client);
}

const channel = { name: "feishu", send: async () => undefined };

describe("assertOutOfBandChannel", () => {
  it("refuses to start with no channel, because a Notion mention raises no push", async () => {
    await expect(assertOutOfBandChannel(new AlertRouter([]), await config()))
      .rejects.toThrow(/out-of-band/);
  });

  it("starts once a channel exists", async () => {
    await expect(assertOutOfBandChannel(new AlertRouter([channel]), await config())).resolves.toBeUndefined();
  });

  it("lets an operator opt out deliberately, and says so", async () => {
    const store = await config();
    await store.set("alert.requireOutOfBandChannel", false, "test");
    const warnings: string[] = [];

    await expect(assertOutOfBandChannel(new AlertRouter([]), store, (line) => warnings.push(line)))
      .resolves.toBeUndefined();
    expect(warnings.join(" ")).toMatch(/no out-of-band/i);
  });
});
