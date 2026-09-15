import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PhaseLane } from "../pipeline/phase.js";

/**
 * The session file a phase is spawned against, and the routing label inside it.
 *
 * pi derives both `prompt_cache_key` and the `x-session-affinity` header from
 * the session id, and hivemind opens a new session per phase, so every phase
 * used to arrive at the provider with a fresh random key -- the cache was being
 * scattered deliberately. Pinning the id to the card and lane makes the
 * provider route a card's phases to one instance and hash their shared prefix
 * once.
 *
 * **What is shared is a routing label, not a conversation.** Every phase gets
 * its own file, each file holds a header and zero messages, and context is
 * still injected in full by `assemblePhasePrompt`. pi has no earlier messages
 * to read, so no bias has a carrier and byte-determinism is untouched.
 *
 * Verified against pi 0.85.1: a header-only file loads with `messageCount: 0`,
 * and two files carrying the same id both load without complaint.
 */

/** How widely a cache key is shared. `repo` trades routing concentration for a
 * longer shared prefix and is decided by measurement, not here. */
export type CacheKeyScope = "card" | "repo";

export interface SessionFileRequest {
  sessionRoot: string;
  cardId: string;
  phase: string;
  round: number;
  /** Distinguishes reruns of one round: failover and crash recovery both spawn
   * again at the same (phase, round), and two spawns must not share a file. */
  attempt: number;
  lane: PhaseLane;
  scope: CacheKeyScope;
  /** The scope's grouping value: the repository id when scope is `repo`. */
  repoId?: string;
}

export interface PinnedSession {
  /** Absolute path passed to pi as `--session`. */
  path: string;
  /** The pinned id, which becomes `prompt_cache_key` and the affinity header. */
  id: string;
}

/**
 * A UUID derived from the grouping key rather than drawn at random. The shape
 * has to be a UUID because pi clamps the value before sending it as
 * `prompt_cache_key`; the bits are a hash so two machines rebuilding the same
 * card agree without coordinating.
 */
export function deriveSessionId(input: { scope: CacheKeyScope; group: string; lane: PhaseLane }): string {
  const digest = createHash("sha256").update(`hivemind:${input.scope}:${input.group}:${input.lane}`, "utf8").digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  // Version 5 (name-based) and the RFC 4122 variant, so the value is a
  // well-formed UUID rather than a hex string that merely looks like one.
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Where one spawn's session file lives. Card, phase, round and attempt are all
 * in the path: with only phase and round, a failover or a crash-restart inside
 * one round would resolve to the file the previous attempt had already written
 * messages into, and pi would continue that conversation -- the session fork
 * the invariants forbid, happening silently.
 */
export function sessionFilePath(request: SessionFileRequest): string {
  return join(
    request.sessionRoot,
    request.cardId,
    request.phase,
    `r${request.round}-a${request.attempt}.jsonl`,
  );
}

function groupOf(request: SessionFileRequest): string {
  if (request.scope === "repo") {
    if (!request.repoId) throw new Error("cache key scope is repo but no repository id was given");
    return request.repoId;
  }
  return request.cardId;
}

export class SessionFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionFileError";
  }
}

/** Reads how many records a session file holds, 0 for one that is not there. */
export async function sessionMessageCount(path: string): Promise<number> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return 0;
  }
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  // The header is the first record and is not a message.
  return Math.max(0, lines.length - 1);
}

/**
 * Creates the header-only session file for a spawn, or reuses the one a crash
 * left behind at the same attempt.
 *
 * Pinning the id removes the probe that used to catch a mis-shared session:
 * unequal session ids were how a phase accidentally continuing another phase's
 * conversation would have shown up. The replacement is this assertion -- a
 * first spawn must find no messages -- plus the attempt in the path above.
 */
export async function pinSessionFile(request: SessionFileRequest, options?: { resuming?: boolean }): Promise<PinnedSession> {
  const path = sessionFilePath(request);
  const id = deriveSessionId({ scope: request.scope, group: groupOf(request), lane: request.lane });
  const existing = await sessionMessageCount(path);
  if (existing > 0 && !options?.resuming) {
    throw new SessionFileError(
      `session file ${path} already holds ${existing} messages; a first spawn must start from an empty session`,
    );
  }
  if (existing > 0) return { path, id };
  await mkdir(dirname(path), { recursive: true });
  const header = {
    type: "session",
    version: 3,
    id,
    // Fixed rather than the wall clock: the file is an input to a spawn, and
    // two rebuilds of the same round must produce the same bytes.
    timestamp: "1970-01-01T00:00:00.000Z",
    cwd: request.sessionRoot,
  };
  // Trailing newline is mandatory: appending to an unterminated last line
  // merges two records and loses both (pi#8345).
  await writeFile(path, `${JSON.stringify(header)}\n`, "utf8");
  return { path, id };
}
