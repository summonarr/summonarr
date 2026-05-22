

import dns from "dns/promises";
import { isIP } from "net";

// Recognise an IPv4-mapped IPv6 address (`::ffff:…`) in either the dotted-quad form
// (`::ffff:127.0.0.1`) or the all-hex form (`::ffff:7f00:1`). Returns the unwrapped
// IPv4 dotted string so callers can apply IPv4 rules without having to special-case
// every regex. Both forms are valid Node IPv6 representations and both must be blocked.
function unwrapV4Mapped(addr: string): string | null {
  if (!/^::ffff:/i.test(addr)) return null;
  const tail = addr.slice("::ffff:".length);

  // Dotted-quad form: trivially the IPv4 portion
  if (/^\d+\.\d+\.\d+\.\d+$/.test(tail)) return tail;

  // Hex pair form: two 16-bit groups (each 1-4 hex digits) separated by a colon
  const m = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(tail);
  if (!m) return null;
  const hi = parseInt(m[1], 16);
  const lo = parseInt(m[2], 16);
  if (Number.isNaN(hi) || Number.isNaN(lo) || hi > 0xffff || lo > 0xffff) return null;
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

// Detect the IPv6 unspecified address (`::`) in any of its valid notations.
// The previous regex `/^::?0?$/` only caught `::`, `::0`, and the bogus `:0`/`:`.
// It missed the fully-expanded form (`0:0:0:0:0:0:0:0`), the zero-padded form
// (`0000:0000:0000:0000:0000:0000:0000:0000`), and mixed-notation embedded IPv4
// (`::0.0.0.0`, `::ffff:0.0.0.0`). All of these are valid representations of
// `::` and must be blocked — letting any through means a user-controlled URL
// can hit `0.0.0.0` (= "all local interfaces") via IPv6.
function isUnspecifiedV6(addr: string): boolean {
  // Reject anything with characters outside the IPv6 alphabet quickly
  if (!/^[0-9a-f:.]+$/i.test(addr)) return false;

  // Mixed notation: trailing dotted-quad embedded in IPv6 (e.g. `::0.0.0.0`)
  // Split off the IPv4 portion and check both halves are all-zero.
  const lastColon = addr.lastIndexOf(":");
  if (lastColon !== -1 && /\./.test(addr.slice(lastColon + 1))) {
    const v6Part = addr.slice(0, lastColon + 1); // includes trailing colon
    const v4Part = addr.slice(lastColon + 1);
    // v4 part must be 0.0.0.0
    if (!/^0+\.0+\.0+\.0+$/.test(v4Part)) return false;
    // v6 part must be all zeros / compressed — e.g. `::`, `::ffff:`, `0:0:0:0:0:0:`,
    // `0:0:0:0:0:ffff:`. Strip colons and `ffff` (the IPv4-mapped marker) and zeros;
    // anything left means it's not the unspecified address.
    const stripped = v6Part.replace(/[:0]/g, "").toLowerCase();
    return stripped === "" || stripped === "ffff";
  }

  // Pure IPv6 form. Strip colons; only zeros (or empty after `::`) means unspecified.
  const stripped = addr.replace(/:/g, "");
  return stripped === "" || /^0+$/.test(stripped);
}

function isSafeAddr(addr: string): boolean {
  // IPv4-mapped IPv6 — unwrap and recurse so IPv4 rules apply to both ::ffff:1.2.3.4 and ::ffff:0102:0304
  const v4 = unwrapV4Mapped(addr);
  if (v4 !== null) return isSafeAddr(v4);

  // Loopback
  if (/^127\./.test(addr)) return false;
  if (/^::1$/.test(addr)) return false;
  // Unspecified / any-address
  if (/^0\./.test(addr)) return false;
  if (isUnspecifiedV6(addr)) return false;
  // Link-local (APIPA)
  if (/^fe80:/i.test(addr)) return false;
  if (/^169\.254\./.test(addr)) return false;
  // Deprecated IPv6 site-local (fec0::/10) — still in some stacks; treat as private
  if (/^fe[c-f][0-9a-f]:/i.test(addr)) return false;
  // CGNAT shared address space (100.64/10) — also used for Docker internal ranges on some hosts
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(addr)) return false;
  // Multicast
  if (/^(22[4-9]|23[0-9])\./.test(addr)) return false;
  if (/^ff/i.test(addr)) return false;
  // Reserved / broadcast
  if (/^(24[0-9]|25[0-5])\./.test(addr)) return false;
  // IPv6 tunneling addresses that can reach private space
  if (/^2002:/i.test(addr)) return false;
  if (/^2001:0*:/i.test(addr)) return false;
  if (/^64:ff9b::/i.test(addr)) return false;
  // ULA (fc00::/7) — private IPv6
  if (/^f[cd][0-9a-f]{2}:/i.test(addr)) return false;

  return true;
}

