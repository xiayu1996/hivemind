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

async function authCheck(
  binary: string,
  provider: string,
  extraArgs: string[],
  env?: Record<string, string>,
): Promise<ProviderReadiness> {
  let output: string;
  try {
    output = (await execFileAsync(binary, [
      "auth", "check", "--provider", provider, "--json", ...extraArgs,
    ], {
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      ...(env ? { env: { ...process.env, ...env } } : {}),
    })).stdout;
  } catch (cause) {
    // `auth check` exits non-zero for some not_ready states but still prints the
    // JSON status; the exit code alone is not the answer.
    const stdout = (cause as { stdout?: unknown }).stdout;
    if (typeof stdout !== "string" || stdout.trim() === "") throw cause;
    output = stdout;
  }
  return parseAuthProbeOutput(output, provider);
}

/**
 * Probes credentials without permitting pi to refresh or mutate the credential
 * file. An api_key provider needs its key in `env`: without it pi reports the
 * provider as unconfigured, which is indistinguishable from a missing key.
 */
export async function probeProviderReadiness(
  binary: string,
  provider: string,
  env?: Record<string, string>,
): Promise<ProviderReadiness> {
  return authCheck(binary, provider, ["--no-refresh"], env);
}

/**
 * The refreshing variant, which rotates the token in the shared credential
 * file. Only the process holding the refresh lock may call it: see
 * `refreshCredentialsOnce`. Everything else probes read-only.
 */
export async function refreshProviderCredentials(
  binary: string,
  provider: string,
  env?: Record<string, string>,
): Promise<ProviderReadiness> {
  return authCheck(binary, provider, [], env);
}
