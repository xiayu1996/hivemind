import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hivemindHome } from "../runner/pi-binary.js";

/**
 * Where the pinned design detector lives, and which build that is.
 *
 * Two numbers, because the tool has two: the release it is downloaded from is
 * tagged `engine-v<engineVersion>`, and the binary from that release reports
 * something else entirely when asked (`4.0.0` for `engine-v0.1.5`) because it
 * shares its version line with the skill package. A probe that compared the
 * reported string against the tag would fail on a correctly installed host, so
 * both are pinned and each is used for the one job it can do.
 */
export interface DesignLintPin {
  /** The release the binary is downloaded from, without the `engine-v` prefix. */
  engineVersion: string;
  /** What `impeccable --version` prints for that release. */
  reportedVersion: string;
}

export function pinnedDesignLint(): DesignLintPin {
  const manifest = JSON.parse(
    readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
  ) as { hivemind?: { impeccableEngineVersion?: string; impeccableReportedVersion?: string } };
  const engineVersion = manifest.hivemind?.impeccableEngineVersion;
  const reportedVersion = manifest.hivemind?.impeccableReportedVersion;
  if (!engineVersion || !reportedVersion) {
    throw new Error("package.json is missing hivemind.impeccableEngineVersion or hivemind.impeccableReportedVersion");
  }
  return { engineVersion, reportedVersion };
}

/** Where `install.sh` puts the pinned build. `IMPECCABLE_BIN` overrides it for
 * a host that keeps its own copy; nothing else computes this path. */
export function defaultDesignLintBinary(): string {
  if (process.env.IMPECCABLE_BIN) return process.env.IMPECCABLE_BIN;
  return join(hivemindHome(), "impeccable", pinnedDesignLint().engineVersion, "impeccable");
}
