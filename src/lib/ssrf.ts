

import dns from "dns/promises";
import { isIP } from "net";
import { ipv6ToBigInt } from "./ipv6-parse";

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

// Recognise an IPv4 address embedded in IPv6 via well-known prefixes that the
// textual `unwrapV4Mapped`/regexes miss: NAT64 (64:ff9b::/96) in non-compressed
// form, the deprecated IPv4-compatible (::/96), and SIIT (::ffff:0:0/96). Returns
// the embedded IPv4 dotted string so callers can apply IPv4 rules; null otherwise.
// Exported so sibling classifiers (ip-lookup's bogon short-circuit) reuse THIS
// unwrap instead of hand-copying a subset of it that then drifts.
export function unwrapEmbeddedV4(addr: string): string | null {
  if (!addr.includes(":")) return null;
  const v = ipv6ToBigInt(addr);
  if (v === null) return null;

  const low32 = v & 0xffffffffn;
  const prefix96 = v >> 32n; // top 96 bits
  const toDotted = (n: bigint) =>
    `${(n >> 24n) & 0xffn}.${(n >> 16n) & 0xffn}.${(n >> 8n) & 0xffn}.${n & 0xffn}`;

  if (prefix96 === 0xffffn) return toDotted(low32);                     // ::ffff:0:0/96  (IPv4-mapped)
  if (prefix96 === 0xffff0000n) return toDotted(low32);                 // ::ffff:0:0:0/96 (SIIT translatable)
  if (prefix96 === 0x0064ff9b0000000000000000n) return toDotted(low32); // 64:ff9b::/96   (NAT64)
  if (prefix96 === 0n && low32 > 1n) return toDotted(low32);            // ::/96          (IPv4-compatible; skips ::, ::1)
  return null;
}

// True only for THIS host's loopback, in every spelling Node/dns.lookup actually
// hands over. IPv4 127/8, ::1 (any hextet padding), and IPv4-mapped IPv6 of a
// 127/8 address (`::ffff:127.0.0.1`, `::ffff:7f00:1`, `0:0:0:0:0:ffff:7f00:1`).
// NAT64/SIIT/IPv4-compatible embeddings of 127.x are NOT this host — a
// plaintext-AUTH carve-out that used unwrapEmbeddedV4 wholesale would send
// AUTH PLAIN to a translator. email.ts keys that carve-out off this.
export function isLoopbackAddress(addr: string): boolean {
  if (/^127\./.test(addr)) return true;
  if (/^::1$/.test(addr)) return true;
  if (!addr.includes(":")) return false;
  const v = ipv6ToBigInt(addr);
  if (v === null) return false;
  if (v === 1n) return true;
  const prefix96 = v >> 32n;
  if (prefix96 !== 0xffffn) return false;
  return ((v & 0xffffffffn) >> 24n) === 127n;
}

// Detect the IPv6 unspecified address (`::`) in any of its valid notations:
// `::`, the fully-expanded `0:0:0:0:0:0:0:0`, the zero-padded
// `0000:…:0000`, and mixed notation with embedded IPv4 (`::0.0.0.0`,
// `::ffff:0.0.0.0`). All must be blocked — letting any through means a
// user-controlled URL can hit `0.0.0.0` (= "all local interfaces") via IPv6.
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

// Deprecated IPv6 transition tunnels whose payload is an IPv4 address.
// 6to4 (2002::/16) embeds IPv4 in bits 16–47; Teredo (2001:0::/32) uses a
// more involved encoding. Neither is a prefix96-of-the-last-32-bits form,
// so unwrapEmbeddedV4 does not catch them. `2002:a9fe:a9fe::` is 6to4 of
// 169.254.169.254 and would otherwise pass the dotted 169.254 check.
//
// Shared by BOTH policies on purpose. The previous split (user blocked,
// admin allowed) was how cloud metadata stayed reachable via a tunnel on
// the admin-configured URL path. An admin server is never a 6to4/Teredo
// literal — keep the two checks as one helper so they cannot drift again.
function isDeprecatedIpv6Tunnel(addr: string): boolean {
  const v = ipv6ToBigInt(addr);
  if (v !== null) {
    if (v >> 112n === 0x2002n) return true; // 6to4 2002::/16
    if (v >> 96n === 0x20010000n) return true; // Teredo 2001:0::/32
    return false;
  }
  // Unparseable spelling — fail closed on the textual prefixes.
  return /^2002:/i.test(addr) || /^2001:0*:/i.test(addr);
}

