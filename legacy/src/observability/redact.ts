export const REDACTED = "[REDACTED]";

export interface RedactionContext {
  key: string | undefined;
}

/** One ordered stage in the in-process export redaction waterfall. */
export type RecordRedactor = (value: unknown, context: RedactionContext) => unknown;

const SECRET_FIELDS = new Set([
  "accesstoken",
  "authorization",
  "apikey",
  "clientsecret",
  "cookie",
  "password",
  "privatetoken",
  "refreshtoken",
  "secret",
  "setcookie",
]);

const credentialFieldRedactor: RecordRedactor = (value, context) => {
  if (!context.key) return value;
  const normalized = context.key.replace(/[-_]/g, "").toLowerCase();
  return SECRET_FIELDS.has(normalized) ? REDACTED : value;
};

const embeddedTokenRedactor: RecordRedactor = (value) => {
  if (typeof value !== "string") return value;
  return value
    .replace(/\bBearer\s+[^\s"',;]+/gi, `Bearer ${REDACTED}`)
    .replace(/\beyJ[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]+){0,2}\b/g, REDACTED)
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, REDACTED)
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, REDACTED);
};

export const DEFAULT_REDACTION_WATERFALL: readonly RecordRedactor[] = [
  credentialFieldRedactor,
  embeddedTokenRedactor,
];

function visit(value: unknown, key: string | undefined, waterfall: readonly RecordRedactor[]): unknown {
  let redacted = value;
  for (const stage of waterfall) redacted = stage(redacted, { key });

  if (Array.isArray(redacted)) {
    return redacted.map((item) => visit(item, undefined, waterfall));
  }
  if (typeof redacted !== "object" || redacted === null) return redacted;

  const copy: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(redacted)) {
    copy[childKey] = visit(childValue, childKey, waterfall);
  }
  return copy;
}

/**
 * Produces a redacted export copy. The canonical log record is never mutated:
 * redaction after persistence would either destroy forensic evidence or ship a
 * secret before the receiver had a chance to filter it.
 */
export function redactForExport<T>(
  record: T,
  waterfall: readonly RecordRedactor[] = DEFAULT_REDACTION_WATERFALL,
): T {
  return visit(record, undefined, waterfall) as T;
}
