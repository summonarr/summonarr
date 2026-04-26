

import dns from "dns/promises";
import { isIP } from "net";

function isSafeAddr(addr: string): boolean {
  // Loopback
  if (/^127\./.test(addr)) return false;
  if (/^::1$/.test(addr)) return false;
  if (/^::ffff:127\./i.test(addr)) return false;
  // Unspecified / any-address
  if (/^0\./.test(addr)) return false;
  if (addr === "::") return false;
  if (/^::ffff:0\./i.test(addr)) return false;
  // Link-local (APIPA)
  if (/^fe80:/i.test(addr)) return false;
  if (/^169\.254\./.test(addr)) return false;
  if (/^::ffff:169\.254\./i.test(addr)) return false;
  // CGNAT shared address space (100.64/10) — also used for Docker internal ranges on some hosts
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(addr)) return false;
  if (/^::ffff:100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./i.test(addr)) return false;
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
  if (/^::ffff:f[cd][0-9a-f]{2}:/i.test(addr)) return false;

  return true;
}

// For admin-configured server URLs (Plex/Radarr/Sonarr/Jellyfin). Permits RFC1918, ULA,
// CGNAT, and loopback (admins legitimately point at LAN or same-host servers) while still
// blocking link-local and unspecified — the goal is to keep cloud metadata services and
// 0.0.0.0 unreachable even when the admin has typo'd the URL.
function isSafeAddrForAdmin(addr: string): boolean {
  if (/^169\.254\./.test(addr)) return false;
  if (/^::ffff:169\.254\./i.test(addr)) return false;
  if (/^fe80:/i.test(addr)) return false;
  if (/^0\./.test(addr)) return false;
  if (addr === "::") return false;
  if (/^::ffff:0\./i.test(addr)) return false;
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
