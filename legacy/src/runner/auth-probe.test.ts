import { describe, expect, it } from "vitest";
import { parseAuthProbeOutput } from "./auth-probe.js";

describe("credential probe contract", () => {
  it("treats status rather than exit code as readiness", () => {
    const response = parseAuthProbeOutput(JSON.stringify({
      status: "not_ready",
      provider: "openai-codex",
      reason: "credentials_not_configured",
    }), "openai-codex");
    expect(response).toEqual({
      ready: false,
      provider: "openai-codex",
      reason: "credentials_not_configured",
    });
  });
});
