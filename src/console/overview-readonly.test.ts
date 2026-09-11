import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("S-E3OVERVIEW-03-readonly", () => {
  it("makes the home snapshot request explicitly read-only and exposes only task links", async () => {
    const app = await readFile("console-ui/src/App.vue", "utf8");
    expect(app).toContain('fetch("/api/overview", { method: "GET", cache: "no-store" })');
    expect(app).toContain(':href="item.taskPath"');
    for (const control of ["Save", "Edit", "Retry", "Delete", "Login", "Members", "Permissions"]) {
      expect(app).not.toContain(`>${control}<`);
    }
  });
});
