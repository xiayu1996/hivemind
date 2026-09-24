import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * The service log: one JSON object per line, appended synchronously so the
 * order on disk is the order things happened and a crash loses at most the
 * line being written. Every line passes through `redact` first; nothing that
 * looks like a credential reaches the file or the terminal.
 */

export type Log = (event: string, data: Record<string, unknown>) => void;

/** Shapes of credentials that may appear in text the service did not write itself (tool output, provider errors). */
const CREDENTIAL_SHAPES: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\bntn_[A-Za-z0-9]{20,}/g,
  /\bsecret_[A-Za-z0-9]{30,}/g,
  /([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/@]+@/g,
];

/** Replaces every known secret value and every credential-shaped string with a marker. */
export function redactor(secrets: ReadonlyMap<string, string>): (text: string) => string {
  // Longest first, so a secret containing another is replaced whole.
  const values = [...secrets.values()].filter((value) => value.length >= 8).toSorted((left, right) => right.length - left.length);
  return (text) => {
    let result = text;
    for (const value of values) result = result.split(value).join("[secret]");
    for (const shape of CREDENTIAL_SHAPES) {
      result = result.replace(shape, (match, scheme?: string) => (typeof scheme === "string" && match.endsWith("@") ? `${scheme}[secret]@` : "[secret]"));
    }
    return result;
  };
}

export function createLog(options: { path: string; secrets: ReadonlyMap<string, string>; echo?: (line: string) => void }): Log {
  const redact = redactor(options.secrets);
  mkdirSync(dirname(options.path), { recursive: true });
  return (event, data) => {
    const line = redact(JSON.stringify({ at: new Date().toISOString(), event, ...data }));
    appendFileSync(options.path, `${line}\n`);
    options.echo?.(line);
  };
}
