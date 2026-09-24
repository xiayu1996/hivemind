import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The single source of the pinned pi release: package.json `hivemind.piVersion`.
 * Shell scripts read the same field, so a bump is one edit. `HIVEMIND_PI_VERSION`
 * overrides it for canary hosts only.
 */
export function pinnedPiVersion(): string {
  if (process.env.HIVEMIND_PI_VERSION) return process.env.HIVEMIND_PI_VERSION;
  const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8")) as {
    hivemind?: { piVersion?: string };
  };
  const version = manifest.hivemind?.piVersion;
  if (!version) throw new Error("package.json is missing hivemind.piVersion");
  return version;
}

export function hivemindHome(): string {
  return process.env.HIVEMIND_HOME ?? join(homedir(), ".hivemind");
}

/**
 * Where install-pi.sh puts the pinned build. `PI_BIN` overrides for smoke runs
 * against another build; nothing else should compute this path.
 */
export function defaultPiBinary(): string {
  if (process.env.PI_BIN) return process.env.PI_BIN;
  return join(hivemindHome(), "pi", pinnedPiVersion(), "pi", process.platform === "win32" ? "pi.exe" : "pi");
}
