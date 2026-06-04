import { isIP } from "node:net";

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
const SIXTEEN = BigInt(16);
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

function ipv6ToBigInt(ip: string): bigint | null {
  // Drop any zone id (fe80::1%eth0).
  const pct = ip.indexOf("%");
  if (pct !== -1) ip = ip.slice(0, pct);

  const halves = ip.split("::");
  if (halves.length > 2) return null;

  const parseGroups = (segment: string): bigint[] | null => {
    if (segment === "") return [];
    const groups = segment.split(":");
    const out: bigint[] = [];
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      // A trailing embedded IPv4 (::ffff:1.2.3.4) is only valid as the last group.
      if (g.includes(".")) {
        if (i !== groups.length - 1) return null;
        const v4 = ipv4ToBigInt(g);
        if (v4 === null) return null;
        out.push((v4 >> SIXTEEN) & MASK16);
        out.push(v4 & MASK16);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      out.push(BigInt(parseInt(g, 16)));
    }
    return out;
  };

  let groups: bigint[];
  if (halves.length === 2) {
    const head = parseGroups(halves[0]);
    const tail = parseGroups(halves[1]);
    if (head === null || tail === null) return null;
    const missing = 8 - (head.length + tail.length);
    if (missing < 0) return null;
    groups = [...head, ...Array<bigint>(missing).fill(ZERO), ...tail];
  } else {
    const all = parseGroups(ip);
    if (all === null) return null;
    groups = all;
  }
  if (groups.length !== 8) return null;
  let v = ZERO;
  for (const g of groups) v = (v << SIXTEEN) | g;
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

/** True if `token` is a valid bare IP (v4/v6) or a valid CIDR range. For PATCH-time validation. */
export function isValidIpOrCidr(token: string): boolean {
  const slash = token.indexOf("/");
  if (slash === -1) return isIP(token) !== 0;
  const addr = token.slice(0, slash);
  const prefixStr = token.slice(slash + 1);
  const fam = isIP(addr);
  if (fam === 0) return false;
  if (!/^\d{1,3}$/.test(prefixStr)) return false;
  const prefix = Number(prefixStr);
  return prefix >= 0 && prefix <= (fam === 4 ? 32 : 128);
}

/**
 * True if `clientIp` matches any exact-IP or CIDR entry in `allowlist`.
 * Fail-closed: an unparseable/indeterminate clientIp returns false.
 * An empty allowlist also returns false — callers decide whether "no allowlist"
 * means "unrestricted" (skip the check) before calling this.
 */
export function isIpAllowed(clientIp: string, allowlist: string[]): boolean {
  const client = ipToBigInt(clientIp);
  if (!client) return false;

  for (const entry of allowlist) {
    const slash = entry.indexOf("/");
    if (slash === -1) {
      const target = ipToBigInt(entry);
      if (target && target.bits === client.bits && target.value === client.value) {
        return true;
      }
      continue;
    }
    const target = ipToBigInt(entry.slice(0, slash));
    const prefix = Number(entry.slice(slash + 1));
    if (!target || target.bits !== client.bits) continue;
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > target.bits) continue;
    const shift = BigInt(target.bits - prefix);
    if (client.value >> shift === target.value >> shift) return true;
  }
  return false;
}
