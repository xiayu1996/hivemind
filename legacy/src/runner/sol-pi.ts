import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hivemindHome } from "./pi-binary.js";

/**
 * SoL-Pi, NVIDIA's efficiency extension for pi, and the two of its four
 * mechanisms hivemind is willing to run.
 *
 * Action Fusion lets an edit carry the command that validates it, which removes
 * one model round trip from every edit-then-test pair -- the shape a hundred-turn
 * CODE round is mostly made of. ObservationPack stops a large tool result from
 * being replayed into every later request, handing the model a stable handle and
 * an `obs_recall` tool to page the original bytes back. Both rewrite only what
 * goes to the provider; the session file, and with it the checkpoint and the
 * evidence VERIFY mines, keeps the original.
 *
 * The other two mechanisms stay off and are rendered off rather than omitted,
 * because the file is the audit of that decision:
 *
 * - Evidence-Preserving Reducer calls a second model from inside the extension.
 *   That call does not cross the RPC event stream, so `sumUsage`, `turn_usage`,
 *   the per-card ceiling, the circuit breaker and error classification are all
 *   blind to it -- it would be a model path outside every guard rail hivemind
 *   has. It also rewrites the tool result that lands in the session, which is
 *   the text the VERIFY evidence check and the SPECIFY test report read.
 * - Online Context Compact is the largest saver and the only one that cost
 *   score in NVIDIA's own ablation. Its saving is a cache-read saving, and the
 *   provider carrying most of hivemind's traffic is billed by subscription,
 *   where that saving is worth nothing. It also aborts a turn mid-flight to
 *   compact, which collides with `clear_queue` + `abort` being hivemind's
 *   signal that a round was abandoned.
 */

/** The four mechanism switches SoL-Pi reads, whatever hivemind sets them to. */
export interface SolPiConfig {
  actionFusion: boolean;
  observationPack: boolean;
}

/**
 * The tool ObservationPack registers so the model can page back bytes it was
 * handed a placeholder for. Spawns pass an explicit tool allowlist, so leaving
 * this out of it would hand the model handles it has no way to open.
 */
export const OBSERVATION_PACK_TOOL = "obs_recall";

/**
 * The pinned SoL-Pi commit, from package.json `hivemind.solPiRef`. A ref rather
 * than a version because SoL-Pi publishes no releases; the same single-source
 * rule as `hivemind.piVersion` applies, so no literal sha belongs anywhere else.
 */
export function pinnedSolPiRef(): string {
  if (process.env.HIVEMIND_SOL_PI_REF) return process.env.HIVEMIND_SOL_PI_REF;
  const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8")) as {
    hivemind?: { solPiRef?: string };
  };
  const ref = manifest.hivemind?.solPiRef;
  if (!ref) throw new Error("package.json is missing hivemind.solPiRef");
  return ref;
}

/**
 * The extension entry point `-e` is pointed at. Installed beside pi rather than
 * into this repository's node_modules: SoL-Pi imports pi's own packages as peer
 * dependencies, so it has to resolve them from the pi installation that loads
 * it, and versioned directories let one host hold several pins at once.
 */
export function solPiExtensionPath(ref = pinnedSolPiRef()): string {
  return join(hivemindHome(), "sol-pi", ref, "src", "sol-pi", "index.ts");
}

/** Where SoL-Pi reads its configuration on this host: pi's agent directory. */
export function solPiConfigPath(home = homedir()): string {
  return join(home, ".pi", "agent", "sol-pi.json");
}

/**
 * The file's contents for one mechanism selection.
 *
 * Every key is written, including the two that stay false. SoL-Pi refuses to
 * load on an unknown key or a non-boolean value, so a rendered file that fails
 * to load stops the spawn instead of silently running unconfigured.
 */
export function renderSolPiConfig(config: SolPiConfig): string {
  return `${JSON.stringify({
    version: 1,
    actionFusion: config.actionFusion,
    observationPack: config.observationPack,
    evidencePreservingReducer: false,
    onlineContextCompact: false,
  }, null, 2)}\n`;
}

export type SolPiInstallResult = "written" | "unchanged";

/**
 * Puts the rendered configuration where SoL-Pi will read it.
 *
 * Atomic for the same reason the provider declaration is: Story children spawn
 * pi concurrently on one host, and a reader that catches a half-written file
 * gets a parse error that stops the run.
 */
export async function installSolPiConfig(
  contents: string,
  path = solPiConfigPath(),
): Promise<SolPiInstallResult> {
  const current = await readFile(path, "utf8").catch(() => null);
  if (current === contents) return "unchanged";
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, contents, { mode: 0o600 });
  await rename(temporary, path);
  return "written";
}
