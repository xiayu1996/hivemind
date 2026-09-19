import type { FastifyReply } from "fastify";
import { isIP } from "node:net";

/** Network ranges are validated configuration values in CIDR notation. */
export type ConsoleAllowedNetwork = string;

export const CONSOLE_ALLOWED_NETWORKS_CONFIG_KEY = "console.allowedNetworks";
export const CONSOLE_ACCESS_DENIED_STATUS = 403;

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

/** An address as 4 or 16 bytes. An IPv4-mapped IPv6 address is folded to its
 * IPv4 form so a mapped peer matches the IPv4 range it actually belongs to. */
type AddressBytes = number[];

interface ParsedNetwork {
  /** The range as configured, returned verbatim when it matches. */
  readonly cidr: ConsoleAllowedNetwork;
  readonly bytes: AddressBytes;
  readonly prefix: number;
}

function parseIpv4(value: string): AddressBytes | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    bytes.push(octet);
  }
  return bytes;
}

function parseIpv6Group(text: string): number | null {
  if (!/^[0-9a-fA-F]{1,4}$/.test(text)) return null;
  return Number.parseInt(text, 16);
}

/**
 * Parses IPv6 into bytes without trusting the input's own shorthand: an
 * embedded IPv4 tail is folded into two hex groups first, `::` expands to the
 * missing zero groups, and a zone suffix is dropped. Anything else is rejected
 * rather than guessed at.
 */
function parseIpv6(value: string): AddressBytes | null {
  let address = value;
  const zone = address.indexOf("%");
  if (zone !== -1) address = address.slice(0, zone);

  const embedded = address.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (embedded) {
    const embeddedText = embedded[1] ?? "";
    const octets = parseIpv4(embeddedText);
    if (octets === null) return null;
    const high = ((octets[0] ?? 0) << 8) | (octets[1] ?? 0);
    const low = ((octets[2] ?? 0) << 8) | (octets[3] ?? 0);
    address = `${address.slice(0, address.length - embeddedText.length)}${high.toString(16)}:${low.toString(16)}`;
  }

  const double = address.indexOf("::");
  if (double !== address.lastIndexOf("::")) return null;
  const headText = double === -1 ? address : address.slice(0, double);
  const tailText = double === -1 ? "" : address.slice(double + 2);
  const head = headText === "" ? [] : headText.split(":");
  const tail = tailText === "" ? [] : tailText.split(":");

  const headValues: number[] = [];
  for (const text of head) {
    const parsed = parseIpv6Group(text);
    if (parsed === null) return null;
    headValues.push(parsed);
  }
  const tailValues: number[] = [];
  for (const text of tail) {
    const parsed = parseIpv6Group(text);
    if (parsed === null) return null;
    tailValues.push(parsed);
  }

  let groups: number[];
  if (double === -1) {
    if (headValues.length !== 8) return null;
    groups = headValues;
  } else {
    const missing = 8 - headValues.length - tailValues.length;
    if (missing < 1) return null;
    groups = [...headValues, ...Array.from<number>({ length: missing }).fill(0), ...tailValues];
  }
  const bytes = groups.flatMap((groupValue) => [(groupValue >> 8) & 0xff, groupValue & 0xff]);

  return bytes;
}

function parseAddress(value: string): AddressBytes | null {
  const family = isIP(value);
  if (family === 4) return parseIpv4(value);
  if (family === 6) return parseIpv6(value);
  return null;
}

/** Whether a configured value is a usable IPv4 or IPv6 CIDR range. Exported so
 * the configuration schema rejects a malformed range on write instead of
 * letting it widen or silently empty the allowed set. */
export function isConsoleAllowedNetwork(value: string): boolean {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return false;
  const address = value.slice(0, slash);
  const prefixText = value.slice(slash + 1);
  if (!/^\d{1,3}$/.test(prefixText)) return false;
  const prefix = Number(prefixText);
  const bytes = parseAddress(address);
  if (bytes === null) return false;
  return bytes.length === 4 ? prefix <= 32 : prefix <= 128;
}

function parseNetwork(cidr: string): ParsedNetwork | null {
  if (!isConsoleAllowedNetwork(cidr)) return null;
  const address = cidr.slice(0, cidr.indexOf("/"));
  const prefix = Number(cidr.slice(cidr.indexOf("/") + 1));
  const bytes = parseAddress(address);
  return bytes === null ? null : { cidr, bytes, prefix };
}

function matches(bytes: AddressBytes, network: ParsedNetwork): boolean {
  if (bytes.length !== network.bytes.length) return false;
  const whole = network.prefix >> 3;
  for (let index = 0; index < whole; index++) {
    if (bytes[index] !== network.bytes[index]) return false;
  }
  const remainder = network.prefix & 7;
  if (remainder > 0) {
    const mask = (0xff << (8 - remainder)) & 0xff;
    if ((bytes[whole]! & mask) !== (network.bytes[whole]! & mask)) return false;
  }
  return true;
}

/** Parses and validates configured ranges without widening private networks. */
export function createConsoleAccessPolicy(config: ConsoleAccessConfig): ConsoleAccessPolicy {
  const networks = config.allowedNetworks.map((cidr) => {
    const parsed = parseNetwork(cidr);
    if (parsed === null) throw new Error(`invalid allowed console network: ${cidr}`);
    return parsed;
  });
  return {
    authorize(source: ConsoleConnectionSource): ConsoleAccessDecision {
      if (networks.length === 0) return { allowed: false, reason: "allowed_networks_unconfigured" };
      const bytes = source.remoteAddress === null ? null : parseAddress(source.remoteAddress);
      if (bytes === null) return { allowed: false, reason: "source_outside_allowed_networks" };
      for (const network of networks) {
        if (matches(bytes, network)) return { allowed: true, matchedNetwork: network.cidr };
      }
      return { allowed: false, reason: "source_outside_allowed_networks" };
    },
  };
}

/** Creates the data-independent access-check page. */
export function createConsoleAccessPage(): ConsoleAccessPage {
  return {
    renderDocument(): string {
      return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">`
        + `<meta name="viewport" content="width=device-width,initial-scale=1">`
        + `<title>\u8bbf\u95ee\u9a8c\u8bc1\uff5cHivemind</title></head><body><main>`
        + `<h1>\u8bbf\u95ee\u9a8c\u8bc1</h1></main></body></html>`;
    },
  };
}

/**
 * Terminates a denied request as HTML for page navigation or as a fixed JSON
 * envelope for API and mutation calls. It must not call a data or write port.
 */
export async function sendConsoleAccessDenied(
  reply: FastifyReply,
  requestKind: "page" | "api",
  decision: Extract<ConsoleAccessDecision, { allowed: false }>,
  page: ConsoleAccessPage,
): Promise<void> {
  reply.code(CONSOLE_ACCESS_DENIED_STATUS);
  if (requestKind === "page") {
    await reply.type("text/html; charset=utf-8").send(page.renderDocument({ state: "denied" }));
    return;
  }
  const payload: ConsoleAccessDeniedPayload = { error: "console_access_denied", reason: decision.reason };
  await reply.type("application/json; charset=utf-8").send(payload);
}
