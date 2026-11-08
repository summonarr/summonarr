// The one IPv6 text parser behind the SSRF policy (ssrf.ts), the machine-session
// IP allowlist (ip-allowlist.ts) and the rate-limit /64 bucket key
// (rate-limit.ts). Three parsers for three security decisions could drift apart
// on a zone id, an embedded IPv4 or `::` compression; one can't. Zero imports.

/**
 * The eight 16-bit groups of an IPv6 literal, or null if it isn't one. Accepts
 * `::` compression (standing for at least one zero group, as RFC 4291 and Node's
 * isIP have it), a trailing embedded IPv4 dotted-quad (`::ffff:1.2.3.4`), any
 * hex case, and drops a zone id (`fe80::1%eth0`).
 */
export function ipv6Groups(addr: string): number[] | null {
  let s = addr;
  const pct = s.indexOf("%"); // zone id — irrelevant to the value
  if (pct !== -1) s = s.slice(0, pct);
  if (!/^[0-9a-f:.]+$/i.test(s)) return null;

  // A trailing embedded IPv4 (…:a.b.c.d) becomes two hex groups first, so the
  // remainder parses as pure hextets.
  const v4m = /:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (v4m) {
    const o = [v4m[1], v4m[2], v4m[3], v4m[4]].map(Number);
    if (o.some((n) => n > 255)) return null;
    const hex = `${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
    s = s.slice(0, v4m.index + 1) + hex; // +1 keeps the colon before the v4
  }

  const dbl = s.indexOf("::");
  let groups: string[];
  if (dbl !== -1) {
    if (s.indexOf("::", dbl + 1) !== -1) return null; // at most one `::`
    const head = s.slice(0, dbl).split(":").filter(Boolean);
    const tail = s.slice(dbl + 2).split(":").filter(Boolean);
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    groups = [...head, ...Array<string>(missing).fill("0"), ...tail];
  } else {
    groups = s.split(":");
  }
  if (groups.length !== 8) return null;

  const out: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    out.push(parseInt(g, 16));
  }
  return out;
}

/** The 128-bit value of an IPv6 literal (ipv6Groups' rules), or null. */
export function ipv6ToBigInt(addr: string): bigint | null {
  const groups = ipv6Groups(addr);
  if (!groups) return null;
  let value = 0n;
  for (const g of groups) value = (value << 16n) | BigInt(g);
  return value;
}