// AWS IMDSv2 IPv6 — `fd00:ec2::254`. Admin mode permits ULA (fc00::/7) so
// LAN Authelia/Jellyfin on unique-local addressing still work, but this one
// address is the IPv6 twin of 169.254.169.254: AWS documents it as the
// on-link metadata endpoint on IPv6-only EC2. A typo'd or DNS-rebound
// admin URL must not reach instance credentials. User policy already
// blocks all ULA; this exists so the admin carve-out cannot.
function isAwsIpv6Imds(addr: string): boolean {
  const v = ipv6ToBigInt(addr);
  return v === 0xfd000ec2000000000000000000000254n;
}

// An address rule: true means BLOCKED. Every rule sees the address with any
// embedded IPv4 already unwrapped (passesPolicy), so a rule is written once for
// the plain spelling.
type AddrRule = (addr: string) => boolean;

// Blocked under EVERY policy, the admin one included: cloud metadata,
// "all interfaces", and space no server legitimately lives in.
const ALWAYS_BLOCKED: readonly AddrRule[] = [
  // Link-local (APIPA) — the cloud metadata endpoint lives here.
  (a) => /^169\.254\./.test(a),
  (a) => /^fe[89ab][0-9a-f]:/i.test(a), // fe80::/10, not just fe80:
  // Deprecated IPv6 site-local (fec0::/10) is treated as link-local by some
  // stacks and could route off-LAN unexpectedly — blocked even for admins
  // (they use RFC1918 or ULA for LAN servers, not fec0::/10).
  (a) => /^fe[c-f][0-9a-f]:/i.test(a),
  // Unspecified / any-address.
  (a) => /^0\./.test(a),
  isUnspecifiedV6,
  // Multicast and reserved/broadcast: a typo'd 239.x/255.255.255.255 URL would
  // otherwise emit an HTTP request that reaches every device on the segment.
  (a) => /^(22[4-9]|23[0-9])\./.test(a),
  (a) => /^ff/i.test(a),
  (a) => /^(24[0-9]|25[0-5])\./.test(a),
  // IPv6 tunnels whose payload is an IPv4 address (6to4, Teredo).
  isDeprecatedIpv6Tunnel,
];

// Private space: blocked for user-supplied and trusted-host URLs, allowed for
// admin-configured servers (Plex/Radarr/Sonarr/Jellyfin on the LAN or the same
// host).
const PRIVATE_BLOCKED: readonly AddrRule[] = [
  // Loopback, in every spelling (0:0:0:0:0:0:0:1, 0000:…:0001 included —
  // unwrapEmbeddedV4 deliberately skips ::1).
  (a) => /^127\./.test(a),
  (a) => /^::1$/.test(a),
  (a) => a.includes(":") && ipv6ToBigInt(a) === 1n,
  // RFC1918 private IPv4 (10/8, 172.16/12, 192.168/16). These back the LAN a
  // self-hosted deployment runs on (router, other containers, NAS, the very
  // Radarr/Sonarr/Jellyfin/Plex boxes), so leaving them reachable is a
  // blind-SSRF hole on the user-supplied-URL path (Web Push endpoints).
  (a) => /^10\./.test(a),
  (a) => /^172\.(1[6-9]|2\d|3[01])\./.test(a),
  (a) => /^192\.168\./.test(a),
  // CGNAT shared address space (100.64/10) — also Docker internal ranges on some hosts.
  (a) => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a),
  // NAT64 well-known prefix that can reach private space.
  (a) => /^64:ff9b::/i.test(a),
  // ULA (fc00::/7) — private IPv6 (the AWS IPv6 metadata address included).
  (a) => /^f[cd][0-9a-f]{2}:/i.test(a),
  // Special-purpose space a deployment can route internally: IETF protocol
  // assignments (192.0.0.0/24), benchmarking (198.18.0.0/15, often reused as
  // private LAN space), and RFC 8215 local-use NAT64 (64:ff9b:1::/48), which
  // translates to IPv4 behind a local NAT64 — private IPv4 included — at an
  // operator-chosen prefix length, so its payload can't be unwrapped reliably.
  (a) => /^192\.0\.0\./.test(a),
  (a) => /^198\.1[89]\./.test(a),
  isLocalUseNat64,
];

