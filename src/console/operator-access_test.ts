import { describe, expect, it } from "vitest";
import { decideConsoleAccess, type ConsoleNetworkRange } from "./operator-contract.js";

const ranges: ConsoleNetworkRange[] = [
  { id: "home", label: "Home network", cidrs: ["192.168.1.0/24"] },
  { id: "office", label: "Office network", cidrs: ["10.0.0.0/8", "203.0.113.10"] },
];

describe("console access boundary", () => {
  it("@scenario S-R237511MB-02-access admits a peer address inside an allowed network", () => {
    expect(decideConsoleAccess({ remoteAddress: "192.168.1.50", ranges, recheckPath: "/access" }))
      .toEqual({ allowed: true, networkId: "home" });
    expect(decideConsoleAccess({ remoteAddress: "10.20.30.40", ranges, recheckPath: "/access" }))
      .toEqual({ allowed: true, networkId: "office" });
  });

  it("@scenario S-R237511MB-02-access denies an outside peer with only the allowed ranges and a recheck", () => {
    const decision = decideConsoleAccess({ remoteAddress: "198.51.100.7", ranges, recheckPath: "/access" });

    expect(decision).toEqual({
      allowed: false,
      allowedNetworkLabels: ["Home network", "Office network"],
      recheckPath: "/access",
    });
    expect(Object.keys(decision).toSorted()).toEqual(["allowed", "allowedNetworkLabels", "recheckPath"]);
  });

  it("@scenario S-R237511MB-02-access treats a bare address as one host and fails closed on bad input", () => {
    expect(decideConsoleAccess({ remoteAddress: "203.0.113.10", ranges, recheckPath: "/access" }))
      .toEqual({ allowed: true, networkId: "office" });
    expect(decideConsoleAccess({ remoteAddress: "203.0.113.11", ranges, recheckPath: "/access" }))
      .toMatchObject({ allowed: false });
    expect(decideConsoleAccess({ remoteAddress: "not-an-address", ranges, recheckPath: "/access" }))
      .toMatchObject({ allowed: false });
  });
});
