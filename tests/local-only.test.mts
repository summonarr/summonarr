// Unit tests for the local-only Host gate (src/lib/local-only.ts). When
// TRUST_PROXY !== "true" this is the guard that keeps a misconfigured instance
// from serving the public internet — a public Host must read as NOT local, and
// every loopback/RFC1918/link-local/CGNAT form must read as local.
//
// The second half of this file covers evaluateLocalOnlyStartup — the boot
// policy that makes production local-only mode FAIL CLOSED. The Host gate above
// is footgun-prevention, not an access control (Host is client-supplied), so
// production must be told explicitly which of the two safe shapes it is in:
// a trusted proxy, or an operator asserting the host is genuinely private.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isLocalHost,
  isPublicAuthHost,
  evaluateLocalOnlyStartup,
  type LocalOnlyStartupInput,
} from "../src/lib/local-only.ts";

test("localhost and loopback are local (with or without a port)", () => {
  assert.equal(isLocalHost("localhost"), true);
  assert.equal(isLocalHost("LOCALHOST:3000"), true);
  assert.equal(isLocalHost("127.0.0.1"), true);
  assert.equal(isLocalHost("127.0.0.1:3001"), true);
  assert.equal(isLocalHost("127.8.9.10"), true); // whole 127/8 block
});

test("RFC1918 / link-local / CGNAT IPv4 ranges are local", () => {
  assert.equal(isLocalHost("10.0.0.5"), true);
  assert.equal(isLocalHost("192.168.1.20:8080"), true);
  assert.equal(isLocalHost("172.16.0.1"), true);
  assert.equal(isLocalHost("172.31.255.255"), true);
  assert.equal(isLocalHost("169.254.1.1"), true);
  assert.equal(isLocalHost("100.64.0.1"), true); // CGNAT low edge
  assert.equal(isLocalHost("100.127.255.255"), true); // CGNAT high edge
});

test("public IPv4 and range edges are NOT local", () => {
  assert.equal(isLocalHost("8.8.8.8"), false);
  assert.equal(isLocalHost("172.15.0.1"), false); // just below 172.16/12
  assert.equal(isLocalHost("172.32.0.1"), false); // just above 172.31
  assert.equal(isLocalHost("100.63.0.1"), false); // below CGNAT
  assert.equal(isLocalHost("100.128.0.1"), false); // above CGNAT
  assert.equal(isLocalHost("11.0.0.1"), false);
});

test("IPv6 loopback / link-local / ULA are local; global IPv6 is not", () => {
  assert.equal(isLocalHost("[::1]"), true);
  assert.equal(isLocalHost("[::1]:3000"), true);
  assert.equal(isLocalHost("[fe80::1]"), true);
  assert.equal(isLocalHost("[fc00::1]"), true);
  assert.equal(isLocalHost("[fd12:3456::1]"), true);
  assert.equal(isLocalHost("[2001:db8::1]"), false);
});

test("publicly-resolvable DNS hostnames are NOT local", () => {
  assert.equal(isLocalHost("summonarr.example.com"), false);
  assert.equal(isLocalHost("summonarr.example.com:3001"), false);
  assert.equal(isLocalHost("plex.tv"), false);
});

test("PIN: the Host gate accepts exactly the hosts the boot check calls private", () => {
  // These two must agree. isPublicAuthHost treats the private suffixes and bare
  // single-label hosts as private, so a deployment with AUTH_URL=http://nas.lan:3001
  // boots cleanly — but isLocalHost used to reject them, so the Host gate then 403'd
  // every request. Startup said "fine", runtime said "no", and the documented LAN
  // example was the broken case.
  //
  // Not a security relaxation: the Host header is client-supplied and spoofable, so
  // this gate is footgun-prevention for a misconfigured PUBLIC deployment, never a
  // boundary — and a public AUTH_URL is still refused at boot outright.
  for (const host of ["nas.lan", "summonarr.local", "app.internal", "media.home", "x.home.arpa", "box.localhost"]) {
    assert.equal(isLocalHost(host), true, `${host} boots as private, so the Host gate must accept it`);
    assert.equal(isPublicAuthHost(host), false, `${host} must still read as private at boot`);
  }
  // A bare single-label host (docker service name, AUTH_URL=http://summonarr:3000).
  assert.equal(isLocalHost("summonarr"), true);
  assert.equal(isLocalHost("summonarr:3000"), true);
  assert.equal(isPublicAuthHost("summonarr"), false);
});

