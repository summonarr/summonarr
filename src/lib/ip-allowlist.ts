import { isIP } from "node:net";
import { ipv6ToBigInt } from "./ipv6-parse";

// IP allowlist matching for exact addresses and CIDR ranges (IPv4 + IPv6).
//
// Used to restrict who may mint a machine session (POST /api/auth/machine-session).
// The match is fail-closed: an indeterminate client IP (e.g. getClientIp returns
// "unknown" when TRUST_PROXY is off or no X-Forwarded-For is present) never
// matches, so enabling the allowlist without a trusted proxy rejects every call.
//
// BigInt is used (IPv6 is 128-bit) via the constructor rather than `0n` literals
// because the project targets ES2017.

const ZERO = BigInt(0);
const EIGHT = BigInt(8);
const THIRTY_TWO = BigInt(32);
const MASK16 = BigInt(0xffff);
const MASK32 = BigInt(0xffffffff);

function ipv4ToBigInt(ip: string): bigint | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let v = ZERO;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    v = (v << EIGHT) | BigInt(n);
  }
  return v;
}

// Parse an address into a comparable integer + its bit width, or null if invalid.
// IPv4-mapped IPv6 (::ffff:a.b.c.d) is normalized to plain IPv4 so it matches v4
// allowlist entries — proxies vary in which form they forward.
function ipToBigInt(ip: string): { value: bigint; bits: number } | null {
  const fam = isIP(ip);
  if (fam === 4) {
    const v = ipv4ToBigInt(ip);
    return v === null ? null : { value: v, bits: 32 };
  }
  if (fam === 6) {
    const v = ipv6ToBigInt(ip);
    if (v === null) return null;
    if (v >> THIRTY_TWO === MASK16) return { value: v & MASK32, bits: 32 };
    return { value: v, bits: 128 };
  }
  return null;
}

/** Split a raw allowlist string (comma / whitespace / semicolon separated) into trimmed tokens. */
export function parseIpAllowlist(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** One allowlist entry, parsed: a client matches when its top `prefix` bits equal `value`'s. */
interface AllowlistRange { value: bigint; bits: number; prefix: number }

/**
 * Parse one allowlist entry — a bare address (a range of one) or a CIDR — or
 * null when it is invalid. The ONE parse both the PATCH validator and the
 * matcher use, so a stored entry the validator would refuse (a backup restore,
 * a hand edit) fails closed in the matcher too.
 */
function parseAllowlistEntry(entry: string): AllowlistRange | null {
  const slash = entry.indexOf("/");
  if (slash === -1) {
    const exact = ipToBigInt(entry);
    return exact ? { ...exact, prefix: exact.bits } : null;
  }
  const addr = entry.slice(0, slash);
  const base = ipToBigInt(addr);
  if (!base) return null;
  // Digits only: Number("") is 0, so "10.0.0.0/" would act as /0 and match
  // every same-family client.
  const prefixText = entry.slice(slash + 1);
  if (!/^\d{1,3}$/.test(prefixText)) return null;
  let prefix = Number(prefixText);
  // A mapped-v6 base (::ffff:a.b.c.d/N) is folded to 32 bits, so its prefix
  // still counts the 96 mapping bits — drop them; one that cuts into them has
  // no IPv4 meaning.
  if (base.bits === 32 && isIP(addr) === 6) {
    if (prefix < 96) return null;
    prefix -= 96;
  }
  if (prefix < 0 || prefix > base.bits) return null;
  return { ...base, prefix };
}

/** True if `token` is a valid bare IP (v4/v6) or a valid CIDR range. For PATCH-time validation. */
export function isValidIpOrCidr(token: string): boolean {
  return parseAllowlistEntry(token) !== null;
}

// The last allowlist parsed, keyed by its entries: the list is read per
// request, and it rarely changes, so each entry is parsed once, not per call.
let compiled: { key: string; ranges: AllowlistRange[] } | null = null;

function compileAllowlist(allowlist: string[]): AllowlistRange[] {
  const key = allowlist.join("\n");
  if (compiled?.key !== key) {
    const ranges: AllowlistRange[] = [];
    for (const entry of allowlist) {
      const range = parseAllowlistEntry(entry);
      if (range) ranges.push(range);
    }
    compiled = { key, ranges };
  }
  return compiled.ranges;
}

/**
 * True if `clientIp` matches any exact-IP or CIDR entry in `allowlist`.
 * Fail-closed: an unparseable/indeterminate clientIp returns false, and an
 * invalid entry matches nothing.
 * An empty allowlist also returns false — callers decide whether "no allowlist"
 * means "unrestricted" (skip the check) before calling this.
 */
export function isIpAllowed(clientIp: string, allowlist: string[]): boolean {
  const client = ipToBigInt(clientIp);
  if (!client) return false;
  for (const range of compileAllowlist(allowlist)) {
    if (range.bits !== client.bits) continue;
    const shift = BigInt(range.bits - range.prefix);
    if (client.value >> shift === range.value >> shift) return true;
  }
  return false;
}
