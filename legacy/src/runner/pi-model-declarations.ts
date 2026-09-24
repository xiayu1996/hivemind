import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * The provider declaration hivemind hands to pi, rendered from the central
 * configuration rather than kept as a file in this repository.
 *
 * pi is a separate process and reads its provider catalogue from
 * `~/.pi/agent/models.json` on disk, so hivemind cannot simply hold the
 * declaration in its database and be done. It can, however, be the only author
 * of that file: the declaration lives beside the rest of a provider's record
 * in `model.providers`, and every host renders the file from the same row
 * before it spawns pi. Adding a provider is then a configuration write -- one
 * a person can make from the console -- instead of a commit that every machine
 * has to be redeployed to receive, and the drift that used to be possible
 * between hosts ("one machine did not install the declaration, so one model id
 * does not exist there") stops being something a test has to catch.
 *
 * The rendering is deterministic: providers and their models are emitted in a
 * stable order so an unchanged configuration rewrites nothing and a diff of
 * the installed file is a diff of the decision behind it.
 */

/** What pi needs to reach a provider that is not in its built-in catalogue. */
export interface PiModelDeclaration {
  baseUrl: string;
  /** pi's wire protocol name, e.g. `openai-completions`. */
  api: string;
  models: readonly PiModelEntry[];
}

export interface PiModelEntry {
  id: string;
  name: string;
  reasoning: boolean;
  /** Modalities pi may send. Omitting `image` means this model is never shown a
   * screenshot, whatever the tier asks for: pi defaults to text alone. */
  input: readonly string[];
  contextWindow: number;
  maxTokens: number;
  /** Our effort levels mapped to what this provider calls them; null for a
   * level this provider does not express, which sends no effort at all. */
  thinkingLevelMap: Readonly<Record<string, string | null>>;
  /** USD per million tokens. Omitting it makes pi record the spend as zero,
   * which is worse than a wrong price: the per-card ceiling stops working. */
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export interface DeclaringProfile {
  envKey?: string | undefined;
  declaration?: PiModelDeclaration | undefined;
}

/** Where pi reads the declaration on this host. */
export function piModelDeclarationsPath(home = homedir()): string {
  return join(home, ".pi", "agent", "models.json");
}

/**
 * The file's contents for these profiles. Providers with no declaration are
 * left out: pi already carries its own catalogue, and repeating a built-in
 * provider here would pin a copy of pi's own prices.
 */
export function renderPiModelDeclarations(profiles: Record<string, DeclaringProfile>): string {
  const providers: Record<string, unknown> = {};
  for (const provider of Object.keys(profiles).toSorted()) {
    const profile = profiles[provider]!;
    if (!profile.declaration) continue;
    providers[provider] = {
      baseUrl: profile.declaration.baseUrl,
      // Named, never inlined: the key itself belongs in the host's secrets
      // file and must not reach this file, the repository or a log.
      ...(profile.envKey === undefined ? {} : { apiKey: `$${profile.envKey}` }),
      api: profile.declaration.api,
      models: profile.declaration.models.map((model) => ({
        id: model.id,
        name: model.name,
        reasoning: model.reasoning,
        input: [...model.input],
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        thinkingLevelMap: model.thinkingLevelMap,
        cost: model.cost,
      })),
    };
  }
  return `${JSON.stringify({ providers }, null, 2)}\n`;
}

export type DeclarationInstallResult = "written" | "unchanged";

/**
 * Puts the rendered declaration where pi will read it, and says whether that
 * changed anything.
 *
 * The write is atomic because several Story children spawn pi concurrently on
 * one host: a reader that catches a half-written file gets a provider
 * catalogue with no providers in it, and pi would accept that silently and
 * price the run at zero.
 */
export async function installPiModelDeclarations(
  contents: string,
  path = piModelDeclarationsPath(),
): Promise<DeclarationInstallResult> {
  const current = await readFile(path, "utf8").catch(() => null);
  if (current === contents) return "unchanged";
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, contents, { mode: 0o600 });
  await rename(temporary, path);
  return "written";
}
