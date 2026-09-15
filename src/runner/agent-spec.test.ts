import { beforeEach, describe, expect, it } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { ConfigStore } from "../config/store.js";
import { MODEL_PURPOSES, type ModelPurpose } from "../pipeline/phase.js";
import { migrate } from "../persistence/migrate.js";
import { resolveModel } from "./model-resolver.js";
import {
  assertAgentSpecs,
  DEFAULT_AGENT_TOOLS,
  resolveAgentSpec,
  type AgentModelPolicy,
} from "./agent-spec.js";

let client: Client;

async function policy(over: Partial<AgentModelPolicy> = {}): Promise<AgentModelPolicy> {
  const model = await resolveModel({ list: async () => [{ provider: "mock", id: "mock-1" }] }, "mock", "mock-1");
  return {
    resolve: async () => model,
    providersFor: async () => ["mock"],
    tierOf: async () => "standard",
    isMetered: async () => false,
    ...over,
  };
}

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  await migrate(client);
});

describe("resolving one spawn", () => {
  it("answers every declared call site on the providers its tier allows", async () => {
    const sources = { config: ConfigStore.defaults(), policy: await policy() };

    for (const purpose of MODEL_PURPOSES) {
      const spec = await resolveAgentSpec(sources, purpose, "mock");
      expect(spec.purpose).toBe(purpose);
      expect(spec.model.id).toBe("mock-1");
    }
  });

  it("carries the tier and the billing answer of the provider this attempt runs on", async () => {
    const spec = await resolveAgentSpec(
      { config: ConfigStore.defaults(), policy: await policy({ tierOf: async () => "brain", isMetered: async () => true }) },
      "shape",
      "mock",
    );

    expect(spec.tier).toBe("brain");
    expect(spec.metered).toBe(true);
  });

  it("gives every Story phase the same tool block, sorted, so the cached prefix is a function of the config", async () => {
    const sources = { config: ConfigStore.defaults(), policy: await policy() };
    const storyPhases: ModelPurpose[] = ["shape", "design", "specify", "code", "verify", "merge", "triage"];

    const blocks = await Promise.all(storyPhases.map(async (purpose) =>
      (await resolveAgentSpec(sources, purpose, "mock")).tools.join(",")));

    expect(new Set(blocks).size).toBe(1);
    expect(blocks[0]).toBe([...DEFAULT_AGENT_TOOLS].toSorted().join(","));
  });

  it("keeps the two call sites that only produce text away from the write tools", async () => {
    const sources = { config: ConfigStore.defaults(), policy: await policy() };

    for (const purpose of ["product_manager", "decompose"] as ModelPurpose[]) {
      const spec = await resolveAgentSpec(sources, purpose, "mock");
      expect(spec.tools).not.toContain("write");
      expect(spec.tools).not.toContain("edit");
    }
  });

  it("lets one purpose opt out of the shared tool set without moving the others", async () => {
    const config = await ConfigStore.load(client);
    await config.set("agent.purposeTools", { ui_review: ["read", "bash", "read"] }, "agent-spec test");
    const sources = { config, policy: await policy() };

    const reviewer = await resolveAgentSpec(sources, "ui_review", "mock");
    const coder = await resolveAgentSpec(sources, "code", "mock");

    expect(reviewer.tools).toEqual(["bash", "read"]);
    expect(coder.tools).toEqual([...DEFAULT_AGENT_TOOLS].toSorted());
  });

  it("keeps an overlay that names a single purpose from wiping the rest of the key", async () => {
    const config = await ConfigStore.load(client);
    await config.set("agent.purposeLimits", { code: { promptTimeoutMs: 1_800_000 } }, "agent-spec test");
    const sources = { config, policy: await policy() };

    expect((await resolveAgentSpec(sources, "code", "mock")).limits).toEqual({ promptTimeoutMs: 1_800_000 });
    expect((await resolveAgentSpec(sources, "specify", "mock")).limits).toEqual({});
  });

  it("reads the current overlay rather than the one the process started with", async () => {
    const config = await ConfigStore.load(client);
    const sources = { config, policy: await policy() };
    expect((await resolveAgentSpec(sources, "code", "mock")).skills).toEqual([]);

    const other = await ConfigStore.load(client);
    await other.set("agent.purposeSkills", { code: ["repo-conventions"] }, "agent-spec test");

    expect((await resolveAgentSpec(sources, "code", "mock")).skills).toEqual(["repo-conventions"]);
  });

  it("reports the provider that failed rather than falling back to another model", async () => {
    const sources = {
      config: ConfigStore.defaults(),
      policy: await policy({ resolve: async () => { throw new Error("mock serves no model in this tier"); } }),
    };

    await expect(resolveAgentSpec(sources, "code", "mock")).rejects.toThrow("mock serves no model in this tier");
  });
});

describe("the startup gate", () => {
  it("passes when every purpose resolves on every provider of its tier", async () => {
    await expect(assertAgentSpecs({ config: ConfigStore.defaults(), policy: await policy() })).resolves.toBeUndefined();
  });

  it("names the purpose whose tier no provider serves", async () => {
    const sources = {
      config: ConfigStore.defaults(),
      policy: await policy({ providersFor: async (purpose: ModelPurpose) => (purpose === "shape" ? [] : ["mock"]) }),
    };

    await expect(assertAgentSpecs(sources)).rejects.toThrow("shape: no provider in the failover chain serves its tier");
  });

  it("names the purpose and provider a resolution failed on, not just that something failed", async () => {
    const sources = {
      config: ConfigStore.defaults(),
      policy: await policy({
        resolve: async (purpose: ModelPurpose) => {
          if (purpose === "specify") throw new Error("no model id");
          return await resolveModel({ list: async () => [{ provider: "mock", id: "mock-1" }] }, "mock", "mock-1");
        },
      }),
    };

    await expect(assertAgentSpecs(sources)).rejects.toThrow("specify/mock: no model id");
  });
});
