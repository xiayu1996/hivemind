// Captures the raw pi RPC event types produced by one real bash tool call.
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";

const bin = join(homedir(), ".hivemind", "pi", "0.84.3", "pi", "pi.exe");
const cwd = mkdtempSync(join(homedir(), ".hivemind", "rpc-probe-"));
const child = spawn(bin, ["--mode", "rpc", "--no-context-files", "--provider", "zai-coding-cn", "--model", "glm-5.3-flash"], { cwd, stdio: ["pipe", "pipe", "pipe"] });
const types = new Map<string, number>();
let buffer = "";
child.stdout.on("data", (chunk: Buffer) => {
  buffer += chunk.toString("utf8");
  let index = buffer.indexOf("\n");
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) {
      try {
        const event = JSON.parse(line) as { type?: string; message?: { role?: string } };
        types.set(event.type ?? "?", (types.get(event.type ?? "?") ?? 0) + 1);
        const role = (event.message as { role?: string } | undefined)?.role;
        if (role) console.log(`${event.type} role=${role}`);
      } catch { /* partial line */ }
    }
    index = buffer.indexOf("\n");
  }
});
child.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));
child.stdin.write(JSON.stringify({ type: "prompt", message: "Run the bash command `echo rpc-probe-marker` and nothing else." }) + "\n");
setTimeout(() => {
  child.kill("SIGKILL");
  console.log("event type counts:", JSON.stringify([...types.entries()].toSorted((a, b) => b[1] - a[1])));
  process.exit(0);
}, 90_000);
