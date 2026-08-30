/** Collects parseable JSON payloads from a model response that may wrap them
 * in reasoning remnants, prose or a code fence. Callers still validate the
 * payload against their own schema; an empty list means nothing parseable. */
export function jsonPayloadCandidates(raw: string): unknown[] {
  const candidates: unknown[] = [];
  const attempts: string[] = [raw];
  for (const match of raw.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) attempts.push(match[1]!.trim());
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) attempts.push(raw.slice(start, end + 1));
  for (const attempt of attempts) {
    try {
      candidates.push(JSON.parse(attempt));
    } catch {
      // Not JSON; keep looking for a parseable span.
    }
  }
  return candidates;
}
