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

// A tool call gives the turn more than one LLM call, which is the only place a
// steering message can be delivered. Triggered by USE_TOOL in the user text.
function messageText(m) {
  if (typeof m?.content === "string") return m.content;
  if (Array.isArray(m?.content)) {
    return m.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join(" ");
  }
  return "";
}

function wantsToolCall(messages) {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const alreadyRan = messages.some((m) => m.role === "tool" || Array.isArray(m?.tool_calls));
  return messageText(lastUser).includes("USE_TOOL") && !alreadyRan;
}

function scriptedReply(messages) {
  const assistantCount = messages.filter((m) => m.role === "assistant").length;
  const scripted = SCRIPT[assistantCount] ?? `ACK-${assistantCount + 1} hivemind poc context anchor omega`;
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
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
    res.writeHead(f.status, { "content-type": "application/json", ...(f.headers ?? {}) });
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
    res.write(sseChunk({
      id, object: "chat.completion.chunk", created, model: MODEL_ID,
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            id: "call_mock_1",
            type: "function",
            function: { name: "bash", arguments: JSON.stringify({ command: "sleep 6; echo mock-tool-done" }) },
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
