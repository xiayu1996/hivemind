import { describe, expect, it } from "vitest";
import { approvalJudgeSetup, describeJudgeSetup, environmentJudgeSetup, JUDGE_API_KEY } from "./settings.js";

const CONFIG = {
  enabled: true,
  endpoint: "https://judge.example/v1/systemone",
  model: "jev-latest",
  timeoutMs: 8000,
  environmentThreshold: 0.7,
  approvalThreshold: 0.8,
};

const WITH_KEY = new Map([[JUDGE_API_KEY, "key-under-test"]]);

describe("environmentJudgeSetup", () => {
  it("stays out of the way when the deployment did not ask for it", () => {
    const { setup, settings } = environmentJudgeSetup({ ...CONFIG, enabled: false }, WITH_KEY);

    expect(setup.kind).toBe("off");
    expect(settings).toBeUndefined();
    expect(describeJudgeSetup(setup)).toBeNull();
  });

  it("says so when it was asked for and has no credential", () => {
    // Silence here would look exactly like a judge that is answering, and the
    // host would go on trusting a signal nothing produced.
    const { setup, settings } = environmentJudgeSetup(CONFIG, new Map());

    expect(setup.kind).toBe("no_credential");
    expect(settings).toBeUndefined();
    expect(describeJudgeSetup(setup)).toContain(JUDGE_API_KEY);
  });

  it("carries the threshold and the model to the call sites", () => {
    const { setup, settings } = environmentJudgeSetup(CONFIG, WITH_KEY);

    expect(setup.kind).toBe("ready");
    expect(settings?.model).toBe("jev-latest");
    expect(settings?.threshold).toBe(0.7);
    expect(settings?.judge).toBeDefined();
  });

  it("never puts the credential in the line an operator reads", () => {
    const { setup } = environmentJudgeSetup(CONFIG, WITH_KEY);

    expect(describeJudgeSetup(setup)).not.toContain("key-under-test");
  });
});

describe("approvalJudgeSetup", () => {
  it("takes its own threshold, because the safe direction is not the same one", () => {
    // Sharing a number would tie how sure the judge must be that a comment
    // approves a draft to how sure it must be that a refusal is about the box.
    const { settings } = approvalJudgeSetup(CONFIG, WITH_KEY);

    expect(settings?.threshold).toBe(0.8);
    expect(settings?.threshold).not.toBe(CONFIG.environmentThreshold);
  });

  it("leaves the whitelist alone when the deployment did not ask for a judge", () => {
    const { setup, settings } = approvalJudgeSetup({ ...CONFIG, enabled: false }, WITH_KEY);

    expect(setup.kind).toBe("off");
    expect(settings).toBeUndefined();
  });
});
