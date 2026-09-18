import { describe, expect, it } from "vitest";
import { describeJudgeSetup, environmentJudgeSetup, JUDGE_API_KEY } from "./settings.js";

const CONFIG = {
  enabled: true,
  endpoint: "https://judge.example/v1/systemone",
  model: "jev-latest",
  timeoutMs: 8000,
  environmentThreshold: 0.85,
};

describe("environmentJudgeSetup", () => {
  it("stays out of the way when the deployment did not ask for it", () => {
    const setup = environmentJudgeSetup({ ...CONFIG, enabled: false }, new Map([[JUDGE_API_KEY, "k"]]));

    expect(setup.kind).toBe("off");
    expect(describeJudgeSetup(setup)).toBeNull();
  });

  it("says so when it was asked for and has no credential", () => {
    // Silence here would look exactly like a judge that is answering, and the
    // host would go on trusting a signal nothing produced.
    const setup = environmentJudgeSetup(CONFIG, new Map());

    expect(setup.kind).toBe("no_credential");
    expect(describeJudgeSetup(setup)).toContain(JUDGE_API_KEY);
  });

  it("carries the threshold and the model to the call sites", () => {
    const setup = environmentJudgeSetup(CONFIG, new Map([[JUDGE_API_KEY, "key-under-test"]]));

    expect(setup.kind).toBe("ready");
    if (setup.kind !== "ready") return;
    expect(setup.settings.model).toBe("jev-latest");
    expect(setup.settings.threshold).toBe(0.85);
    expect(setup.settings.judge).toBeDefined();
  });

  it("never puts the credential in the line an operator reads", () => {
    const setup = environmentJudgeSetup(CONFIG, new Map([[JUDGE_API_KEY, "key-under-test"]]));

    expect(describeJudgeSetup(setup)).not.toContain("key-under-test");
  });
});