test("degenerate input fails closed (not local)", () => {
  assert.equal(isLocalHost(null), false);
  assert.equal(isLocalHost(undefined), false);
  assert.equal(isLocalHost(""), false);
  assert.equal(isLocalHost("   "), false);
  assert.equal(isLocalHost("["), false); // unterminated bracket
  assert.equal(isLocalHost("999.1.1.1"), false); // not a valid IPv4, not localhost
});

test("public hostname with an embedded private-IP prefix is NOT local", () => {
  // The IPv4-shape regex is anchored (^\d+(\.\d+){3}$), so a DNS name that
  // merely STARTS with a private-IP literal must not read as an IP at all —
  // it falls through to the hostname branch and fails closed. A regression to
  // an unanchored/looser regex would make these public Hosts read as local.
  assert.equal(isLocalHost("10.0.0.5.attacker.com"), false);
  assert.equal(isLocalHost("127.0.0.1.example.com"), false);
  assert.equal(isLocalHost("192.168.1.1.evil.net:3000"), false);
});

test("unbracketed IPv6 Host values (pin current behavior)", () => {
  // These pin surprising-but-harmless behavior of the port-strip heuristic
  // (everything after the LAST colon is treated as a port when numeric):
  //
  // "::1" — the strip eats the trailing "1", leaving ":", which fails every
  // check → NOT local. Fail-closed, but a future port-strip change could
  // silently flip this; the bracketed form "[::1]" is the supported spelling.
  assert.equal(isLocalHost("::1"), false);
  // "fe80::1" — the strip leaves "fe80:", which still satisfies
  // startsWith("fe80:") → local only by luck of the truncation.
  assert.equal(isLocalHost("fe80::1"), true);
});

test("leading-zero IPv4 octets parse as decimal (pin current behavior)", () => {
  // Number("010") === 10, so "010.1.2.3" reads as 10.x → local. Clients that
  // interpret leading-zero octets as octal would treat this as public
  // 8.1.2.3 — a real parser divergence. The module explicitly disclaims
  // being a security boundary (Host is spoofable), so we pin the current
  // decimal reading rather than demanding a rejection.
  assert.equal(isLocalHost("010.1.2.3"), true);
});

test("unspecified addresses: v6 :: is local, v4 0.0.0.0 is not (pin asymmetry)", () => {
  // The IPv6 branch special-cases "::" as local; the IPv4 branch has no
  // a === 0 case, so 0.0.0.0 falls through to false. Intentionally pinned
  // so a change to either side is a conscious decision.
  assert.equal(isLocalHost("[::]"), true);
  assert.equal(isLocalHost("0.0.0.0"), false);
});

// ════════════════════════════════════════════════════════════════════════════
// evaluateLocalOnlyStartup — production local-only mode fails closed
// ════════════════════════════════════════════════════════════════════════════

const PROD = "production";
const LAN_AUTH_HOST = "192.168.1.50"; // the intentional self-hosted shape
const PUBLIC_AUTH_HOST = "requests.example.com";

/** Base production env: local-only (TRUST_PROXY blank), LAN AUTH_URL, no opt-in. */
const prodLocalOnly = (over: Partial<Parameters<typeof evaluateLocalOnlyStartup>[0]> = {}) =>
  evaluateLocalOnlyStartup({
    nodeEnv: PROD,
    trustProxy: "",
    allowLocalOnly: undefined,
    authHost: LAN_AUTH_HOST,
    ...over,
  });

// ── 1. production local-only, no trusted proxy and no opt-in → REJECTED ──────

