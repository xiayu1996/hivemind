import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

const execFileAsync = promisify(execFile);

const authStatus = z.object({
  status: z.string(),
  provider: z.string(),
  reason: z.string().optional(),
}).passthrough();

export interface ProviderReadiness {
  ready: boolean;
  provider: string;
  reason: string | null;
}

export function parseAuthProbeOutput(output: string, provider: string): ProviderReadiness {
  const parsed = authStatus.parse(JSON.parse(output) as unknown);
  if (parsed.provider !== provider) throw new Error(`auth probe returned provider ${parsed.provider}, expected ${provider}`);
  return {
    ready: parsed.status === "ready",
    provider,
    reason: parsed.reason ?? null,
  };
}

/** Probes credentials without permitting pi to refresh or mutate the credential file. */
export async function probeProviderReadiness(binary: string, provider: string): Promise<ProviderReadiness> {
  let output: string;
  try {
    output = (await execFileAsync(binary, [
      "auth", "check", "--provider", provider, "--json", "--no-refresh",
    ], { windowsHide: true, maxBuffer: 1024 * 1024 })).stdout;
  } catch (cause) {
    const stdout = (cause as { stdout?: unknown }).stdout;
    if (typeof stdout !== "string" || stdout.trim() === "") throw cause;
    output = stdout;
  }
  return parseAuthProbeOutput(output, provider);
}
