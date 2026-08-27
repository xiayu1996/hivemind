// pi extension: enforces the phase guard on every tool call.
//
// Loaded with `pi -e extensions/hive-guard.ts`. pi resolves TypeScript and .js
// specifiers to their .ts sources, so the red lines are imported from the same
// module the runner and the unit tests use. Duplicating them here would give a
// security boundary two sources of truth.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_FENCED_PATTERNS } from "../src/guard/danger-rules.js";
import {
  POLICY_ENV_VAR,
  compileFencedPatterns,
  parseGuardPolicy,
  type GuardPolicy,
} from "../src/guard/policy.js";
import { decideToolCall, type ToolCallEvent } from "../src/guard/tool-decision.js";

interface PiExtensionApi {
  on(event: string, handler: (event: ToolCallEvent) => unknown): void;
}

interface AuditRecord {
  ts: string;
  runId: string;
  cardId: string;
  phase: string;
  toolCallId: string;
  toolName: string;
  decision: "allow" | "deny";
  reason?: string | undefined;
  /** The command or path the decision was about. Never tool content. */
  target?: string | undefined;
}

/**
 * Appends one audit record.
 *
 * This is the secondary channel: the RPC event stream is primary, and this file
 * exists so a decision survives an event stream that was lost. A failure to
 * write is reported on stderr, which the event stream carries, and does not
 * block the call: the primary record still exists, and halting real work on a
 * transient filesystem error would trade a small evidence gap for an outage.
 */
function appendAudit(auditPath: string, record: AuditRecord): void {
  try {
    mkdirSync(dirname(auditPath), { recursive: true });
    appendFileSync(auditPath, `${JSON.stringify(record)}\n`, "utf8");
  } catch (cause) {
    console.error(`[hive-guard] audit append failed: ${(cause as Error).message}`);
  }
}

/**
 * Denies every tool call with one explanation.
 *
 * A guard that cannot read its own policy must not fall back to permitting
 * work: an unguarded phase looks identical to a guarded one from the outside,
 * and the failure would only surface as damage.
 */
function denyAll(api: PiExtensionApi, reason: string): void {
  console.error(`[hive-guard] ${reason}`);
  api.on("tool_call", () => ({ block: true, reason: `hive-guard: ${reason}` }));
}

export default function (api: PiExtensionApi): void {
  const raw = process.env[POLICY_ENV_VAR];
  if (raw === undefined || raw === "") {
    denyAll(api, `${POLICY_ENV_VAR} is not set, so no phase policy is in force`);
    return;
  }

  let policy: GuardPolicy;
  let fencedPatterns: RegExp[];
  try {
    policy = parseGuardPolicy(raw);
    fencedPatterns = [...DEFAULT_FENCED_PATTERNS, ...compileFencedPatterns(policy.fencedPatterns)];
  } catch (cause) {
    denyAll(api, `policy rejected: ${(cause as Error).message}`);
    return;
  }

  api.on("tool_call", (event: ToolCallEvent) => {
    let decision;
    try {
      decision = decideToolCall(event, policy, fencedPatterns);
    } catch (cause) {
      // An exception inside the guard is not evidence that the call is safe.
      decision = { block: true, reason: `guard failed: ${(cause as Error).message}` };
    }

    appendAudit(policy.auditPath, {
      ts: new Date().toISOString(),
      runId: policy.runId,
      cardId: policy.cardId,
      phase: policy.phase,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      decision: decision.block ? "deny" : "allow",
      reason: decision.reason,
      target: decision.target,
    });

    if (!decision.block) return;
    // No `terminate`: the run continues so the model can read the reason and
    // choose another approach instead of losing the whole phase.
    return { block: true, reason: `hive-guard: ${decision.reason ?? "blocked"}` };
  });
}
