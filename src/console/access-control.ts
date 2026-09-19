import type { FastifyReply } from "fastify";

/** Network ranges are validated configuration values in CIDR notation. */
export type ConsoleAllowedNetwork = string;

export declare const CONSOLE_ALLOWED_NETWORKS_CONFIG_KEY: "console.allowedNetworks";
export declare const CONSOLE_ACCESS_DENIED_STATUS: 403;

export interface ConsoleAccessConfig {
  /** An empty collection denies every request. */
  allowedNetworks: readonly ConsoleAllowedNetwork[];
}

/**
 * The transport peer observed by the server. Caller-controlled forwarding
 * headers are deliberately absent from this contract.
 */
export interface ConsoleConnectionSource {
  remoteAddress: string | null;
}

export type ConsoleAccessDenialReason =
  | "allowed_networks_unconfigured"
  | "source_unavailable"
  | "source_outside_allowed_networks";

export type ConsoleAccessDecision =
  | { allowed: true; matchedNetwork: ConsoleAllowedNetwork }
  | { allowed: false; reason: ConsoleAccessDenialReason };

/**
 * Owns an immutable snapshot of the configured ranges. An individual decision
 * never observes two versions.
 */
export interface ConsoleAccessPolicy {
  authorize(source: ConsoleConnectionSource): ConsoleAccessDecision;
}

export type ConsoleAccessPageState =
  | "denied"
  | "not_found"
  | "checking"
  | "error"
  | "waiting";

export interface ConsoleAccessDeniedPayload {
  error: "console_access_denied";
  reason: ConsoleAccessDenialReason;
}

/**
 * The access page accepts no console data, making denied and indeterminate
 * responses structurally unable to render operational content.
 */
export interface ConsoleAccessPage {
  renderDocument(input: { state: ConsoleAccessPageState }): string;
}

/** Parses and validates configured ranges without widening private networks. */
export declare function createConsoleAccessPolicy(config: ConsoleAccessConfig): ConsoleAccessPolicy;

/** Creates the data-independent access-check page. */
export declare function createConsoleAccessPage(): ConsoleAccessPage;

/**
 * Terminates a denied request as HTML for page navigation or as a fixed JSON
 * envelope for API and mutation calls. It must not call a data or write port.
 */
export declare function sendConsoleAccessDenied(
  reply: FastifyReply,
  requestKind: "page" | "api",
  decision: Extract<ConsoleAccessDecision, { allowed: false }>,
  page: ConsoleAccessPage,
): Promise<void>;
