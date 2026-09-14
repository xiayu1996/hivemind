// Deterministic OpenAI-compatible mock server for PoC runs that must not depend
// on a real provider. Scripted replies keep Context round-trip diffs meaningful,
// and the fault modes produce real transport-level error samples.
//
// Usage: node mock-provider-server.mjs [--port 8099] [--script script.json]
//
// Fault injection: set the `x-mock-fault` request header, or write a fault name
// into the file named by MOCK_FAULT_FILE. Supported faults:
//   auth | rate_limit | server | invalid_request | timeout | transport

import { createServer } from "node:http";
import { readFileSync, existsSync, appendFileSync } from "node:fs";

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const PORT = Number(getArg("--port", "8099"));
const FAULT_FILE = process.env.MOCK_FAULT_FILE ?? "";

const MODEL_ID = "mock-1";

const FAULTS = {
  auth: {
    status: 401,
    body: {
      error: {
        message: "Incorrect API key provided: mock-***. You can find your API key at https://platform.openai.com/account/api-keys.",
        type: "invalid_request_error",
        code: "invalid_api_key",
      },
    },
  },
  rate_limit: {
    status: 429,
    headers: { "retry-after": "37" },
    body: {
      error: {
        message: "Rate limit reached for mock-1 in organization org-mock on requests per min (RPM): Limit 3, Used 3. Please try again in 20s.",
        type: "requests",
        code: "rate_limit_exceeded",
      },
    },
  },
  quota: {
    status: 429,
    body: {
      error: {
        message: "You exceeded your current quota, please check your plan and billing details.",
        type: "insufficient_quota",
        code: "insufficient_quota",
      },
    },
  },
  server: {
    status: 500,
    body: { error: { message: "The server had an error while processing your request.", type: "server_error", code: null } },
  },
  invalid_request: {
    status: 400,
    body: {
      error: {
        message: "Invalid value for 'messages[0].role': expected one of 'system', 'assistant', 'user'.",
        type: "invalid_request_error",
        code: "invalid_value",
      },
    },
  },
};

function currentFault(req) {
  const header = req.headers["x-mock-fault"];
  if (typeof header === "string" && header) return header;
  if (FAULT_FILE && existsSync(FAULT_FILE)) {
    const v = readFileSync(FAULT_FILE, "utf8").trim();
    if (v) return v;
  }
  return "";
}

// Reply script: the nth assistant reply of a session is scripted, so a replayed
// Context produces byte-identical output and round-trip diffs stay meaningful.
const SCRIPT = [
  "ACK-1 hivemind poc context anchor alpha",
  "ACK-2 hivemind poc context anchor bravo",
  "ACK-3 hivemind poc context anchor charlie",
];

const CHUNK_DELAY_MS = Number(process.env.MOCK_CHUNK_DELAY_MS ?? "0");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function messageText(m) {
  if (typeof m?.content === "string") return m.content;
  if (Array.isArray(m?.content)) {
    return m.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join(" ");
  }
  return "";
}

// A tool call gives the turn more than one LLM call, which is the only place a
// steering message can be delivered, and it is how guard denials are exercised
// without a real model. Triggered by USE_TOOL in the user text; the text after
// `USE_TOOL:` becomes the bash command, so a caller can aim a specific command
// at the guard.
const DEFAULT_TOOL_COMMAND = "sleep 6; echo mock-tool-done";

function wantsToolCall(messages) {
  const lastUser = messages.toReversed().find((m) => m.role === "user");
  const alreadyRan = messages.some((m) => m.role === "tool" || Array.isArray(m?.tool_calls));
  const text = messageText(lastUser);
  return (/USE_(?:TOOL|WRITE):/.test(text) || text.includes("Perform an independent blind verification")) && !alreadyRan;
}

// The verifier is told which scenarios were declared; that section is the only
// reliable place to read an id from, because the prompt also names the run
// (`S-MOCK-01-verify-1`), which matches the same shape.
function declaredScenario(text) {
  const declared = /Declared scenarios:\s*\n\s*([^\n]+)/.exec(text)?.[1]?.trim();
  if (declared) return declared.split(/\s+/)[0];
  return /\bS-[A-Z0-9]+-\d{2}-[a-z0-9]+\b/.exec(text)?.[0] ?? "S-MOCK-01-unit";
}

