// Host-header gate for "local-only" mode (TRUST_PROXY !== "true"). Without
// a trusted proxy in front of us we cannot read the original client IP, so
// we use the Host the client connected to as a proxy for "is this a LAN
// deployment?". Legitimate local clients hit the app on localhost, a
// docker-mapped 127.0.0.1, or an RFC1918 LAN address; a public-DNS Host
// means the app is internet-exposed and TRUST_PROXY=true is required.
//
// Host is spoofable, so this is not a security boundary against a determined
// attacker — it is a footgun-prevention guard that keeps a misconfigured
// "TRUST_PROXY=false" instance from happily serving the public internet.
// Because it is not a boundary, PRODUCTION local-only mode must be an explicit
// operator decision: evaluateLocalOnlyStartup() below refuses to boot unless
// there is a trusted proxy or SUMMONARR_ALLOW_LOCAL_ONLY=true.
//
// PURE — zero imports, so proxy.ts (request path) and instrumentation.ts (boot)
// share one definition of "is this local" and it stays unit-testable.

function isLoopbackOrPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4) return false;
  if (parts.some((p) => p.length === 0 || !/^\d+$/.test(p))) return false;
  const [a, b] = parts.map((p) => Number(p));
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

function isLoopbackOrPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fe80:")) return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  return false;
}

export function isLocalHost(host: string | null | undefined): boolean {
  if (!host) return false;
  let h = host.trim();
  if (h.length === 0) return false;

  if (h.startsWith("[")) {
    const close = h.indexOf("]");
    if (close === -1) return false;
    return isLoopbackOrPrivateIPv6(h.slice(1, close));
  }

  const colon = h.lastIndexOf(":");
  if (colon !== -1 && /^\d+$/.test(h.slice(colon + 1))) {
    h = h.slice(0, colon);
  }

  const lower = h.toLowerCase();
  if (lower === "localhost") return true;
  if (/^\d+(\.\d+){3}$/.test(lower)) return isLoopbackOrPrivateIPv4(lower);
  if (lower.includes(":")) return isLoopbackOrPrivateIPv6(lower);
  return false;
}

// ── startup policy ──────────────────────────────────────────────────────────

// Suffixes that mean "this name only resolves inside a private network".
const PRIVATE_SUFFIXES = [".local", ".lan", ".internal", ".home", ".home.arpa", ".localhost"];

/**
 * Does AUTH_URL name a host reachable from the public internet?
 *
 * Treat as LAN unless it is a dotted FQDN with a routable-looking TLD:
 * loopback/RFC1918 IPs, "localhost", bare single-label hostnames, and private
 * mDNS/internal suffixes are all local. Err toward "local" so a misjudged host
 * never bricks a legitimate LAN deployment — false negatives just fall through
 * to the opt-in requirement below; only a CLEARLY public AUTH_URL is refused
 * outright. A bracketed IPv6 literal (URL.hostname keeps the brackets) is also
 * treated as a host: isLocalHost() handles loopback/link-local/ULA, so only a
 * PUBLIC IPv6 literal slips past the dotted-FQDN test and is flagged here.
 *
 * @param authHost AUTH_URL's hostname, lowercased. "" when unset/unparseable.
 */
export function isPublicAuthHost(authHost: string | null | undefined): boolean {
  const host = authHost?.trim().toLowerCase() ?? "";
  return (
    !!host &&
    host !== "localhost" &&
    (host.includes(".") || host.startsWith("[")) &&
    !isLocalHost(host) &&
    !PRIVATE_SUFFIXES.some((s) => host.endsWith(s))
  );
}

export type LocalOnlyStartupInput = {
  /** process.env.NODE_ENV */
  nodeEnv: string | undefined;
  /** process.env.TRUST_PROXY */
  trustProxy: string | undefined;
  /** process.env.SUMMONARR_ALLOW_LOCAL_ONLY */
  allowLocalOnly: string | undefined;
  /** AUTH_URL's hostname, lowercased; "" when AUTH_URL is unset or unparseable. */
  authHost: string | null | undefined;
};

export type LocalOnlyStartupDecision = {
  mode: "trusted-proxy" | "local-only";
  /** true ⇒ the caller must refuse to start. */
  fatal: boolean;
  /** Operator-facing text; null only for the clean trusted-proxy case. */
  message: string | null;
  /** Which rule decided — the stable handle tests and logs key off. */
  reason:
    | "trusted-proxy"
    | "public-auth-url"
    | "missing-opt-in"
    | "explicit-opt-in"
    | "development";
};

