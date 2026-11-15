// Field parsers for the two push registration routes (/api/push/subscribe,
// /api/push/apns). Every input is `unknown`: readJsonCapped<T>'s generic is a
// compile-time cast only, so `{"label":123}` reached a string method and
// answered 500 before these checked the type first. Pure, so the rules are
// testable without a request.
import { sanitizeText } from "./sanitize";

// APNs device tokens are 32 bytes (64 hex) today; Apple reserves the right to
// grow them, so accept a generous range — but whole bytes only (even-length
// hex, 32–100 bytes). The relay validates even-length; an odd-length token
// would register here but never deliver. apns-endpoint.ts relies on this shape.
const DEVICE_TOKEN_RE = /^(?:[0-9a-fA-F]{2}){32,100}$/;

/**
 * The APNs device token, trimmed and lowercased, or null when it isn't one.
 *
 * Lowercased because the hex regex accepts either case and the endpoint handle
 * (the unique key the cross-account 409 guard keys off) is derived from it:
 * without this, the same physical device token re-sent uppercased missed the
 * lookup, skipped the ownership check, and landed a SECOND row owned by the
 * caller — every push that row was entitled to then went to the original
 * owner's device. It also keeps a case-shifted re-registration from
 * duplicating instead of updating.
 */
export function parseApnsDeviceToken(raw: unknown): string | null {
  const token = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return DEVICE_TOKEN_RE.test(token) ? token : null;
}

/**
 * A device label, sanitized and bounded, or undefined to leave the stored one
 * alone. sanitizeText also strips control chars and bidi overrides: labels are
 * captured by the audit log, where a bidi override could spoof an identity.
 */
export function parsePushLabel(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  return sanitizeText(raw).slice(0, 100) || undefined;
}

/**
 * The optional E2E device public key (P-256, X9.63 uncompressed = 65 bytes,
 * base64). Stored only when well-formed; a malformed key means this device gets
 * generic (content-free) pushes instead of encrypted rich ones.
 *
 * "Absent" must not mean "clear it": a re-POST on an APNs token refresh (or
 * relaunch) while the device is locked can't read its Keychain key and omits
 * publicKey — writing a null through would permanently downgrade that device to
 * content-free pushes with no error anywhere. Only an explicit `null` clears.
 */
export function parseApnsPublicKey(raw: unknown): { kind: "keep" } | { kind: "set"; value: string | null } {
  if (raw === null) return { kind: "set", value: null };
  if (typeof raw === "string" && raw.length > 0 && raw.length <= 128) {
    const buf = Buffer.from(raw, "base64");
    if (buf.length === 65 && buf[0] === 0x04) return { kind: "set", value: raw };
  }
  return { kind: "keep" };
}

// Known push services. Checked before any DNS resolution, so a registration
// can't point the server's pushes at an arbitrary host (SSRF).
const PUSH_HOSTS = ["fcm.googleapis.com", "updates.push.services.mozilla.com", "push.services.mozilla.com"];
const PUSH_HOST_SUFFIXES = [".notify.windows.com", ".push.apple.com", ".web.push.apple.com", ".push.services.mozilla.com"];

export type WebPushEndpointVerdict = "ok" | "invalid-url" | "not-https" | "unrecognized";

/** Whether a Web Push endpoint is an https URL on a known push service. */
export function checkWebPushEndpoint(endpoint: string): WebPushEndpointVerdict {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return "invalid-url";
  }
  if (url.protocol !== "https:") return "not-https";
  // The known services listen on the default port only.
  if (url.port !== "") return "unrecognized";
  const host = url.hostname.toLowerCase();
  const known = PUSH_HOSTS.includes(host) || PUSH_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
  return known ? "ok" : "unrecognized";
}

/**
 * The stored key of a Web Push endpoint, without a DNS resolve: the same
 * canonical string resolveToSafeUrlWithAddrs (ssrf.ts) returns for a safe URL —
 * serialize, then collapse ONLY the bare-origin trailing slash. Keep the two in
 * step or unsubscribe misses the stored key. Null when it isn't an http(s) URL.
 */
export function canonicalizePushEndpoint(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const serialized = url.toString();
  const isBareOrigin = url.pathname === "/" && !url.search && !url.hash;
  return isBareOrigin ? serialized.replace(/\/$/, "") : serialized;
}