function toolRequest(messages) {
  const lastUser = messages.toReversed().find((m) => m.role === "user");
  const text = messageText(lastUser);
  if (text.includes("Perform an independent blind verification")) {
    const scenario = declaredScenario(text);
    return { name: "bash", arguments: { command: `echo HIVEMIND_TEST_RESULT ${scenario} passed` } };
  }
  const write = /USE_WRITE:([^\n]*)/.exec(text);
  if (write) {
    return { name: "write", arguments: { path: write[1].trim(), content: "mock write\n" } };
  }
  const command = /USE_TOOL:([^\n]*)/.exec(text);
  return {
    name: "bash",
    arguments: { command: command ? command[1].trim() : DEFAULT_TOOL_COMMAND },
  };
}

// The CODE exit requires one `addressed <tag>` line per round task, so a round
// that read a person's answer cannot quietly do the smallest thing. The mock
// changes nothing, but it answers in contract for whatever tags the round
// carries.
function addressedLines(phaseInput) {
  const tags = [...new Set(phaseInput.match(/\[(?:scenario|regression|rejected|answer):[^\]\n]+\]/g) ?? [])];
  return tags.map((tag) => `addressed ${tag}: the deterministic implementation already covers it.`).join("\n");
}

function scriptedReply(messages) {
  const assistantCount = messages.filter((m) => m.role === "assistant").length;
  const scripted = SCRIPT[assistantCount] ?? `ACK-${assistantCount + 1} hivemind poc context anchor omega`;
  const lastUser = messages.toReversed().find((m) => m.role === "user");
  if (messageText(lastUser).includes("Judge whether this phase exit is actually complete")) {
    return JSON.stringify({ done: true, reason: "Mock side effects are complete." });
  }
  if (messageText(lastUser).includes("Perform an independent blind verification")) {
    const scenario = declaredScenario(messageText(lastUser));
    return JSON.stringify({ scenarios: [{ id: scenario, status: "passed" }] });
  }
  const phaseInput = messageText(lastUser);
  const storyId = /# Task (S-[A-Z0-9]+-\d{2})\b/.exec(phaseInput)?.[1] ?? "S-MOCK-01";
  // SHAPE owns the acceptance contract; every later phase reads it frozen.
  if (phaseInput.includes("Phase: SHAPE")) {
    return JSON.stringify({
      dod_yaml: [
        `story_id: ${storyId}`,
        "design_summary: Persist phase artifacts and verify them independently.",
        "scenarios:",
        `  - id: ${storyId}-unit`,
        "    given: A completed implementation",
        "    when: blind verification runs",
        "    then: the scenario passes from observed evidence",
        "    layers: [integration]",
        "baseline:",
        "  type: acceptance_test",
        "acceptance_criteria:",
        "  - text: The Story reaches delivered after an accepted verdict.",
        `    scenarios: [${storyId}-unit]`,
        "out_of_scope: []",
        "relies_on: []",
        "predicted_footprint: [src/orchestrator]",
        "depends_on: []",
      ].join("\n"),
      open_questions: [],
      assumptions: ["The smoke repository declares no preferences, so the general convention is used."],
    });
  }
  if (phaseInput.includes("Phase: DESIGN")) {
    return JSON.stringify({
      design_summary: "Use the central phase ledger and an independent verifier.",
      declarations: [{ file: "src/orchestrator/story-worker.ts", note: "the phase the verdict is judged against" }],
    });
  }
  if (phaseInput.includes("Phase: SPECIFY")) {
    // A regression reopen enters SPECIFY narrow: one reproduction for the
    // signature that broke, not the whole contract again.
    const narrow = phaseInput.includes("[regression:");
    return JSON.stringify({
      test_contract_yaml: [
        `story_id: ${storyId}`,
        narrow ? "mode: narrow" : "mode: full",
        "scenarios:",
        `  - id: ${storyId}-unit`,
        "    layer: integration",
        "    cases:",
        `      - name: "@scenario ${storyId}-unit passes on observed evidence"`,
        "        kind: happy",
        "        asserts: the verdict names the scenario as passed",
        `      - name: "@scenario ${storyId}-unit rejects an unobserved pass"`,
        "        kind: negative",
        "        asserts: a verdict without evidence is refused",
        "    expected_failure:",
        "      file: test/story.test.ts:1",
        "      assertion: the scenario passes from observed evidence",
        "      actual: undefined",
        "    observations:",
        "      - the run log names the scenario",
      ].join("\n"),
    });
  }
  // The deterministic CODE exit hands its findings back to the same session.
  // The mock cannot fix anything, so it answers in contract and lets the exit
  // decide again; the smoke asserts the exit, not the model.
  if (phaseInput.includes("The deterministic CODE exit checks did not pass")
    || phaseInput.includes("Phase: CODE")
    || phaseInput.includes("Phase: REGRESSION_FIX")) {
    return JSON.stringify({
      implementation: ["The deterministic integration implementation is ready.", addressedLines(phaseInput)]
        .filter(Boolean)
        .join("\n"),
    });
  }
  if (phaseInput.includes("Phase: MERGE")) {
    return JSON.stringify({ delivery_report: "The declared scenario passed blind verification." });
  }
  return `${scripted} | echo:${messageText(lastUser).slice(0, 80)}`;
}

