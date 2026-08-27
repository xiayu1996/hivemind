#!/usr/bin/env node
// A stand-in for `pi --mode rpc` used by runner contract tests.
//
// FAKE_PI_MODE:
//   normal        - answers commands and replays a fixture on prompt
//   silent        - starts but never answers, so the handshake must time out
//   exit          - exits immediately
//   garbage       - emits a non-JSON line before answering
//   reject-prompt - answers prompt with success:false
//
// FAKE_PI_FIXTURE points at a captured event array to replay.

import { readFileSync } from "node:fs";

const MODE = process.env.FAKE_PI_MODE ?? "normal";
const FIXTURE = process.env.FAKE_PI_FIXTURE;

if (MODE === "exit") process.exit(3);

const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const respond = (cmd, id, extra = {}) => send({ type: "response", command: cmd, success: true, id, ...extra });

if (MODE === "garbage") process.stdout.write("this is not json\n");

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, i).replace(/\r$/, "");
    buffer = buffer.slice(i + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));

function handle(cmd) {
  if (MODE === "silent") return;

  switch (cmd.type) {
    case "get_state":
      respond("get_state", cmd.id, { data: { model: { id: "fake" }, sessionFile: "/tmp/fake.jsonl", messageCount: 0 } });
      return;
    case "set_auto_retry":
      respond("set_auto_retry", cmd.id);
      return;
    case "get_messages":
      respond("get_messages", cmd.id, { data: { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] } });
      return;
    case "abort":
      respond("abort", cmd.id);
      return;
    case "steer":
      respond("steer", cmd.id);
      return;
    case "prompt": {
      if (MODE === "reject-prompt") {
        send({ type: "response", command: "prompt", success: false, id: cmd.id, error: "agent is streaming" });
        return;
      }
      respond("prompt", cmd.id);
      replay();
      return;
    }
    default:
      send({ type: "response", command: cmd.type, success: false, id: cmd.id, error: "unknown command" });
  }
}

function replay() {
  if (FIXTURE) {
    for (const event of JSON.parse(readFileSync(FIXTURE, "utf8")).events) send(event);
    return;
  }
  send({ type: "agent_start" });
  send({ type: "turn_start" });
  send({
    type: "message_end",
    message: {
      role: "assistant", stopReason: "stop",
      usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, reasoning: 5, cost: { total: 0.001 } },
    },
  });
  send({ type: "agent_end", willRetry: false });
  send({ type: "agent_settled" });
}
