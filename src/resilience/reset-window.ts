/**
 * When a rate-limited provider says its window reopens.
 *
 * Every subscription in the chain meters itself on windows (five hours, a
 * week, a month) and each words the refusal its own way: an absolute
 * timestamp, a duration counted from when the message was built, or only the
 * name of the window. Reading one shape and not the others is the whole
 * difference between waiting a window out and probing it: `command-code`
 * reported an exact reset three days out, nothing read it, and the breaker's
 * own backoff would have spent a dispatch against the same wall every twenty
 * minutes until then.
 *
 * So the readers are ordered by how much they know, not by provider:
 *
 *   absolute  an instant the provider named; needs no anchor, so trusted
 *             first. An instant already past is not used: the message is
 *             stale or the clocks disagree, and reopening on it turns a
 *             refusal into a tight loop.
 *   relative  a duration counted from the event's own timestamp, never from
 *             the clock when we read it: an event that waited in a backlog
 *             would compute a window that has already expired.
 *   named     the window's length with no phase ("weekly"). It says nothing
 *             about when this window ends (it may have a minute left), so it
 *             never becomes a wait. It bounds how far a blind backoff may
 *             grow, the one thing a length can settle.
 */

export type ResetWindowSource = "absolute" | "relative" | "named";

export interface ResetWindow {
  /** The instant the window reopens; null when only its length is known. */
  resetAt: number | null;
  /** The named length of the window, when the provider named one. */
  windowMs: number | null;
  source: ResetWindowSource;
  /** The phrase this was read from, for the log line a person reads. */
  text: string;
}

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Beyond this a match is a parse artifact rather than a window; a month is
 * the longest window any provider in the chain meters on. */
const MAX_WINDOW_MS = 60 * DAY;

const UNIT_MS: Record<string, number> = {
  s: SECOND, sec: SECOND, secs: SECOND, second: SECOND, seconds: SECOND,
  m: MINUTE, min: MINUTE, mins: MINUTE, minute: MINUTE, minutes: MINUTE,
  h: HOUR, hr: HOUR, hrs: HOUR, hour: HOUR, hours: HOUR,
  d: DAY, day: DAY, days: DAY,
};

const NAMED_WINDOW_MS: Record<string, number> = {
  hourly: HOUR, daily: DAY, weekly: 7 * DAY, monthly: 30 * DAY,
};

/** A word that makes a nearby number a reset time rather than a quota figure,
 * a model version or a request id. */
const RESET_CONTEXT = "(?:reset|resets|resets_at|reset_at|available|try again|retry|retry-after|retry_after|wait|until|window)";

const ISO_AT = new RegExp(`${RESET_CONTEXT}[^0-9]{0,40}(\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d+)?)?(?:Z|[+-]\\d{2}:?\\d{2})?)`, "i");
const EPOCH_AT = new RegExp(`${RESET_CONTEXT}[^0-9]{0,20}(\\d{10}|\\d{13})\\b`, "i");
/** Durations in bare seconds. First pi's own report of a provider's
 * Retry-After that exceeded what pi sleeps for ("Server requested 3600s retry
 * delay (max: 60s)"), which is the header itself and so outranks any prose
 * appended after it; then a Retry-After quoted in the message. */
const SECONDS = [/requested (\d{1,7})s retry delay/i, /retry[- _]after[^0-9]{0,10}(\d{1,7})\b/i];
const DURATION = new RegExp(`(?:in|after|within)\\s*~?\\s*((?:\\d+\\s*(?:${Object.keys(UNIT_MS).join("|")})\\b\\s*){1,3})`, "i");
const DURATION_PART = new RegExp(`(\\d+)\\s*(${Object.keys(UNIT_MS).join("|")})\\b`, "gi");
const NAMED = new RegExp(`\\b(?:(${Object.keys(NAMED_WINDOW_MS).join("|")})|(\\d{1,3})[- ]hour)\\b`, "i");

function absoluteWindow(message: string, eventTimeMs: number): ResetWindow | null {
  const iso = ISO_AT.exec(message);
  if (iso) {
    const parsed = Date.parse(iso[1]!.replace(" ", "T"));
    if (Number.isFinite(parsed) && parsed > eventTimeMs && parsed - eventTimeMs <= MAX_WINDOW_MS) {
      return { resetAt: parsed, windowMs: null, source: "absolute", text: iso[0] };
    }
  }
  const epoch = EPOCH_AT.exec(message);
  if (epoch) {
    const digits = epoch[1]!;
    const parsed = digits.length === 10 ? Number(digits) * SECOND : Number(digits);
    if (parsed > eventTimeMs && parsed - eventTimeMs <= MAX_WINDOW_MS) {
      return { resetAt: parsed, windowMs: null, source: "absolute", text: epoch[0] };
    }
  }
  return null;
}

function relativeWindow(message: string, eventTimeMs: number): ResetWindow | null {
  for (const pattern of SECONDS) {
    const seconds = pattern.exec(message);
    if (!seconds) continue;
    const ms = Number(seconds[1]) * SECOND;
    if (ms > 0 && ms <= MAX_WINDOW_MS) {
      return { resetAt: eventTimeMs + ms, windowMs: null, source: "relative", text: seconds[0] };
    }
  }
  const duration = DURATION.exec(message);
  if (!duration) return null;
  let ms = 0;
  for (const part of duration[1]!.matchAll(DURATION_PART)) {
    ms += Number(part[1]) * (UNIT_MS[part[2]!.toLowerCase()] ?? 0);
  }
  if (ms <= 0 || ms > MAX_WINDOW_MS) return null;
  return { resetAt: eventTimeMs + ms, windowMs: null, source: "relative", text: duration[0].trim() };
}

function namedWindow(message: string): ResetWindow | null {
  const match = NAMED.exec(message);
  if (!match) return null;
  const named = match[1]?.toLowerCase();
  const hours = match[2] === undefined ? undefined : Number(match[2]);
  const windowMs = named !== undefined ? NAMED_WINDOW_MS[named]! : hours! * HOUR;
  if (windowMs <= 0 || windowMs > MAX_WINDOW_MS) return null;
  return { resetAt: null, windowMs, source: "named", text: match[0] };
}

/**
 * What the message says about its window, or null when it says nothing.
 *
 * `eventTimeMs` is the instant the provider produced the message and has no
 * default on purpose: a relative duration anchored to "when we read it" is
 * wrong by however long the event waited to be read.
 */
export function readResetWindow(
  message: string | null | undefined,
  eventTimeMs: number,
): ResetWindow | null {
  if (typeof message !== "string" || message === "") return null;
  return absoluteWindow(message, eventTimeMs)
    ?? relativeWindow(message, eventTimeMs)
    ?? namedWindow(message);
}

/**
 * How far a blind backoff may grow for this provider.
 *
 * Only a named window changes it, and only upwards: a week-long window probed
 * on the policy's four-hour ceiling spends eighteen dispatches against a wall
 * that was never going to move. A quarter of the window keeps enough probes to
 * catch a window that is nearly over without turning the length into a wait.
 */
export function backoffCeilingMs(window: ResetWindow | null, policyCeilingMs: number): number {
  if (window === null || window.windowMs === null) return policyCeilingMs;
  return Math.max(policyCeilingMs, Math.min(window.windowMs / 4, DAY));
}
