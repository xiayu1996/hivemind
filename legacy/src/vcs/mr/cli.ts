import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CliExecutor } from "./types.js";

const execFileAsync = promisify(execFile);

export const processCliExecutor: CliExecutor = {
  async run(binary, args) {
    const result = await execFileAsync(binary, args, { windowsHide: true, maxBuffer: 1024 * 1024 });
    return { stdout: result.stdout, stderr: result.stderr };
  },
  async available(binary) {
    try {
      await execFileAsync(process.platform === "win32" ? "where.exe" : "which", [binary], { windowsHide: true });
      return true;
    } catch {
      return false;
    }
  },
};
