import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultSecretsPath, loadSecretsFile } from "../src/config/secrets-file.js";
import { classifyError, type ErrorClass } from "../src/runner/classify.js";
import { fixtureRoot } from "../src/runner/error-fixtures.js";
import { PiModelCatalog, resolveModel } from "../src/runner/model-resolver.js";
import { defaultPiBinary } from "../src/runner/pi-binary.js";
import { providerKeyEnv } from "../src/runner/provider-env.js";
import { RpcPiRunner } from "../src/runner/rpc-runner.js";

/**
 * Records a provider's real failure wording into `fixtures/rpc-errors/`.
 *
 * A provider may not carry cards until its AUTH, QUOTA and RATE_LIMIT wordings
 * are captured and recognised, and they have to come from the provider rather
 * than from someone's memory of it: the classifier reads text, so a wording
 * nobody has seen is a recovery path nobody has tested.
 *
 *   # AUTH: ask with a key the provider will reject
 *   npx tsx scripts/capture-error-fixture.ts deepseek auth --expect AUTH --api-key invalid-on-purpose
 *
 *   # RATE_LIMIT: several turns at once until the provider throttles
 *   npx tsx scripts/capture-error-fixture.ts deepseek rate_limit --expect RATE_LIMIT --concurrency 12
 *
 * The capture is written only when its classification matches `--expect`. A
 * fixture that lands as UNKNOWN, or as a different class than intended, is the
 * exact thing the gate exists to catch, so it is reported and not saved.
 */
function optional(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const positional = process.argv.slice(2);
const provider = positional[0] ?? "";
const name = positional[1] ?? "";
const expect = optional("--expect") as ErrorClass | undefined;
if (!provider || !name || provider.startsWith("--") || name.startsWith("--") || !expect) {
  console.error("usage: npx tsx scripts/capture-error-fixture.ts <provider> <fixture-name>" +
    " --expect <AUTH|QUOTA|RATE_LIMIT|...> [--model id] [--api-key value] [--concurrency n] [--prompt text]");
  process.exit(2);
}

const binary = defaultPiBinary();
const secretsPath = defaultSecretsPath();
const secrets = await loadSecretsFile(secretsPath).catch(() => new Map<string, string>());
const realEnv = providerKeyEnv({ provider, secrets, secretsPath });
const envKey = Object.keys(realEnv)[0]!;

// A deliberately wrong key is how an AUTH wording is provoked; everything else
// is captured with the host's real credential.
const override = optional("--api-key");
const env = override ? { [envKey]: override } : realEnv;

const modelId = optional("--model")
  ?? (await new PiModelCatalog({ binary, env: realEnv }).list(provider))[0]?.id;
if (!modelId) throw new Error(`cannot list ${provider}; pass --model`);
const model = await resolveModel(new PiModelCatalog({ binary, env: realEnv }), provider, modelId);

const prompt = optional("--prompt") ?? `trigger ${name}`;
const concurrency = Number(optional("--concurrency") ?? "1");

async function attempt(): Promise<{ runner: RpcPiRunner; errorMessage: string | null }> {
  const runner = new RpcPiRunner({ binary, provider, model, cwd: tmpdir(), tools: [], env });
  await runner.start();
  // pi's own retry would swallow the first wording and report a later one.
  await runner.setAutoRetry(false);
  const result = await runner.prompt(prompt, 120_000).catch(() => null);
  return { runner, errorMessage: result?.failure?.errorMessage ?? null };
}

const attempts = await Promise.all(Array.from({ length: Math.max(1, concurrency) }, attempt));
const captured = attempts.find((entry) => entry.errorMessage !== null);

for (const entry of attempts) await entry.runner.stop().catch(() => undefined);

if (!captured?.errorMessage) {
  console.error(`no failure surfaced across ${attempts.length} attempt(s); the provider answered normally`);
  process.exit(1);
}

const classification = classifyError(captured.errorMessage);
console.log(`captured: ${captured.errorMessage.slice(0, 200)}`);
console.log(`classified as: ${classification.class}`);

if (classification.class !== expect) {
  console.error(`expected ${expect} but this wording classifies as ${classification.class};` +
    " either the rule set needs the wording or the fault induced was not the one intended");
  process.exit(1);
}

const directory = join(fixtureRoot(), provider);
await mkdir(directory, { recursive: true });
const path = join(directory, `${name}.json`);
await writeFile(path, `${JSON.stringify({
  fault: name,
  events: captured.runner.events(),
  stderr: captured.runner.stderr,
}, null, 2)}\n`, "utf8");
console.log(`wrote ${path}`);
