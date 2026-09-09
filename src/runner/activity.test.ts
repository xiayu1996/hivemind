import { describe, expect, it } from "vitest";
import { pendingUiPrompts } from "./activity.js";
import type { RpcEvent } from "./types.js";

const request = (id: string, method: string, title?: string): RpcEvent => ({
  type: "extension_ui_request",
  id,
  method,
  ...(title ? { title } : {}),
});

describe("pendingUiPrompts", () => {
  it("reports a dialog nobody has answered, since the run is blocked on a person", () => {
    expect(pendingUiPrompts([request("u1", "confirm", "Clear session?")])).toEqual([
      { id: "u1", method: "confirm", title: "Clear session?" },
    ]);
  });

  it("ignores fire-and-forget methods, which do not block the agent", () => {
    const events = [request("u1", "notify"), request("u2", "setStatus"), request("u3", "setWidget")];
    expect(pendingUiPrompts(events)).toEqual([]);
  });

  it("drops a dialog once it has been answered", () => {
    const events = [request("u1", "select"), request("u2", "input")];
    expect(pendingUiPrompts(events, new Set(["u1"]))).toEqual([
      { id: "u2", method: "input", title: undefined },
    ]);
  });

  it("says nothing about a run that never opened a dialog", () => {
    expect(pendingUiPrompts([{ type: "agent_start" }, { type: "agent_settled" }])).toEqual([]);
  });
});
