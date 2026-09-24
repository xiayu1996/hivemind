// Registers the local mock provider so PoC runs need no real vendor credentials.
// Port comes from HIVEMIND_MOCK_PORT (default 8099).

export default function (pi) {
  const port = process.env.HIVEMIND_MOCK_PORT ?? "8099";
  pi.registerProvider("mock", {
    name: "Hivemind Mock",
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: "mock-key",
    api: "openai-completions",
    models: [
      {
        id: "mock-1",
        name: "Mock 1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
      },
    ],
  });
}