function sseChunk(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === "/v1/models") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: MODEL_ID, object: "model", owned_by: "mock" }] }));
    return;
  }

  if (url.pathname !== "/v1/chat/completions") {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "not found", type: "invalid_request_error" } }));
    return;
  }

  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  let body = {};
  try {
    body = JSON.parse(raw || "{}");
  } catch {
    body = {};
  }

  if (process.env.MOCK_LOG_REQUESTS) {
    appendFileSync(process.env.MOCK_LOG_REQUESTS, raw + "\n");
  }

  const fault = currentFault(req);

  if (fault === "transport") {
    req.socket.destroy();
    return;
  }
  if (fault === "timeout") {
    // Hold the socket open without writing anything.
    return;
  }
  if (FAULTS[fault]) {
    const f = FAULTS[fault];
    res.writeHead(f.status, { "content-type": "application/json", ...f.headers });
    res.end(JSON.stringify(f.body));
    return;
  }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  const text = scriptedReply(messages);
  const created = 1700000000;
  const id = "chatcmpl-mock";
  const toolCall = wantsToolCall(messages);

  if (body.stream === false) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id,
      object: "chat.completion",
      created,
      model: MODEL_ID,
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    }));
    return;
  }

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  res.write(sseChunk({
    id, object: "chat.completion.chunk", created, model: MODEL_ID,
    choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
  }));

  if (toolCall) {
    const request = toolRequest(messages);
    res.write(sseChunk({
      id, object: "chat.completion.chunk", created, model: MODEL_ID,
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            id: "call_mock_1",
            type: "function",
            function: { name: request.name, arguments: JSON.stringify(request.arguments) },
          }],
        },
        finish_reason: null,
      }],
    }));
    res.write(sseChunk({
      id, object: "chat.completion.chunk", created, model: MODEL_ID,
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    }));
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }

  const midFault = fault === "mid_stream_drop";
  const words = text.split(" ");
  for (let i = 0; i < words.length; i++) {
    if (midFault && i === 3) {
      req.socket.destroy();
      return;
    }
    if (CHUNK_DELAY_MS) await sleep(CHUNK_DELAY_MS);
    res.write(sseChunk({
      id, object: "chat.completion.chunk", created, model: MODEL_ID,
      choices: [{ index: 0, delta: { content: (i ? " " : "") + words[i] }, finish_reason: null }],
    }));
  }

  res.write(sseChunk({
    id, object: "chat.completion.chunk", created, model: MODEL_ID,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  }));
  res.write("data: [DONE]\n\n");
  res.end();
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`mock-provider listening on http://127.0.0.1:${PORT}/v1 (fault file: ${FAULT_FILE || "none"})`);
});
