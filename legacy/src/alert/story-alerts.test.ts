import { describe, expect, it, vi } from "vitest";
import { AlertRouter, type AlertChannel } from "./index.js";
import { alertNeedsInput } from "./story-alerts.js";

describe("alertNeedsInput", () => {
  it("routes a true stop outside Notion and ignores running states", async () => {
    const send = vi.fn(async () => undefined);
    const channel: AlertChannel = { name: "test", send };
    const alerts = new AlertRouter([channel]);
    await expect(alertNeedsInput(alerts, {
      id: "S-EPIC1-01",
      state: "NEEDS_INPUT",
      stopReason: "blocking_question",
    })).resolves.toBe(true);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      kind: "needs_input",
      cardId: "S-EPIC1-01",
    }));
    await expect(alertNeedsInput(alerts, {
      id: "S-EPIC1-01",
      state: "CODE",
      stopReason: null,
    })).resolves.toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("fails loudly when every independent channel is unavailable", async () => {
    const alerts = new AlertRouter([{
      name: "broken",
      send: async () => { throw new Error("offline"); },
    }]);
    await expect(alertNeedsInput(alerts, {
      id: "S-EPIC1-01",
      state: "NEEDS_INPUT",
      stopReason: "verify_loop_exceeded",
    })).rejects.toThrow("needs-input alert failed on every channel");
  });

  it("stays silent when no channel is configured at all", async () => {
    const alerts = new AlertRouter([]);
    await expect(alertNeedsInput(alerts, {
      id: "S-EPIC1-01",
      state: "NEEDS_INPUT",
      stopReason: "blocking_question",
    })).resolves.toBe(false);
  });
});
