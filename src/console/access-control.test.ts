import { describe, expect, it } from "vitest";
import { CONFIG_KEYS } from "../config/registry.js";
import type {
  ConsoleAccessPage,
  ConsoleAccessPageState,
  ConsoleAccessPolicy,
} from "./access-control.js";

const ACCESS_VERIFICATION = "\u8bbf\u95ee\u9a8c\u8bc1";
const UNAVAILABLE = "\u65e0\u6cd5\u8bbf\u95ee";
const DEVICE_DENIED = "\u5f53\u524d\u8bbe\u5907\u65e0\u6cd5\u8fdb\u5165\u540e\u53f0";
const NETWORK_GUIDANCE = "\u5bb6\u5ead\u6216\u529e\u516c\u7f51\u7edc";
const RETRY_NETWORK = "\u91cd\u65b0\u68c0\u67e5\u7f51\u7edc";
const OVERVIEW = "\u8fd0\u884c\u603b\u89c8";
const TODO = "\u7b49\u5f85\u672c\u4eba\u5904\u7406";
const COST = "\u8d39\u7528";
const CONFIG = "\u914d\u7f6e";
const RECORDS = "\u5de5\u4f5c\u8bb0\u5f55";

async function policyContract(): Promise<(config: { allowedNetworks: readonly string[] }) => ConsoleAccessPolicy> {
  const contract = await import("./access-control.js");
  expect(contract.createConsoleAccessPolicy).toEqual(expect.any(Function));
  return contract.createConsoleAccessPolicy;
}

async function pageContract(): Promise<() => ConsoleAccessPage> {
  const contract = await import("./access-control.js");
  expect(contract.createConsoleAccessPage).toEqual(expect.any(Function));
  return contract.createConsoleAccessPage;
}

describe("console network policy", () => {
  it("@scenario S-R237511OV-02-allowed permits both explicitly configured networks", async () => {
    const createPolicy = await policyContract();
    const policy = createPolicy({ allowedNetworks: ["192.0.2.0/24", "2001:db8:1200::/48"] });

    expect(policy.authorize({ remoteAddress: "192.0.2.45" })).toEqual({
      allowed: true,
      matchedNetwork: "192.0.2.0/24",
    });
    expect(policy.authorize({ remoteAddress: "2001:db8:1200::45" })).toEqual({
      allowed: true,
      matchedNetwork: "2001:db8:1200::/48",
    });
  });

  it("@scenario S-R237511OV-02-allowed includes CIDR endpoints without admitting adjacent addresses", async () => {
    const createPolicy = await policyContract();
    const policy = createPolicy({ allowedNetworks: ["198.51.100.8/30"] });

    expect(policy.authorize({ remoteAddress: "198.51.100.8" }).allowed).toBe(true);
    expect(policy.authorize({ remoteAddress: "198.51.100.11" }).allowed).toBe(true);
    expect(policy.authorize({ remoteAddress: "198.51.100.7" })).toEqual({
      allowed: false,
      reason: "source_outside_allowed_networks",
    });
    expect(policy.authorize({ remoteAddress: "198.51.100.12" })).toEqual({
      allowed: false,
      reason: "source_outside_allowed_networks",
    });
  });

  it("@scenario S-R237511OV-02-unconfigured denies every source when no ranges are configured", async () => {
    const createPolicy = await policyContract();
    const policy = createPolicy({ allowedNetworks: [] });

    for (const remoteAddress of ["127.0.0.1", "10.1.2.3", "192.168.1.8", "2001:db8::8"]) {
      expect(policy.authorize({ remoteAddress })).toEqual({
        allowed: false,
        reason: "allowed_networks_unconfigured",
      });
    }
  });

  it("@scenario S-R237511OV-02-unconfigured fails closed when the peer source is unavailable", async () => {
    const createPolicy = await policyContract();
    const policy = createPolicy({ allowedNetworks: ["192.168.50.0/24"] });

    expect(policy.authorize({ remoteAddress: null })).toEqual({
      allowed: false,
      reason: "source_unavailable",
    });
    expect(policy.authorize({ remoteAddress: "not-an-address" })).toEqual({
      allowed: false,
      reason: "source_unavailable",
    });
  });

  it("@scenario S-R237511OV-02-unconfigured registers a deny-all default and rejects malformed ranges", () => {
    const definition = Reflect.get(CONFIG_KEYS, "console.allowedNetworks") as
      | { default: unknown; scope: string; reload: string; schema: { safeParse(value: unknown): { success: boolean } } }
      | undefined;

    expect(definition).toBeDefined();
    expect(definition?.default).toEqual([]);
    expect(definition).toMatchObject({ scope: "global", reload: "drain-restart" });
    expect(definition?.schema.safeParse(["192.168.50.0/24"]).success).toBe(true);
    expect(definition?.schema.safeParse(["192.168.50.0/99"]).success).toBe(false);
    expect(definition?.schema.safeParse(["anything"]).success).toBe(false);
  });
});