test("production local-only without a trusted proxy or the opt-in refuses to boot", () => {
  const d = prodLocalOnly();
  assert.equal(d.fatal, true, "a blank TRUST_PROXY in production must not silently run local-only");
  assert.equal(d.mode, "local-only");
  assert.equal(d.reason, "missing-opt-in");
});

test("the refusal explains the risk AND names both remedies", () => {
  const msg = prodLocalOnly().message ?? "";
  // The risk, in the operator's terms — not just "misconfigured".
  assert.match(msg, /Host header the CLIENT sends/);
  assert.match(msg, /spoofed/i);
  assert.match(msg, /NOT an access control/);
  // Both required configurations, by exact variable name.
  assert.match(msg, /TRUST_PROXY=true/);
  assert.match(msg, /SUMMONARR_ALLOW_LOCAL_ONLY=true/);
  assert.match(msg, /Refusing to start/);
});

test("every falsy/near-miss TRUST_PROXY spelling is local-only, not trusted", () => {
  // Only the exact string "true" enables proxy trust — the same test getClientIp
  // applies before reading X-Forwarded-For. A truthy-looking value must NOT
  // quietly unlock production local-only mode.
  for (const trustProxy of [undefined, "", " ", "false", "0", "TRUE", "True", "yes", "1"]) {
    const d = prodLocalOnly({ trustProxy });
    assert.equal(d.fatal, true, `TRUST_PROXY=${JSON.stringify(trustProxy)} must refuse to boot`);
    assert.equal(d.reason, "missing-opt-in");
  }
});

test("a public AUTH_URL is refused even WITH the opt-in — it cannot mask an internet-facing instance", () => {
  const d = prodLocalOnly({ authHost: PUBLIC_AUTH_HOST, allowLocalOnly: "true" });
  assert.equal(d.fatal, true);
  assert.equal(d.reason, "public-auth-url", "the public-host rule outranks the opt-in");
  assert.match(d.message ?? "", /SUMMONARR_ALLOW_LOCAL_ONLY does NOT apply here/);
});

// ── 2. explicit opt-in permits intentional local-only deployments ────────────

test("SUMMONARR_ALLOW_LOCAL_ONLY=true boots an intentional LAN deployment", () => {
  const d = prodLocalOnly({ allowLocalOnly: "true" });
  assert.equal(d.fatal, false, "the documented self-hosted LAN deployment must keep working");
  assert.equal(d.mode, "local-only");
  assert.equal(d.reason, "explicit-opt-in");
  // It still says so loudly — opting in acknowledges the risk, it doesn't hide it.
  assert.match(d.message ?? "", /NOT a security boundary/);
  assert.match(d.message ?? "", /network controls/);
});

test("the opt-in covers every genuinely-private AUTH_URL shape", () => {
  for (const authHost of [
    "localhost", "127.0.0.1", "192.168.1.50", "10.0.0.5", "172.16.0.1",
    "[::1]", "[fd12:3456::1]", "summonarr", "summonarr.local", "nas.lan", "box.home.arpa", "",
  ]) {
    const d = prodLocalOnly({ authHost, allowLocalOnly: "true" });
    assert.equal(d.fatal, false, `AUTH_URL host ${JSON.stringify(authHost)} must boot with the opt-in`);
    assert.equal(d.reason, "explicit-opt-in");
  }
});

test("only the exact string \"true\" is an opt-in", () => {
  for (const allowLocalOnly of ["", " ", "false", "0", "TRUE", "yes", "1", "true "]) {
    const d = prodLocalOnly({ allowLocalOnly });
    assert.equal(d.fatal, true, `SUMMONARR_ALLOW_LOCAL_ONLY=${JSON.stringify(allowLocalOnly)} is not an opt-in`);
  }
});

// ── 3. normal production deployments are unaffected ─────────────────────────

