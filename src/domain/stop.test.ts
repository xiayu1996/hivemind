import { describe, expect, it } from "vitest";
import { afterItemFailure, budgetExceeded, DEFAULT_LIMITS } from "./stop.ts";

describe("stop rules", () => {
  it("retries, then replans once, then stops", () => {
    expect(afterItemFailure(1, 0, DEFAULT_LIMITS)).toBe("retry");
    expect(afterItemFailure(2, 0, DEFAULT_LIMITS)).toBe("retry");
    expect(afterItemFailure(3, 0, DEFAULT_LIMITS)).toBe("replan");
    expect(afterItemFailure(3, 1, DEFAULT_LIMITS)).toBe("stop");
  });

  it("treats a zero budget as unlimited and a reached budget as exceeded", () => {
    expect(budgetExceeded(100, 0)).toBe(false);
    expect(budgetExceeded(9.99, 10)).toBe(false);
    expect(budgetExceeded(10, 10)).toBe(true);
  });
});
