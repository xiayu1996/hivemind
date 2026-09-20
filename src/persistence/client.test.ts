import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { absoluteDbUrl } from "./client.js";

describe("the central store's address", () => {
  it("resolves a relative file URL against the current directory", () => {
    expect(absoluteDbUrl("file:data/hivemind.db")).toBe(`file:${resolve("data/hivemind.db")}`);
  });

  it("keeps the query a libsql URL may carry", () => {
    expect(absoluteDbUrl("file:data/hivemind.db?mode=ro")).toBe(`file:${resolve("data/hivemind.db")}?mode=ro`);
  });

  it("leaves an address that already names a place alone", () => {
    expect(absoluteDbUrl("file:/srv/hivemind/central.db")).toBe("file:/srv/hivemind/central.db");
    expect(absoluteDbUrl("libsql://central.turso.io")).toBe("libsql://central.turso.io");
    expect(absoluteDbUrl(":memory:")).toBe(":memory:");
  });
});