test("TRUST_PROXY=true boots clean — the opt-in is irrelevant behind a real proxy", () => {
  for (const allowLocalOnly of [undefined, "", "true"]) {
    for (const authHost of [PUBLIC_AUTH_HOST, LAN_AUTH_HOST, ""]) {
      const d = evaluateLocalOnlyStartup({ nodeEnv: PROD, trustProxy: "true", allowLocalOnly, authHost });
      assert.equal(d.fatal, false, "a reverse-proxy deployment must never be refused");
      assert.equal(d.mode, "trusted-proxy");
      assert.equal(d.reason, "trusted-proxy");
      assert.equal(d.message, null, "nothing to warn about — this is the recommended shape");
    }
  }
});

test("the pre-existing public-AUTH_URL refusal still fires unchanged", () => {
  const d = prodLocalOnly({ authHost: PUBLIC_AUTH_HOST });
  assert.equal(d.fatal, true);
  assert.equal(d.reason, "public-auth-url");
  assert.match(d.message ?? "", /internet-facing/);
});

// ── 4. development is never bricked ─────────────────────────────────────────

test("development never fails, whatever the configuration", () => {
  for (const nodeEnv of ["development", "test", undefined]) {
    for (const authHost of [PUBLIC_AUTH_HOST, "localhost", ""]) {
      const d = evaluateLocalOnlyStartup({ nodeEnv, trustProxy: "", allowLocalOnly: undefined, authHost });
      assert.equal(d.fatal, false, `NODE_ENV=${String(nodeEnv)} must keep running local-only`);
      assert.equal(d.reason, "development");
      assert.match(d.message ?? "", /LOCAL-ONLY mode/);
    }
  }
});

// ── 5. a spoofed Host can never be the thing that authorizes the deployment ──

test("the boot decision does not consult any request Host — no header value can unlock it", () => {
  // The policy input carries AUTH_URL's host (operator config) and nothing a
  // client can send. This is the structural half of "Host is not an access
  // control": there is no request-shaped field to spoof at boot.
  //
  // `Required<LocalOnlyStartupInput>` is what makes that structural: the literal
  // is checked against the function's OWN parameter type, so adding a field —
  // an optional request-Host one in particular — fails to compile here instead
  // of slipping past an assertion over an object the test wrote for itself.
  const input: Required<LocalOnlyStartupInput> = {
    nodeEnv: PROD, trustProxy: "", allowLocalOnly: undefined, authHost: LAN_AUTH_HOST,
  };
  assert.deepEqual(Object.keys(input).sort(), ["allowLocalOnly", "authHost", "nodeEnv", "trustProxy"]);
  assert.equal(evaluateLocalOnlyStartup(input).reason, "missing-opt-in");

  // And the values a client WOULD send as Host — including the loopback and
  // RFC1918 spellings that satisfy the runtime gate — cannot make an
  // un-opted-in production instance boot.
  for (const spoofed of ["127.0.0.1", "localhost", "10.0.0.1", "[::1]", "192.168.1.1"]) {
    assert.equal(isLocalHost(spoofed), true, "precondition: the runtime gate accepts this Host");
    const d = prodLocalOnly({ authHost: spoofed });
    assert.equal(d.fatal, true, `Host-shaped value ${spoofed} must not authorize a production boot`);
    assert.equal(d.reason, "missing-opt-in");
  }
});

test("isPublicAuthHost errs toward private so a LAN deployment is never bricked", () => {
  assert.equal(isPublicAuthHost("requests.example.com"), true);
  assert.equal(isPublicAuthHost("[2001:db8::1]"), true); // public IPv6 literal
  assert.equal(isPublicAuthHost("REQUESTS.EXAMPLE.COM"), true); // case-insensitive
  for (const priv of [
    "", " ", undefined, null, "localhost", "summonarr", "127.0.0.1", "192.168.1.50",
    "[::1]", "[fd00::1]", "nas.local", "box.lan", "app.internal", "media.home", "x.home.arpa",
  ]) {
    assert.equal(isPublicAuthHost(priv), false, `${JSON.stringify(priv)} must read as private`);
  }
});