/**
 * Decide what startup should do about proxy/local-only configuration.
 *
 * PRODUCTION LOCAL-ONLY MODE FAILS CLOSED. When TRUST_PROXY is not "true" the
 * ONLY thing keeping the instance off the internet is the Host header the
 * client chose to send (see the note at the top of this file) — that is a
 * footgun guard, never an internet-facing access control. So production
 * demands one of two deliberate configurations:
 *
 *   TRUST_PROXY=true                  a real reverse proxy in front (correct
 *                                     for anything internet-reachable), or
 *   SUMMONARR_ALLOW_LOCAL_ONLY=true   the operator asserts this host is
 *                                     genuinely private (LAN / loopback /
 *                                     firewalled) and is relying on their own
 *                                     network controls.
 *
 * A PUBLIC AUTH_URL is refused either way — the opt-in cannot unlock it. That
 * combination is not merely unsafe but self-contradictory: the Host gate 403s
 * every request to the public hostname, so the deployment is broken as well as
 * unprotected. Keeping it non-overridable means the opt-in can never mask an
 * internet-facing misconfiguration.
 *
 * Development is never fatal — local `next dev` must keep working untouched.
 */
export function evaluateLocalOnlyStartup(env: LocalOnlyStartupInput): LocalOnlyStartupDecision {
  if (env.trustProxy === "true") {
    return { mode: "trusted-proxy", fatal: false, message: null, reason: "trusted-proxy" };
  }

  const isProduction = env.nodeEnv === "production";
  const optedIn = env.allowLocalOnly === "true";

  if (isProduction && isPublicAuthHost(env.authHost)) {
    return {
      mode: "local-only",
      fatal: true,
      reason: "public-auth-url",
      message:
        "[startup] AUTH_URL is a public host but TRUST_PROXY is not 'true'. An internet-facing " +
        "deployment MUST run behind a trusted reverse proxy with TRUST_PROXY=true — the local-only " +
        "Host-header guard is spoofable and cannot protect a public instance. Set TRUST_PROXY=true " +
        "(and have the proxy strip client-supplied X-Forwarded-* headers). " +
        "SUMMONARR_ALLOW_LOCAL_ONLY does NOT apply here: with a public AUTH_URL the local-only Host " +
        "gate would reject every request to that hostname anyway. Refusing to start.",
    };
  }

  if (isProduction && !optedIn) {
    return {
      mode: "local-only",
      fatal: true,
      reason: "missing-opt-in",
      message:
        "[startup] LOCAL-ONLY mode requires an explicit opt-in in production. TRUST_PROXY is not " +
        "'true', so the only thing separating this instance from the public internet is the Host " +
        "header the CLIENT sends — and Host is trivially spoofed, so it is NOT an access control. " +
        "Anyone who can route a packet to this port can set Host: 127.0.0.1 and be served. Choose one:\n" +
        "  • Internet-facing (the usual case): put the app behind a trusted reverse proxy that " +
        "terminates TLS and sets X-Forwarded-For, then set TRUST_PROXY=true.\n" +
        "  • Genuinely private host (LAN-only, bound to loopback, or firewalled off): set " +
        "SUMMONARR_ALLOW_LOCAL_ONLY=true to acknowledge that access control is provided by your " +
        "network, not by Summonarr.\n" +
        "Refusing to start.",
    };
  }

  if (isProduction) {
    return {
      mode: "local-only",
      fatal: false,
      reason: "explicit-opt-in",
      message:
        "[startup] SUMMONARR_ALLOW_LOCAL_ONLY=true — running in LOCAL-ONLY mode without a trusted " +
        "proxy. The Host-header guard is spoofable and is NOT a security boundary: this instance is " +
        "protected only by your network controls (LAN, firewall, loopback binding). Per-IP rate " +
        "limiting is also disabled (single shared bucket). Do not expose this port to the internet.",
    };
  }

  return {
    mode: "local-only",
    fatal: false,
    reason: "development",
    message:
      "[startup] TRUST_PROXY is not 'true' — LOCAL-ONLY mode (LAN/loopback). Per-IP rate limiting is " +
      "disabled (single shared bucket) and the local-only guard trusts the (spoofable) Host header, " +
      "which is NOT a security boundary. Set TRUST_PROXY=true behind a trusted reverse proxy for any " +
      "internet-facing deployment; keep local-only instances off the public internet.",
  };
}
