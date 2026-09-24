import { z } from "zod";
import type { ModelChoice, Role } from "../ports.ts";

/**
 * Which providers exist and which models serve each role. This changes more
 * often than anything else in the system (a new model ships, a flash model
 * overtakes a pro one, a plan's price moves), so it is a file, and no code
 * names a provider or a model id.
 */

const EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

const declaredModelSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    reasoning: z.boolean(),
    /** Without "image" the model is never sent a picture. */
    input: z.array(z.enum(["text", "image"])).min(1),
    contextWindow: z.number().int().positive(),
    maxTokens: z.number().int().positive(),
    /** A null level is one the model does not accept; the session clamps to the nearest accepted one. */
    thinkingLevelMap: z.partialRecord(z.enum(EFFORTS), z.string().nullable()).optional(),
    /** USD per million tokens. Required: a model without a price would make every run look free. */
    cost: z.object({ input: z.number().min(0), output: z.number().min(0), cacheRead: z.number().min(0), cacheWrite: z.number().min(0) }).strict(),
  })
  .strict();

const providerSchema = z
  .object({
    /**
     * subscription: a flat-rate plan; metered: billed per token. Informational
     * only: the budget counts both at the API-equivalent price.
     */
    billing: z.enum(["subscription", "metered"]),
    /** Secret holding the API key when it is not the name the model runtime expects for this provider. */
    apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
    /** A provider the model runtime does not ship. Its key comes from `apiKeyEnv`. */
    declaration: z
      .object({
        baseUrl: z.url(),
        api: z.enum(["openai-completions", "openai-responses", "anthropic-messages"]),
        models: z.array(declaredModelSchema).min(1),
      })
      .strict()
      .optional(),
  })
  .strict();

const candidateSchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1),
    effort: z.enum(EFFORTS),
  })
  .strict();

export const modelsFileSchema = z
  .object({
    providers: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), providerSchema),
    /** Candidates in order. The first usable one serves a session; the rest take over when it fails. */
    roles: z
      .object({
        planner: z.array(candidateSchema).min(1),
        builder: z.array(candidateSchema).min(1),
        evaluator: z.array(candidateSchema).min(1),
      })
      .strict(),
  })
  .strict();

export type ModelsFile = z.infer<typeof modelsFileSchema>;
export type ProviderEntry = ModelsFile["providers"][string];
export type DeclaredModel = z.infer<typeof declaredModelSchema>;

/** What the model runtime knows about a model id, or undefined when it knows nothing. */
export type ModelLookup = (provider: string, model: string) => { input: readonly string[] } | undefined;

/**
 * Every candidate must name a declared provider and a model the runtime knows.
 * Checked at startup because an unknown id is otherwise only discovered when a
 * session is opened on it, in the middle of someone's requirement.
 */
export function checkModels(file: ModelsFile, lookup: ModelLookup): string[] {
  const findings: string[] = [];
  for (const [providerId, provider] of Object.entries(file.providers)) {
    if (provider.declaration !== undefined && provider.apiKeyEnv === undefined) {
      findings.push(`provider ${providerId} is declared here, so it needs apiKeyEnv to say which secret holds its key`);
    }
  }
  for (const [role, candidates] of Object.entries(file.roles)) {
    const seen = new Set<string>();
    for (const candidate of candidates) {
      const key = `${candidate.provider}/${candidate.model}`;
      if (seen.has(key)) findings.push(`role ${role} lists ${key} twice`);
      seen.add(key);
      if (file.providers[candidate.provider] === undefined) {
        findings.push(`role ${role} uses provider ${candidate.provider}, which is not listed under providers`);
        continue;
      }
      if (lookup(candidate.provider, candidate.model) === undefined) {
        findings.push(`role ${role} uses ${key}, which the model runtime does not know`);
      }
    }
  }
  return findings;
}

export function candidatesFor(file: ModelsFile, role: Role): readonly ModelChoice[] {
  return file.roles[role];
}
