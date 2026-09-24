/** Every balanced top-level object span, so a draft payload and the answer
 * that supersedes it are both offered to the caller rather than merged into
 * one unparseable span. String contents are skipped so a brace inside a value
 * cannot open or close a span. */
function balancedObjectSpans(raw: string): string[] {
  const spans: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) spans.push(raw.slice(start, index + 1));
    }
  }
  return spans;
}

/** Collects parseable JSON payloads from a model response that may wrap them
 * in reasoning remnants, prose or a code fence. Callers still validate the
 * payload against their own schema; an empty list means nothing parseable.
 * Order follows the response, so a caller whose contract is fail-closed can
 * weigh a later payload against an earlier one instead of trusting the first. */
export function jsonPayloadCandidates(raw: string): unknown[] {
  const candidates: unknown[] = [];
  const attempts: string[] = [raw];
  for (const match of raw.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) attempts.push(match[1]!.trim());
  attempts.push(...balancedObjectSpans(raw));
  for (const attempt of attempts) {
    try {
      candidates.push(JSON.parse(attempt));
    } catch {
      // Not JSON; keep looking for a parseable span.
    }
  }
  return candidates;
}