// The full policy, for user-supplied and trusted-host URLs.
const USER_POLICY: readonly AddrRule[] = [...ALWAYS_BLOCKED, ...PRIVATE_BLOCKED];
// For admin-configured server URLs: private space is fine, but the AWS IPv6
// metadata address — which the ULA carve-out would let through — is not.
const ADMIN_POLICY: readonly AddrRule[] = [...ALWAYS_BLOCKED, isAwsIpv6Imds];

function passesPolicy(addr: string, rules: readonly AddrRule[]): boolean {
  // Embedded-IPv4 IPv6 — unwrap so IPv4 rules apply to ::ffff:1.2.3.4,
  // ::ffff:0102:0304, NAT64 (incl. non-compressed), IPv4-compatible and SIIT forms.
  const v4 = unwrapV4Mapped(addr) ?? unwrapEmbeddedV4(addr);
  if (v4 !== null) return passesPolicy(v4, rules);
  return !rules.some((blocked) => blocked(addr));
}

function isSafeAddr(addr: string): boolean {
  return passesPolicy(addr, USER_POLICY);
}

function isLocalUseNat64(addr: string): boolean {
  if (!addr.includes(":")) return false;
  const v = ipv6ToBigInt(addr);
  if (v !== null) return v >> 80n === 0x64ff9b0001n;
  return /^64:ff9b:1:/i.test(addr); // unparseable spelling — fail closed on the prefix
}

// For admin-configured server URLs (Plex/Radarr/Sonarr/Jellyfin). Permits RFC1918, ULA,
// CGNAT, and loopback (admins legitimately point at LAN or same-host servers) while still
// blocking link-local and unspecified — the goal is to keep cloud metadata services and
// 0.0.0.0 unreachable even when the admin has typo'd the URL.
export function isSafeAddrForAdmin(addr: string): boolean {
  return passesPolicy(addr, ADMIN_POLICY);
}

const DNS_CACHE_TTL_MS = 5 * 60 * 1000;
const DNS_CACHE_MAX = 512;
const dnsCache = new Map<string, { addrs: string[]; expiresAt: number }>();

