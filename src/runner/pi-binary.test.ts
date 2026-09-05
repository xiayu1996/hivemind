import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { defaultPiBinary, hivemindHome, pinnedPiVersion } from "./pi-binary.js";

const saved = { ...process.env };

afterEach(() => {
  for (const key of ["PI_BIN", "HIVEMIND_PI_VERSION", "HIVEMIND_HOME"]) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("pinned pi version", () => {
  it("reads the pin from package.json", () => {
    delete process.env.HIVEMIND_PI_VERSION;
    expect(pinnedPiVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("lets HIVEMIND_PI_VERSION override the pin", () => {
    process.env.HIVEMIND_PI_VERSION = "9.9.9";
    expect(pinnedPiVersion()).toBe("9.9.9");
  });
});

describe("default pi binary", () => {
  it("lives under the versioned directory in the hivemind home", () => {
    delete process.env.PI_BIN;
    process.env.HIVEMIND_HOME = "/opt/hive";
    process.env.HIVEMIND_PI_VERSION = "1.2.3";
    const expected = join("/opt/hive", "pi", "1.2.3", "pi", process.platform === "win32" ? "pi.exe" : "pi");
    expect(hivemindHome()).toBe("/opt/hive");
    expect(defaultPiBinary()).toBe(expected);
  });

  it("prefers PI_BIN when set", () => {
    process.env.PI_BIN = "/tmp/pi";
    expect(defaultPiBinary()).toBe("/tmp/pi");
  });
});
