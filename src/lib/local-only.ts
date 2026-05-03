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
