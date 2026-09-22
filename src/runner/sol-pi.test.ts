import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { ConfigStore } from "../config/store.js";
import { migrate } from "../persistence/migrate.js";
import { resolveAgentSpec, type AgentModelPolicy } from "./agent-spec.js";
import { resolveModel } from "./model-resolver.js";
import {
  installSolPiConfig,
  OBSERVATION_PACK_TOOL,
  pinnedSolPiRef,
  renderSolPiConfig,
  solPiConfigPath,
  solPiExtensionPath,
} from "./sol-pi.js";

async function workDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "sol-pi-"));
}

let client: Client;

async function policy(): Promise<AgentModelPolicy> {
  const model = await resolveModel({ list: async () => [{ provider: "mock", id: "mock-1" }] }, "mock", "mock-1");
  return {
    resolve: async () => model,
    providersFor: async () => ["mock"],
    tierOf: async () => "standard",
    isMetered: async () => false,
  };
}

async function specWith(solPi: unknown, configPath?: string) {
  const config = await ConfigStore.load(client);
  await config.set("agent.solPi", solPi, "sol-pi test");
  return resolveAgentSpec(
    { config, policy: await policy(), ...(configPath ? { solPiConfigPath: configPath } : {}) },
    "code",
    "mock",
  );
}

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  await migrate(client);
});

describe("the mechanism file handed to SoL-Pi", () => {
  it("writes the two mechanisms hivemind does not run as explicitly off", () => {
    const rendered = JSON.parse(renderSolPiConfig({ actionFusion: true, observationPack: true }));
    expect(rendered.evidencePreservingReducer).toBe(false);
    expect(rendered.onlineContextCompact).toBe(false);
  });

  it("names no reducer route, so no log can leave the host through one", () => {
    const rendered = renderSolPiConfig({ actionFusion: true, observationPack: true });
    expect(rendered).not.toContain("evidencePreservingReducerProvider");
    expect(rendered).not.toContain("evidencePreservingReducerModel");
  });

  it("declares the schema version SoL-Pi checks before it loads", () => {
    expect(JSON.parse(renderSolPiConfig({ actionFusion: false, observationPack: false })).version).toBe(1);
  });

  it("renders the same bytes for the same selection", () => {
    const once = renderSolPiConfig({ actionFusion: true, observationPack: false });
    expect(renderSolPiConfig({ actionFusion: true, observationPack: false })).toBe(once);
  });
});

describe("installing that file", () => {
  it("creates it, readable only by the account that spawns pi", async () => {
    const path = join(await workDir(), "agent", "sol-pi.json");
    const contents = renderSolPiConfig({ actionFusion: true, observationPack: true });
    expect(await installSolPiConfig(contents, path)).toBe("written");
    expect(await readFile(path, "utf8")).toBe(contents);
    expect((await stat(path)).mode & 0o077).toBe(0);
  });

  it("writes nothing when the selection has not moved", async () => {
    const path = join(await workDir(), "sol-pi.json");
    const contents = renderSolPiConfig({ actionFusion: true, observationPack: false });
    await installSolPiConfig(contents, path);
    expect(await installSolPiConfig(contents, path)).toBe("unchanged");
  });

  it("replaces a file another selection left behind", async () => {
    const path = join(await workDir(), "sol-pi.json");
    await writeFile(path, renderSolPiConfig({ actionFusion: false, observationPack: false }));
    const next = renderSolPiConfig({ actionFusion: true, observationPack: true });
    expect(await installSolPiConfig(next, path)).toBe("written");
    expect(await readFile(path, "utf8")).toBe(next);
  });
});

describe("where the extension is found", () => {
  it("carries the pinned commit in its path, so two pins can coexist on a host", () => {
    expect(solPiExtensionPath("abc123")).toContain("abc123");
    expect(solPiExtensionPath("abc123")).toMatch(/src[/\\]sol-pi[/\\]index\.ts$/);
  });

  it("takes the pin from the manifest, which is the only place a ref is written", () => {
    expect(solPiExtensionPath()).toContain(pinnedSolPiRef());
  });

  it("puts the configuration where pi reads its agent files", () => {
    expect(solPiConfigPath("/home/x")).toBe("/home/x/.pi/agent/sol-pi.json");
  });
});

describe("what a spawn is told", () => {
  it("runs neither mechanism until a host turns one on", async () => {
    const spec = await resolveAgentSpec({ config: ConfigStore.defaults(), policy: await policy() }, "code", "mock");
    expect(spec.solPi).toEqual({ actionFusion: false, observationPack: false });
    expect(spec.tools).not.toContain(OBSERVATION_PACK_TOOL);
  });

  it("adds the recall tool exactly when the mechanism that creates handles is on", async () => {
    const spec = await specWith({ actionFusion: true, observationPack: true });
    expect(spec.tools).toContain(OBSERVATION_PACK_TOOL);
  });

  it("leaves the recall tool out when only the fusion mechanism is on", async () => {
    const spec = await specWith({ actionFusion: true, observationPack: false });
    expect(spec.tools).not.toContain(OBSERVATION_PACK_TOOL);
  });

  it("keeps the tool block sorted, because it leads the cached prefix", async () => {
    const spec = await specWith({ actionFusion: false, observationPack: true });
    expect([...spec.tools]).toEqual([...spec.tools].toSorted());
  });

  it("writes the file before the spawn when a host path is given", async () => {
    const path = join(await workDir(), "sol-pi.json");
    await specWith({ actionFusion: true, observationPack: false }, path);
    expect(JSON.parse(await readFile(path, "utf8")).actionFusion).toBe(true);
  });

  it("carries the stored selection onto the spec, which is what decides the extension list", async () => {
    const spec = await specWith({ actionFusion: true, observationPack: false });
    expect(spec.solPi).toEqual({ actionFusion: true, observationPack: false });
  });
});