// For admin-configured server URLs (Plex/Radarr/Sonarr/Jellyfin). Permits RFC1918, ULA,
// CGNAT, and loopback (admins legitimately point at LAN or same-host servers) while still
// blocking link-local and unspecified — the goal is to keep cloud metadata services and
// 0.0.0.0 unreachable even when the admin has typo'd the URL.
export function isSafeAddrForAdmin(addr: string): boolean {
  const v4 = unwrapV4Mapped(addr);
  if (v4 !== null) return isSafeAddrForAdmin(v4);

  if (/^169\.254\./.test(addr)) return false;
  if (/^fe80:/i.test(addr)) return false;
  // Deprecated IPv6 site-local (fec0::/10) is treated as link-local by some
  // stacks and could route off-LAN unexpectedly — keep it blocked even in
  // admin mode (admins use RFC1918 or ULA for LAN servers, not fec0::/10).
  if (/^fe[c-f][0-9a-f]:/i.test(addr)) return false;
  if (/^0\./.test(addr)) return false;
  if (isUnspecifiedV6(addr)) return false;
  return true;
}

const DNS_CACHE_TTL_MS = 5 * 60 * 1000;
const DNS_CACHE_MAX = 512;
const dnsCache = new Map<string, { addrs: string[]; expiresAt: number }>();

async function lookupHostCached(host: string): Promise<string[]> {
  const now = Date.now();
  const cached = dnsCache.get(host);
  if (cached && cached.expiresAt > now) return cached.addrs;

  // Use getaddrinfo (dns.lookup) rather than c-ares (dns.resolve4/6) so resolution
  // matches what fetch() itself does — respects /etc/hosts, mDNS (.local/.lan),
  // nsswitch, and split-horizon resolvers. dns.resolve* talks only to the DNS
  // servers in /etc/resolv.conf and misses all of the above.
  const results = await dns
    .lookup(host, { all: true, verbatim: true })
    .catch(() => [] as { address: string }[]);
  const addrs = results.map((r) => r.address);
  // Evict by insertion order (Map iteration is ordered) when the cache is full
  if (dnsCache.size >= DNS_CACHE_MAX) {
    const oldestKey = dnsCache.keys().next().value;
    if (oldestKey) dnsCache.delete(oldestKey);
  }
  dnsCache.set(host, { addrs, expiresAt: now + DNS_CACHE_TTL_MS });
  return addrs;
}

export interface ResolveSafeUrlOptions {
  /** Permit RFC1918/ULA/loopback addresses — for admin-configured LAN servers. */
  allowPrivate?: boolean;
}

export async function resolveToSafeUrlWithAddrs(
  raw: string,
  opts: ResolveSafeUrlOptions = {},
): Promise<{ url: string; addrs: string[] } | null> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  const rawHost = url.hostname;
  const host = rawHost.startsWith("[") && rawHost.endsWith("]") ? rawHost.slice(1, -1) : rawHost;

  const addrs: string[] = isIP(host) ? [host] : await lookupHostCached(host);

  if (addrs.length === 0) return null;
  // All resolved addresses must be safe — a single unsafe IP in the result set is enough to block the request
  const check = opts.allowPrivate ? isSafeAddrForAdmin : isSafeAddr;
  if (!addrs.every(check)) return null;

  return { url: url.toString().replace(/\/$/, ""), addrs };
}

export async function resolveToSafeUrl(
  raw: string,
  opts: ResolveSafeUrlOptions = {},
): Promise<string | null> {
  const r = await resolveToSafeUrlWithAddrs(raw, opts);
  return r ? r.url : null;
}

// Re-resolve `host` and verify (a) every currently-resolving address is still
// safe under the chosen policy, and (b) the resolved address set has not
// changed since `expectedAddrs` was captured. Returns true on success.
//
// This is the TOCTOU mitigation for the gap between the initial SSRF resolve
// and the actual fetch() connect: `fetch()` hands the hostname to undici and
// undici re-resolves at connect time, so a hostile DNS server can flip the
// answer mid-request ("DNS rebinding"). We can't pin the IP at the dispatcher
// layer without re-introducing the npm-undici-vs-Node-bundled-undici Dispatcher
// incompatibility (see safe-fetch.ts), so we instead shrink the window to
// milliseconds and refuse the request if the address set changed.
//
// The cache TTL on lookupHostCached is 5 minutes, so within that window this
// hits the same cached answer; in the worst case (cache miss right before
// fetch) we still see whatever undici will see milliseconds later.
export async function verifyResolvedHost(
  host: string,
  expectedAddrs: readonly string[],
  opts: ResolveSafeUrlOptions = {},
): Promise<boolean> {
  // Bracketed IPv6 literal — caller is responsible for unwrapping, but accept
  // both forms defensively so callers don't have to special-case it.
  const h = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;

  const addrs = isIP(h) ? [h] : await lookupHostCached(h);
  if (addrs.length === 0) return false;

  const check = opts.allowPrivate ? isSafeAddrForAdmin : isSafeAddr;
  if (!addrs.every(check)) return false;

  // Address-set equality (order-independent). A rebind from {1.2.3.4} to
  // {1.2.3.4, 5.6.7.8} or vice-versa is just as suspicious as a full swap.
  if (addrs.length !== expectedAddrs.length) return false;
  const expectedSet = new Set(expectedAddrs);
  for (const a of addrs) if (!expectedSet.has(a)) return false;

  return true;
}
