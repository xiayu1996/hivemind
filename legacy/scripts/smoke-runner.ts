import { defaultSecretsPath, loadSecretsFile } from "../src/config/secrets-file.js";
import { PiModelCatalog, resolveModel } from "../src/runner/model-resolver.js";
import { RpcPiRunner } from "../src/runner/rpc-runner.js";
import { defaultPiBinary } from "../src/runner/pi-binary.js";
import { providerKeyEnv } from "../src/runner/provider-env.js";

/**
 * One real round trip against one provider.
 *
 * A model id existing in a catalogue does not mean this account may spawn it:
 * subscription accounts refuse ids pi lists, and a provider being added has
 * never carried a turn here. Both take a real exchange to answer, which is
 * what this is. It names the provider and the model because inheriting either
 * would send the spend somewhere nobody chose.
 *
 *   npx tsx scripts/smoke-runner.ts [--provider openai-codex] [--model gpt-5.6-luna]
 */
function optional(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

const provider = optional("--provider", "openai-codex");
const modelId = optional("--model", "gpt-5.6-luna");

const binary = defaultPiBinary();
const secretsPath = defaultSecretsPath();
const secrets = await loadSecretsFile(secretsPath).catch(() => new Map<string, string>());
const env = providerKeyEnv({ provider, secrets, secretsPath });
const model = await resolveModel(new PiModelCatalog({ binary, env }), provider, modelId);

const runner = new RpcPiRunner({
  binary,
  provider,
  model,
  cwd: "/tmp",
  tools: [],
  env,
  contextFiles: "explicit",
  systemPrompt: { mode: "append", text: "Answer in at most 5 words." },
});

await runner.start();
console.log("handshake ok, alive =", runner.alive);
await runner.setAutoRetry(false);

const result = await runner.prompt("What is 2+2? Answer with the number only.", 120_000);
console.log("failure:", result.failure);
console.log("usage:", JSON.stringify(result.usage));
const messages = await runner.getMessages();
console.log("messages:", messages.length);
console.log("last:", JSON.stringify(messages.at(-1)).slice(0, 200));

const state = await runner.getState();
console.log("model in state:", (state.model as { id?: string })?.id);
await runner.stop();
console.log("stopped, alive =", runner.alive);
