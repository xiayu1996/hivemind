import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function parseSecretsFile(content: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) throw new Error(`invalid secrets.env assignment for key ${line.split("=")[0]}`);
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values.set(key, value);
  }
  return values;
}

export async function loadSecretsFile(path = join(homedir(), ".hivemind", "secrets.env")): Promise<Map<string, string>> {
  try {
    return parseSecretsFile(await readFile(path, "utf8"));
  } catch (cause) {
    throw new Error(`cannot read ${path}: ${(cause as Error).message}`, { cause });
  }
}

export function defaultSecretsPath(): string {
  return join(homedir(), ".hivemind", "secrets.env");
}

/** Atomically persists a captured credential without printing it or rewriting unrelated lines. */
export async function upsertSecretFile(key: string, value: string, path = defaultSecretsPath()): Promise<void> {
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error("secret key is invalid");
  if (value.includes("\n") || value.includes("\r")) throw new Error("secret value must fit on one line");
  const current = await readFile(path, "utf8").catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === "ENOENT") return "";
    throw cause;
  });
  const replacement = `${key}=${value}`;
  let found = false;
  const lines = current.split(/\r?\n/).filter((line, index, all) => index < all.length - 1 || line !== "").map((line) => {
    if (line.trimStart().startsWith(`${key}=`)) {
      found = true;
      return replacement;
    }
    return line;
  });
  if (!found) lines.push(replacement);
  const temporary = `${path}.tmp-${process.pid}`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporary, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}
