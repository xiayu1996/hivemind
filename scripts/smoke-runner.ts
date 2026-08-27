import { RpcPiRunner } from "../src/runner/rpc-runner.js";

const runner = new RpcPiRunner({
  binary: `${process.env.HOME}/.hivemind/pi/0.84.3/pi/pi`,
  provider: "openai-codex",
  model: "gpt-5.4-mini",
  cwd: "/tmp",
  tools: [],
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
