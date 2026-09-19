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

  // ::ffff:0:0/96 is an IPv4 address carried in an IPv6 shape. Folding it is
  // what makes a mapped peer match the IPv4 range it came from; without this a
  // mapped address would compare against IPv6 ranges and match nothing.
  const mapped = bytes.slice(0, 10).every((byte) => byte === 0)
    && bytes[10] === 0xff && bytes[11] === 0xff;
  return mapped ? bytes.slice(12) : bytes;
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
      if (bytes === null) return { allowed: false, reason: "source_unavailable" };
      for (const network of networks) {
        if (matches(bytes, network)) return { allowed: true, matchedNetwork: network.cidr };
      }
      return { allowed: false, reason: "source_outside_allowed_networks" };
    },
  };
}

/**
 * Copy for each access state. Every state renders the same shell and a heading
 * with no operational value: the page cannot say more than the state it was
 * handed, because it was handed nothing else.
 */
const ACCESS_STATE_COPY: Record<ConsoleAccessPageState, {
  readonly heading: string;
  readonly detail: string;
  readonly retry: boolean;
}> = {
  denied: {
    heading: "\u5f53\u524d\u8bbe\u5907\u65e0\u6cd5\u8fdb\u5165\u540e\u53f0",
    detail: "\u65e0\u6cd5\u8bbf\u95ee\u3002\u8bf7\u5148\u8fde\u63a5\u5bb6\u5ead\u6216\u529e\u516c\u7f51\u7edc\uff0c\u7136\u540e\u9009\u62e9\u201c\u91cd\u65b0\u68c0\u67e5\u7f51\u7edc\u201d\u3002",
    retry: true,
  },
  not_found: {
    heading: "\u5c1a\u672a\u53d1\u73b0\u53ef\u8bbf\u95ee\u7684\u540e\u53f0",
    detail: "\u65e0\u6cd5\u8bbf\u95ee\u3002\u8bf7\u5148\u8fde\u63a5\u5bb6\u5ead\u6216\u529e\u516c\u7f51\u7edc\uff0c\u518d\u91cd\u65b0\u68c0\u67e5\u53ef\u7528\u7684\u540e\u53f0\u3002",
    retry: true,
  },
  checking: {
    heading: "\u6b63\u5728\u68c0\u67e5\u8bbf\u95ee\u6761\u4ef6",
    detail: "\u6b63\u5728\u786e\u8ba4\u5f53\u524d\u8bbe\u5907\u662f\u5426\u8fde\u63a5\u5bb6\u5ead\u6216\u529e\u516c\u7f51\u7edc\uff0c\u8bf7\u7a0d\u5019\u3002",
    retry: false,
  },
  error: {
    heading: "\u65e0\u6cd5\u5b8c\u6210\u8bbf\u95ee\u68c0\u67e5",
    detail: "\u76ee\u524d\u65e0\u6cd5\u786e\u8ba4\u5f53\u524d\u8bbe\u5907\u6240\u5728\u7684\u7f51\u7edc\u3002\u8bf7\u68c0\u67e5\u7f51\u7edc\u8fde\u63a5\u540e\u91cd\u65b0\u68c0\u67e5\uff1b\u786e\u8ba4\u901a\u8fc7\u524d\u4e0d\u4f1a\u5c55\u793a\u540e\u53f0\u5185\u5bb9\u3002",
    retry: true,
  },
  waiting: {
    heading: "\u6b63\u5728\u7b49\u5f85\u540e\u53f0\u54cd\u5e94",
    detail: "\u5f53\u524d\u8bbe\u5907\u5df2\u7ecf\u8fde\u63a5\u5bb6\u5ead\u6216\u529e\u516c\u7f51\u7edc\uff0c\u4f46\u540e\u53f0\u5c1a\u672a\u54cd\u5e94\uff1b\u9875\u9762\u4f1a\u7ee7\u7eed\u68c0\u67e5\uff0c\u4e5f\u53ef\u4ee5\u7a0d\u540e\u91cd\u8bd5\u3002",
    retry: true,
  },
};

const ACCESS_PAGE_STYLE = `:root{color-scheme:light}`
  + `body{margin:0;background:#f4f7fa;color:#172b3a;font-family:"IBM Plex Sans","Segoe UI",sans-serif;font-size:14px}`
  + `main{max-width:560px;margin:0 auto;padding:28px 28px;min-height:100vh;box-sizing:border-box}`
  + `h1{font-size:26px;margin:20px 0 12px}`
  + `h2{font-size:18px;margin:0 0 12px}`
  + `.access-state{background:#ffffff;border:1px solid #cbd5df;border-radius:10px;padding:20px;box-shadow:0 2px 8px #172b3a14}`
  + `p{margin:0 0 12px;line-height:1.6}`
  + `.access-badge{display:inline-block;border-radius:999px;background:#fff0ef;color:#b42318;padding:4px 12px;font-size:12px;margin-bottom:12px}`
  + `button{border:1px solid #173f63;background:#173f63;color:#ffffff;border-radius:6px;min-height:44px;padding:8px 20px;font:inherit;cursor:pointer}`
  + `button:hover{background:#0b6bcb;border-color:#0b6bcb}`;

/** Creates the data-independent access-check page. */
export function createConsoleAccessPage(): ConsoleAccessPage {
  return {
    renderDocument({ state }: { state: ConsoleAccessPageState }): string {
      const copy = ACCESS_STATE_COPY[state];
      const action = copy.retry
        ? `<button type="button" onclick="location.reload()">\u91cd\u65b0\u68c0\u67e5\u7f51\u7edc</button>`
        : "";
      return `<!doctype html>`
        + `<html lang="zh-CN"><head><meta charset="utf-8">`
        + `<meta name="viewport" content="width=device-width,initial-scale=1">`
        + `<title>\u8bbf\u95ee\u9a8c\u8bc1\uff5cHivemind</title>`
        + `<style>${ACCESS_PAGE_STYLE}</style></head><body><main>`
        + `<h1>\u8bbf\u95ee\u9a8c\u8bc1</h1>`
        + `<section class="access-state"><span class="access-badge">\u65e0\u6cd5\u8bbf\u95ee</span>`
        + `<h2>${copy.heading}</h2><p>${copy.detail}</p>${action}</section>`
        + `</main></body></html>`;
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