async function lookupHostCached(host: string, bypassCache = false): Promise<string[]> {
  const now = Date.now();
  if (!bypassCache) {
    const cached = dnsCache.get(host);
    if (cached && cached.expiresAt > now) return cached.addrs;
  }

  // Use getaddrinfo (dns.lookup) rather than c-ares (dns.resolve4/6) so resolution
  // matches what fetch() itself does — respects /etc/hosts, mDNS (.local/.lan),
  // nsswitch, and split-horizon resolvers. dns.resolve* talks only to the DNS
  // servers in /etc/resolv.conf and misses all of the above.
  const results = await dns
    .lookup(host, { all: true, verbatim: true })
    .catch(() => [] as { address: string }[]);
  const addrs = results.map((r) => r.address);
  // NEVER cache a failed lookup. An empty result means "resolution failed", not
  // "this host has no safe addresses" — but every caller treats an empty set as a
  // hard block (resolveToSafeUrlWithAddrs returns null → SafeFetchError
  // "ssrf-blocked"). Caching it pinned a single transient DNS blip into a FULL
  // DNS_CACHE_TTL_MS outage for that host: TMDB browse/search, the *arr syncs and
  // web push would all keep failing for five minutes after DNS had recovered,
  // behind an error message that blames the SSRF policy and sends the operator
  // hunting the wrong thing. Re-querying on the next call costs one getaddrinfo,
  // which is what an uncached host already pays, and the OS resolver caches
  // NXDOMAIN itself so a genuinely-dead host is still cheap.
  if (addrs.length === 0) return addrs;
  // Evict by insertion order (Map iteration is ordered) when the cache is full.
  // Map.set on an EXISTING key keeps its original position, so a refresh must
  // delete-then-set or the hottest, constantly-refreshed host sits at the head
  // and is the first evicted while one-shot hosts are retained.
  dnsCache.delete(host);
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

// The string a safe URL is fetched as. Collapses ONLY the empty-path marker
// ("https://h/" → "https://h"). Anchoring the strip to the end of the whole
// serialized URL also ate a meaningful trailing segment separator:
// "https://idp/application/o/token/" became ".../token", a DIFFERENT resource.
// safe-fetch's admin and user modes fetch this exact string, so every OIDC
// token/userinfo/JWKS call to an IdP whose endpoints canonically end in "/"
// (Authentik) hit the wrong path — and since the request is issued with
// redirect:"error", the upstream's 301 back to the canonical form surfaced as a
// SafeFetchError instead of following.
export function canonicalSafeUrl(url: URL): string {
  const serialized = url.toString();
  const isBareOrigin = url.pathname === "/" && !url.search && !url.hash;
  return isBareOrigin ? serialized.replace(/\/$/, "") : serialized;
}

function policyCheck(opts: ResolveSafeUrlOptions): (addr: string) => boolean {
  return opts.allowPrivate ? isSafeAddrForAdmin : isSafeAddr;
}

function unbracket(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
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

  const host = unbracket(url.hostname);
  const addrs: string[] = isIP(host) ? [host] : await lookupHostCached(host);

  if (addrs.length === 0) return null;
  // All resolved addresses must be safe — a single unsafe IP in the result set is enough to block the request
  if (!addrs.every(policyCheck(opts))) return null;
  return { url: canonicalSafeUrl(url), addrs };
}

export async function resolveToSafeUrl(
  raw: string,
  opts: ResolveSafeUrlOptions = {},
): Promise<string | null> {
  const r = await resolveToSafeUrlWithAddrs(raw, opts);
  return r ? r.url : null;
}

// Re-resolve `host` FRESH and verify every currently-resolving address is safe
// under the chosen policy. Returns true on success.
//
// This is the TOCTOU mitigation for the one path that still hands the hostname
// to fetch() (the env-proxy path in safe-fetch.ts, where the proxy resolves the
// name and the connection cannot be pinned): resolve immediately before
// fetch() and refuse if any address points somewhere unsafe. The normal path
// does not rely on this — it connects to the addresses `resolveSafeAddrsFresh`
// returns, so there is no later lookup to rebind. Same lookup and policy as
// resolveSafeAddrsFresh, answered as a boolean.
//
// This re-resolves FRESH (bypassing the 5-minute cache) so it genuinely queries
// DNS again immediately before fetch(), rather than echoing the answer the
// resolve step just primed into the cache — a cached read here could never
// observe a rebind, defeating the whole check. The residual gap is only between
// this getaddrinfo and undici's own at connect, typically sub-millisecond.
//
// NOTE: we intentionally do NOT compare the re-resolved set against the initial
// one. CDN-fronted hosts (api.themoviedb.org, *.push.apple.com, fcm.googleapis.com,
// …) return rotating/partial answer sets with low TTLs, so two lookups seconds-to-
// minutes apart routinely disagree on a healthy host — a set-equality check
// false-positives and hard-blocks TMDB search and all web push. Per-address safety
// is the property that actually stops rebind-to-internal; a public→public rebind is
// not an SSRF escalation under allowPrivate=false (no internal target is reachable).
// See the longer rationale in safe-fetch.ts doFetch().
export async function verifyResolvedHost(
  host: string,
  opts: ResolveSafeUrlOptions = {},
): Promise<boolean> {
  return (await resolveSafeAddrsFresh(host, opts)) !== null;
}

// Resolve `host` FRESH (bypassing the cache) and return the addresses ONLY if
// every one is safe under the policy, else null. safe-fetch connects to exactly
// these addresses (a pinned `lookup`), so what was validated is what is dialled.
// A bracketed IPv6 literal is accepted in either form.
export async function resolveSafeAddrsFresh(
  host: string,
  opts: ResolveSafeUrlOptions = {},
): Promise<string[] | null> {
  const h = unbracket(host);
  const addrs = isIP(h) ? [h] : await lookupHostCached(h, /* bypassCache */ true);
  if (addrs.length === 0) return null;
  return addrs.every(policyCheck(opts)) ? addrs : null;
}
