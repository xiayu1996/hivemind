import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const resolvedModel = Symbol("resolvedModel");

/**
 * What the provider catalogue says a model can do. Every field is optional
 * because a catalogue source may genuinely not know it: the mock providers the
 * smoke scripts use have no table to read, and an older pi prints fewer
 * columns. A caller that needs a field must say what it does when it is absent
 * rather than assume a default, because guessing a context window too large is
 * an overflow at the worst possible moment.
 */
export interface ModelCapabilities {
  contextWindow?: number;
  maxOutput?: number;
  thinking?: boolean;
  images?: boolean;
}

/** pi's reasoning-effort levels, as accepted by `--thinking`. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface ResolvedModel extends ModelCapabilities {
  provider: string;
  id: string;
  /**
   * The reasoning effort the purpose asks for, already checked against what the
   * model advertises. Absent means the level is left to pi: a model whose
   * catalogue row says it does not reason, or does not say either way, is never
   * sent one, because pi accepts an unusable spawn argument without complaint.
   */
  thinkingLevel?: ThinkingLevel;
  readonly [resolvedModel]: true;
}

/** Attaches a reasoning effort to a resolved model, if the model supports one. */
export function withThinkingLevel(model: ResolvedModel, level: ThinkingLevel | undefined): ResolvedModel {
  if (level === undefined || model.thinking !== true) return model;
  return { ...model, thinkingLevel: level };
}

export interface ModelDescriptor extends ModelCapabilities {
  provider: string;
  id: string;
}

export interface ModelCatalog {
  list(provider: string): Promise<ModelDescriptor[]>;
}

export interface PiModelCatalogOptions {
  binary: string;
  extensions?: string[];
  cwd?: string;
}

/**
 * The live catalogue, read from the pinned pi build. It only lists providers
 * whose credentials are already configured: with no key in the environment
 * `--list-models <provider>` prints nothing at all rather than an error, so an
 * empty list means "not authenticated here", not "no such provider".
 */
export class PiModelCatalog implements ModelCatalog {
  constructor(private readonly options: PiModelCatalogOptions) {}

  async list(provider: string): Promise<ModelDescriptor[]> {
    const args = [
      ...(this.options.extensions ?? []).flatMap((extension) => ["-e", extension]),
      "--offline",
      "--list-models",
      provider,
    ];
    const result = await execFileAsync(this.options.binary, args, {
      ...(this.options.cwd ? { cwd: this.options.cwd } : {}),
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    return parseModelTable(result.stdout);
  }
}

/** `1M` / `384K` / `128000` as printed in the table's context and max-out columns. */
export function parseTokenCount(cell: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)([KM]?)$/i.exec(cell);
  if (!match) return undefined;
  const scale = match[2]!.toUpperCase() === "M" ? 1_000_000 : match[2]!.toUpperCase() === "K" ? 1_000 : 1;
  return Math.round(Number(match[1]) * scale);
}

function parseFlag(cell: string | undefined): boolean | undefined {
  if (cell === "yes") return true;
  if (cell === "no") return false;
  return undefined;
}

/**
 * Reads `pi --list-models`. Columns beyond the id are what lets the rest of the
 * system size a prompt and decide whether a thinking level may be passed, so
 * they are kept rather than discarded; a row that stops early still yields the
 * provider and id it did print.
 */
export function parseModelTable(output: string): ModelDescriptor[] {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0 || !/^provider\s+model\b/i.test(lines[0]!)) return [];
  const models: ModelDescriptor[] = [];
  for (const line of lines.slice(1)) {
    const [provider, id, context, maxOut, thinking, images] = line.split(/\s+/);
    if (!provider || !id) continue;
    const contextWindow = context ? parseTokenCount(context) : undefined;
    const maxOutput = maxOut ? parseTokenCount(maxOut) : undefined;
    const supportsThinking = parseFlag(thinking);
    const supportsImages = parseFlag(images);
    models.push({
      provider,
      id,
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxOutput === undefined ? {} : { maxOutput }),
      ...(supportsThinking === undefined ? {} : { thinking: supportsThinking }),
      ...(supportsImages === undefined ? {} : { images: supportsImages }),
    });
  }
  return models;
}

/** A catalogue that answers from a fixed list. The mock provider used by the
 * smoke scripts has no `--list-models` command of its own, and a test double
 * must still pass through the same boundary a real spawn does. */
export function staticCatalog(models: readonly ModelDescriptor[]): ModelCatalog {
  return { list: async (provider) => models.filter((model) => model.provider === provider) };
}

/**
 * Memoises per provider for the life of the process. Listing costs a pi spawn
 * and the answer cannot change under a pinned build, but `resolve` is called
 * once per card; a long-lived orchestrator would otherwise spawn pi thousands
 * of times to be told the same thing. A failed listing is not cached.
 */
export function cachingCatalog(inner: ModelCatalog): ModelCatalog {
  const pending = new Map<string, Promise<ModelDescriptor[]>>();
  return {
    list(provider) {
      const cached = pending.get(provider);
      if (cached) return cached;
      const attempt = inner.list(provider).catch((cause: unknown) => {
        pending.delete(provider);
        throw cause;
      });
      pending.set(provider, attempt);
      return attempt;
    },
  };
}

/**
 * Tries each catalogue in order and takes the first non-empty answer. The live
 * catalogue is silent about a provider this host has no credentials for, which
 * is exactly the case where the recorded snapshot has to answer instead: a
 * machine without pi, or a reviewer's checkout, still validates configuration.
 */
export function firstNonEmptyCatalog(...catalogs: readonly ModelCatalog[]): ModelCatalog {
  return {
    async list(provider) {
      for (const catalog of catalogs) {
        const models = await catalog.list(provider).catch(() => [] as ModelDescriptor[]);
        if (models.length > 0) return models;
      }
      return [];
    },
  };
}

/** The sole boundary that turns an untrusted model id into a spawnable model. */
export async function resolveModel(
  catalog: ModelCatalog,
  provider: string,
  requestedId: string,
): Promise<ResolvedModel> {
  const exact = (await catalog.list(provider)).find((model) =>
    model.provider === provider && model.id === requestedId);
  if (!exact) throw new Error(`model is not present in the ${provider} catalogue: ${requestedId}`);
  return {
    ...(exact.contextWindow === undefined ? {} : { contextWindow: exact.contextWindow }),
    ...(exact.maxOutput === undefined ? {} : { maxOutput: exact.maxOutput }),
    ...(exact.thinking === undefined ? {} : { thinking: exact.thinking }),
    ...(exact.images === undefined ? {} : { images: exact.images }),
    provider,
    id: requestedId,
    [resolvedModel]: true,
  };
}
