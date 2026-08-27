// Minimal protocol-compliant RPC client for pi --mode rpc.
//
// Framing rule from docs/rpc.md: split on LF only. Node's readline also splits
// on U+2028/U+2029, which are legal inside JSON strings, so it must not be used.

import { spawn } from "node:child_process";

export const PI_BIN = process.env.PI_BIN ?? `${process.env.HOME}/.hivemind/pi/0.84.3/pi/pi`;

export class PiRpc {
  constructor(args, opts = {}) {
    this.events = [];
    this.responses = [];
    this.stderr = "";
    this.exited = null;
    this.waiters = [];
    this.nextId = 1;
    this.buffer = "";

    this.proc = spawn(PI_BIN, ["--mode", "rpc", ...args], {
      cwd: opts.cwd ?? process.cwd(),
      env: { ...process.env, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk) => this.#ingest(chunk));
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (chunk) => { this.stderr += chunk; });
    this.proc.on("exit", (code, signal) => { this.exited = { code, signal }; this.#drainWaiters(); });
  }

  #ingest(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      let line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        this.events.push({ type: "__unparseable__", raw: line });
        continue;
      }
      if (msg.type === "response") this.responses.push(msg);
      else this.events.push(msg);
      this.#drainWaiters();
    }
  }

  #drainWaiters() {
    this.waiters = this.waiters.filter((w) => {
      if (w.check()) { w.resolve(); return false; }
      if (this.exited && !w.allowExit) { w.reject(new Error(`pi exited before condition: ${w.label}`)); return false; }
      return true;
    });
  }

  waitFor(check, label, timeoutMs = 30000, allowExit = false) {
    if (check()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const w = { check, label, allowExit, resolve: null, reject: null };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w);
        reject(new Error(`timeout waiting for ${label}`));
      }, timeoutMs);
      w.resolve = () => { clearTimeout(timer); resolve(); };
      w.reject = (e) => { clearTimeout(timer); reject(e); };
      this.waiters.push(w);
      this.#drainWaiters();
    });
  }

  send(cmd) {
    const id = cmd.id ?? `r${this.nextId++}`;
    this.proc.stdin.write(JSON.stringify({ ...cmd, id }) + "\n");
    return id;
  }

  async request(cmd, timeoutMs = 30000) {
    const id = this.send(cmd);
    await this.waitFor(() => this.responses.some((r) => r.id === id), `response ${cmd.type}`, timeoutMs);
    return this.responses.find((r) => r.id === id);
  }

  eventsOfType(type) {
    return this.events.filter((e) => e.type === type);
  }

  async close() {
    try { this.proc.stdin.end(); } catch { /* already closed */ }
    if (this.exited) return this.exited;
    await new Promise((resolve) => {
      const t = setTimeout(() => { try { this.proc.kill("SIGKILL"); } catch { /* gone */ } resolve(); }, 5000);
      this.proc.on("exit", () => { clearTimeout(t); resolve(); });
    });
    return this.exited;
  }
}

export const MOCK_ARGS = (extPath) => [
  "-e", extPath,
  "--provider", "mock",
  "--model", "mock-1",
  "-nt",
];
