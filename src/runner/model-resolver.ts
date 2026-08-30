import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const resolvedModel = Symbol("resolvedModel");

export interface ResolvedModel {
  provider: string;
  id: string;
  readonly [resolvedModel]: true;
}

export interface ModelDescriptor {
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

export function parseModelTable(output: string): ModelDescriptor[] {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0 || !/^provider\s+model\b/i.test(lines[0]!)) return [];
  const models: ModelDescriptor[] = [];
  for (const line of lines.slice(1)) {
    const [provider, id] = line.split(/\s+/);
    if (provider && id) models.push({ provider, id });
  }
  return models;
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
  return { provider, id: requestedId, [resolvedModel]: true };
}
