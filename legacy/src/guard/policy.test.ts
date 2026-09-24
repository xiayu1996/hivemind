import { describe, expect, it } from "vitest";
import {
  GuardPolicyError,
  POLICY_ENV_VAR,
  assembleGuardPolicy,
  compileFencedPatterns,
  parseGuardPolicy,
  serializeGuardPolicy,
  type GuardPolicy,
} from "./policy.js";

const policy: GuardPolicy = {
  phase: "VERIFY",
  cardId: "S-12",
  runId: "run-1",
  worktreePath: "/wt/task-1",
  extraWriteRoots: ["/ev/card-12"],
  disallowedTools: ["write", "edit"],
  fencedPatterns: ["(^|/)secrets/"],
  bannedBash: ["\\bgit\\s+commit\\b"],
  auditPath: "/audit/tool-audit.jsonl",
  e2eHostAllowlist: ["localhost"],
  toolOutputLimits: { maxBytes: 51200, maxLines: 2000 },
};

describe("round trip", () => {
  it("survives serialisation unchanged", () => {
    expect(parseGuardPolicy(serializeGuardPolicy(policy))).toEqual(policy);
  });

  it("names the environment variable the runner and extension agree on", () => {
    expect(POLICY_ENV_VAR).toBe("PI_GUARD_POLICY");
  });
});

describe("rejection", () => {
  it("rejects malformed JSON", () => {
    expect(() => parseGuardPolicy("{oops")).toThrow(GuardPolicyError);
  });

  it("rejects a non-object policy", () => {
    for (const raw of ['"x"', "[]", "null", "3"]) {
      expect(() => parseGuardPolicy(raw)).toThrow(GuardPolicyError);
    }
  });

  it("rejects a missing or empty required field instead of defaulting it", () => {
    // A guard that fills in its own defaults cannot be told apart from one that
    // was configured, which is why every field is required.
    for (const key of ["phase", "cardId", "runId", "worktreePath", "auditPath"]) {
      const broken = { ...policy, [key]: "" };
      expect(() => parseGuardPolicy(JSON.stringify(broken))).toThrow(GuardPolicyError);
      const missing: Record<string, unknown> = { ...policy };
      delete missing[key];
      expect(() => parseGuardPolicy(JSON.stringify(missing))).toThrow(GuardPolicyError);
    }
  });

  it("rejects a list field that is not a list of strings", () => {
    for (const key of ["extraWriteRoots", "disallowedTools", "fencedPatterns", "bannedBash", "e2eHostAllowlist"]) {
      expect(() => parseGuardPolicy(JSON.stringify({ ...policy, [key]: "x" }))).toThrow(GuardPolicyError);
      expect(() => parseGuardPolicy(JSON.stringify({ ...policy, [key]: [1] }))).toThrow(GuardPolicyError);
    }
  });

  it("accepts empty lists", () => {
    const bare = {
      ...policy,
      extraWriteRoots: [],
      disallowedTools: [],
      fencedPatterns: [],
      bannedBash: [],
      e2eHostAllowlist: [],
    };
    expect(parseGuardPolicy(JSON.stringify(bare))).toEqual(bare);
  });
});

describe("phase assembly", () => {
  const base = {
    cardId: "S-12",
    runId: "run-1",
    worktreePath: "/wt/task-1",
    evidencePath: "/ev/card-12",
    auditPath: "/audit/tool-audit.jsonl",
  };

  it("makes VERIFY read-only while preserving its evidence root", () => {
    const assembled = assembleGuardPolicy({ ...base, phase: "VERIFY" });
    expect(assembled.extraWriteRoots).toEqual([base.evidencePath]);
    expect(assembled.disallowedTools).toEqual(expect.arrayContaining(["write", "edit", "powershell"]));
    expect(assembled.bannedBash).toHaveLength(4);
  });

  it("keeps CODE writable apart from unconditional red lines", () => {
    const assembled = assembleGuardPolicy({ ...base, phase: "CODE" });
    expect(assembled.disallowedTools).toEqual([]);
    expect(assembled.bannedBash).toEqual([]);
  });

  it("is byte-stable for the same input", () => {
    const input = { ...base, phase: "VERIFY" as const, fencedPatterns: ["z", "a", "z"] };
    expect(serializeGuardPolicy(assembleGuardPolicy(input))).toBe(
      serializeGuardPolicy(assembleGuardPolicy(input)),
    );
    expect(assembleGuardPolicy(input).fencedPatterns).toEqual(["a", "z"]);
  });
});

describe("fenced pattern compilation", () => {
  it("compiles case-insensitively so a casing variant cannot slip past", () => {
    const patterns = compileFencedPatterns(["(^|/)secrets/"]);
    expect(patterns).toHaveLength(1);
    expect(patterns[0]?.test("SECRETS/key.pem")).toBe(true);
  });

  it("reports an invalid pattern instead of dropping it", () => {
    expect(() => compileFencedPatterns(["(unclosed"])).toThrow(GuardPolicyError);
  });
});
