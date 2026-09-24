import { describe, expect, it } from "vitest";
import { redactor } from "./log.ts";

describe("redactor", () => {
  const redact = redactor(new Map([["DEEPSEEK_API_KEY", "placeholder-deepseek-value"]]));

  it("replaces the value of every loaded secret", () => {
    expect(redact("request failed with key placeholder-deepseek-value")).toBe("request failed with key [secret]");
  });

  it("replaces credential-shaped strings it was never told about", () => {
    const jwt = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"].join(".");
    expect(redact(`token ${jwt} and ${"ghp_"}${"a".repeat(36)} and ${"sk-"}${"b".repeat(40)}`)).toBe("token [secret] and [secret] and [secret]");
  });

  it("keeps the scheme and host of a URL whose userinfo it cuts", () => {
    expect(redact("cloning https://user:hunter2hunter2@github.com/acme/web.git")).toBe("cloning https://[secret]@github.com/acme/web.git");
  });

  it("leaves ordinary text alone", () => {
    expect(redact("item list-v2 passed after 2 attempts")).toBe("item list-v2 passed after 2 attempts");
  });
});
