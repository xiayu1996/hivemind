import { describe, expect, it } from "vitest";
import { describeGitFailure } from "./git-failure.js";

const failure = (message: string, stdout?: string): Error =>
  Object.assign(new Error(message), stdout === undefined ? {} : { stdout });

describe("describeGitFailure", () => {
  it("adds what git printed when the message alone says nothing", () => {
    const cause = failure(
      "Command failed: git commit -m test(S-CARD-01): red\n",
      "nothing to commit, working tree clean\n",
    );

    const described = describeGitFailure(cause) as Error;

    expect(described.message).toBe(
      "Command failed: git commit -m test(S-CARD-01): red\nnothing to commit, working tree clean",
    );
    expect(described.cause).toBe(cause);
  });

  it("leaves a failure that already carries its reason alone", () => {
    const cause = failure("Command failed: git merge\nCONFLICT in a.ts", "CONFLICT in a.ts");
    expect(describeGitFailure(cause)).toBe(cause);
  });

  it("leaves a failure that printed nothing alone", () => {
    const cause = failure("Command failed: git status", "  \n");
    expect(describeGitFailure(cause)).toBe(cause);
  });

  it("passes anything that is not an error straight through", () => {
    expect(describeGitFailure("killed")).toBe("killed");
  });
});
