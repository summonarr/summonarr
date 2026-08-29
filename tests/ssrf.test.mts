// Unit tests for the SSRF address policy (src/lib/ssrf.ts) — the layer under
// every safe-fetch helper. All cases use IP-literal hosts so no DNS resolution
// happens; the properties pinned are the block rules themselves: loopback,
// RFC1918, link-local (cloud metadata!), CGNAT, multicast, unspecified — plus
// the IPv6-embedded-IPv4 unwrapping that dotted-form regexes alone would miss.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveToSafeUrl,
  resolveToSafeUrlWithAddrs,
  verifyResolvedHost,
  isSafeAddrForAdmin,
} from "../src/lib/ssrf.ts";

test("public IPv4 literals pass; the URL is normalized (bare trailing slash stripped)", async () => {
  assert.equal(await resolveToSafeUrl("http://8.8.8.8/"), "http://8.8.8.8");
  assert.equal(await resolveToSafeUrl("https://1.1.1.1/api/v3/movie?x=1"), "https://1.1.1.1/api/v3/movie?x=1");
  const r = await resolveToSafeUrlWithAddrs("http://8.8.8.8/x");
  assert.deepEqual(r?.addrs, ["8.8.8.8"]);
});

test("loopback, RFC1918, link-local, CGNAT, multicast, reserved → blocked (user policy)", async () => {
  for (const url of [
    "http://127.0.0.1/",
    "http://127.8.9.10:8080/",
    "http://0.0.0.0/",
    "http://10.1.2.3/",
    "http://172.16.0.1/",
    "http://172.31.255.255/",
    "http://192.168.1.5:7878/",
    "http://100.64.0.1/", // CGNAT
    "http://169.254.169.254/latest/meta-data/", // cloud metadata endpoint
    "http://224.0.0.1/", // multicast
    "http://240.0.0.1/", // reserved
    "http://[::1]/",
  ]) {
    assert.equal(await resolveToSafeUrl(url), null, `${url} must be blocked`);
  }
});

test("boundary addresses just OUTSIDE the private ranges are allowed", async () => {
  assert.notEqual(await resolveToSafeUrl("http://172.15.255.255/"), null);
  assert.notEqual(await resolveToSafeUrl("http://172.32.0.1/"), null);
  assert.notEqual(await resolveToSafeUrl("http://100.63.0.1/"), null);
  assert.notEqual(await resolveToSafeUrl("http://100.128.0.1/"), null);
  assert.notEqual(await resolveToSafeUrl("http://11.0.0.1/"), null);
});

test("IPv6-embedded IPv4 unwraps and inherits the IPv4 verdict", async () => {
  // IPv4-mapped, dotted and hex-pair spellings
  assert.equal(await resolveToSafeUrl("http://[::ffff:127.0.0.1]/"), null);
  assert.equal(await resolveToSafeUrl("http://[::ffff:7f00:1]/"), null);
  assert.equal(await resolveToSafeUrl("http://[::ffff:10.0.0.1]/"), null);
  // NAT64 prefix carrying a loopback target
  assert.equal(await resolveToSafeUrl("http://[64:ff9b::7f00:1]/"), null);
});

test("IPv6 unspecified address is blocked in every spelling", async () => {
  assert.equal(await resolveToSafeUrl("http://[::]/"), null);
  assert.equal(await resolveToSafeUrl("http://[0:0:0:0:0:0:0:0]/"), null);
  assert.equal(await resolveToSafeUrl("http://[::]/x", { allowPrivate: true }), null);
});

test("non-http(s) protocols and unparseable URLs → null", async () => {
  assert.equal(await resolveToSafeUrl("ftp://8.8.8.8/file"), null);
  assert.equal(await resolveToSafeUrl("javascript:alert(1)"), null);
  assert.equal(await resolveToSafeUrl("not a url"), null);
  assert.equal(await resolveToSafeUrl(""), null);
});

test("admin policy (allowPrivate): LAN + loopback OK, link-local + unspecified still blocked", async () => {
  const admin = { allowPrivate: true };
  assert.notEqual(await resolveToSafeUrl("http://192.168.1.10:7878/", admin), null);
  assert.notEqual(await resolveToSafeUrl("http://10.0.0.2:8989/", admin), null);
  assert.notEqual(await resolveToSafeUrl("http://127.0.0.1:32400/", admin), null);
  assert.notEqual(await resolveToSafeUrl("http://[fd00::1]:8096/", admin), null); // ULA
  // The whole point of keeping a policy at all in admin mode:
  assert.equal(await resolveToSafeUrl("http://169.254.169.254/", admin), null);
  assert.equal(await resolveToSafeUrl("http://0.0.0.0:3000/", admin), null);
  assert.equal(await resolveToSafeUrl("http://[fe80::1]/", admin), null);
  // AWS IPv6 IMDS is ULA, so the admin ULA carve-out would otherwise allow it.
  assert.equal(await resolveToSafeUrl("http://[fd00:ec2::254]/", admin), null);
  assert.equal(await resolveToSafeUrl("http://[fd00:ec2:0:0:0:0:0:254]/", admin), null);
});

test("isSafeAddrForAdmin: raw-address admin policy incl. embedded-IPv4 unwrap", () => {
  assert.equal(isSafeAddrForAdmin("10.0.0.1"), true);
  assert.equal(isSafeAddrForAdmin("127.0.0.1"), true);
  assert.equal(isSafeAddrForAdmin("169.254.0.1"), false);
  assert.equal(isSafeAddrForAdmin("0.0.0.0"), false);
  assert.equal(isSafeAddrForAdmin("0:0:0:0:0:0:0:0"), false);
  assert.equal(isSafeAddrForAdmin("fe80::1"), false);
  assert.equal(isSafeAddrForAdmin("fec0::1"), false); // deprecated site-local stays blocked
  assert.equal(isSafeAddrForAdmin("::ffff:169.254.1.1"), false); // unwrap → link-local
  // Multicast / reserved / broadcast: no admin-configured server lives there,
  // and a typo'd 239.x/255.255.255.255 would emit a segment-wide HTTP request.
  assert.equal(isSafeAddrForAdmin("239.255.255.250"), false); // SSDP multicast
  assert.equal(isSafeAddrForAdmin("224.0.0.1"), false);
  assert.equal(isSafeAddrForAdmin("255.255.255.255"), false); // broadcast
  assert.equal(isSafeAddrForAdmin("240.0.0.1"), false); // reserved 240/4
  assert.equal(isSafeAddrForAdmin("ff02::1"), false); // IPv6 multicast
  // AWS IMDSv2 IPv6 (fd00:ec2::254) is ULA, but it is metadata, not a LAN server.
  assert.equal(isSafeAddrForAdmin("fd00:ec2::254"), false);
  assert.equal(isSafeAddrForAdmin("fd00:ec2:0:0:0:0:0:254"), false);
  assert.equal(isSafeAddrForAdmin("FD00:EC2::254"), false);
  // Neighbouring ULA still passes — the carve-out is the one metadata address.
  assert.equal(isSafeAddrForAdmin("fd00::1"), true);
  assert.equal(isSafeAddrForAdmin("fd00:ec2::1"), true);
  assert.equal(isSafeAddrForAdmin("fd00:ec2::253"), true);
});

test("verifyResolvedHost re-checks a literal host under the chosen policy", async () => {
  assert.equal(await verifyResolvedHost("8.8.8.8"), true);
  assert.equal(await verifyResolvedHost("127.0.0.1"), false);
  assert.equal(await verifyResolvedHost("[::1]"), false); // bracketed form accepted defensively
  assert.equal(await verifyResolvedHost("192.168.1.10"), false);
  assert.equal(await verifyResolvedHost("192.168.1.10", { allowPrivate: true }), true);
  assert.equal(await verifyResolvedHost("169.254.169.254", { allowPrivate: true }), false);
});

test("non-compressed NAT64 spelling is blocked by the embedded-IPv4 unwrap, not the `64:ff9b::` regex", async () => {
  // The `/^64:ff9b::/` rule in isSafeAddr only matches the COMPRESSED spelling.
  // WHATWG URL canonicalizes IPv6 literals (compresses the longest zero run), so
  // the URL path normalizes `64:ff9b:0:0:0:0:7f00:1` back to `64:ff9b::7f00:1`
  // before the policy sees it — pin that end-to-end behavior anyway:
  assert.equal(await resolveToSafeUrl("http://[64:ff9b:0:0:0:0:7f00:1]/"), null);
  // …but verifyResolvedHost takes a RAW address (this is also the shape DNS answers
  // arrive in), with no URL canonicalization in front. Here ONLY unwrapEmbeddedV4's
  // NAT64 (64:ff9b::/96) branch stands between the request and 127.0.0.1 — this is
  // the assertion that catches a regression in that branch.
  assert.equal(await verifyResolvedHost("64:ff9b:0:0:0:0:7f00:1"), false);
  // Same branch on the admin policy: NAT64-embedded link-local (cloud metadata)
  // must stay blocked even with allowPrivate. a9fe:a9fe = 169.254.169.254.
  assert.equal(isSafeAddrForAdmin("64:ff9b:0:0:0:0:a9fe:a9fe"), false);
});

test("deprecated IPv4-compatible ::/96 embedding unwraps and is blocked", async () => {
  // ::7f00:1 IS 127.0.0.1 in the deprecated IPv4-compatible mapping. No dotted-form
  // regex and no other rule in isSafeAddr matches this spelling — only the
  // prefix96 === 0 (low32 > 1) branch of unwrapEmbeddedV4 blocks it. URL parsing
  // preserves this form (it's already canonical), so the whole path is exercised.
  assert.equal(await resolveToSafeUrl("http://[::7f00:1]/"), null);
  assert.equal(await verifyResolvedHost("::7f00:1"), false);
  // Embedded RFC1918 via the same prefix
  assert.equal(await resolveToSafeUrl("http://[::a00:1]/"), null); // ::a00:1 = 10.0.0.1
});

test("SIIT ::ffff:0:0:0/96 form unwraps and is blocked", async () => {
  // The three-group tail `0:7f00:1` does NOT match unwrapV4Mapped's two-hex-group
  // regex, and it is not the plain IPv4-mapped prefix — only the
  // prefix96 === 0xffff0000 (SIIT) branch of unwrapEmbeddedV4 blocks it.
  assert.equal(await resolveToSafeUrl("http://[::ffff:0:7f00:1]/"), null);
  assert.equal(await verifyResolvedHost("::ffff:0:7f00:1"), false);
  // SIIT-embedded link-local stays blocked under the admin policy too
  assert.equal(isSafeAddrForAdmin("::ffff:0:a9fe:a9fe"), false);
});

test("admin policy blocks 6to4/Teredo — unwrapEmbeddedV4 misses these prefixes", async () => {
  // 6to4 embeds IPv4 in bits 16–47, which unwrapEmbeddedV4 (prefix96 of the last
  // 32 bits) does not look at. 2002:a9fe:a9fe:: is 6to4 of 169.254.169.254 —
  // the same cloud-metadata address the NAT64/SIIT admin pins already cover.
  // Bit-prefix check (not the textual /^2002:/ regex) so zero-padded/expanded
  // spellings cannot slip through.
  assert.equal(isSafeAddrForAdmin("2002:a9fe:a9fe::"), false);
  assert.equal(isSafeAddrForAdmin("2002:a9fe:a9fe:0:0:0:0:0"), false);
  assert.equal(isSafeAddrForAdmin("2002:A9FE:A9FE::"), false);
  // Teredo 2001:0::/32 — same hole: not an embedded-v4 prefix96 form.
  assert.equal(isSafeAddrForAdmin("2001:0:4136:e378:8000:63bf:3fff:fdd2"), false);
  assert.equal(isSafeAddrForAdmin("2001::4136:e378:8000:63bf:3fff:fdd2"), false);
  assert.equal(isSafeAddrForAdmin("2001:0000:4136:e378:8000:63bf:3fff:fdd2"), false);
  // Wholesale prefix reject, matching the user policy: 6to4 of RFC1918 / public
  // IPv4 is still a tunnel, and an admin server is never a 6to4 literal.
  assert.equal(isSafeAddrForAdmin("2002:c0a8:1::"), false); // 192.168.0.1 via 6to4
  assert.equal(isSafeAddrForAdmin("2002:808:808::1"), false); // 8.8.8.8 via 6to4
  // Ordinary 2001::/16 global unicast must still pass (Google Public DNS).
  assert.equal(isSafeAddrForAdmin("2001:4860:4860::8888"), true);

  const admin = { allowPrivate: true };
  assert.equal(await resolveToSafeUrl("http://[2002:a9fe:a9fe::]/", admin), null);
  assert.equal(await resolveToSafeUrl("http://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/", admin), null);
  assert.equal(await verifyResolvedHost("2002:a9fe:a9fe::", admin), false);
  assert.equal(await verifyResolvedHost("2001:0:4136:e378:8000:63bf:3fff:fdd2", admin), false);
  assert.notEqual(await resolveToSafeUrl("http://[2001:4860:4860::8888]/", admin), null);
});

test("default (user) policy blocks IPv6-native private/tunnel/multicast ranges", async () => {
  for (const url of [
    "http://[fd00::1]/", // ULA fc00::/7 — allowed for admin (tested above), MUST block for users
    "http://[fc00::1]/", // ULA, fc-prefix half
    "http://[2002:808:808::1]/", // 6to4 — tunnels to arbitrary IPv4, incl. private
    "http://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/", // Teredo (2001:0::/32)
    "http://[ff02::1]/", // IPv6 multicast (all-nodes)
    "http://[fec0::1]/", // deprecated site-local, user policy
  ]) {
    assert.equal(await resolveToSafeUrl(url), null, `${url} must be blocked for users`);
  }
  // The Teredo rule (`2001:0*:`) must NOT swallow ordinary 2001::/16 global
  // unicast — Google public DNS lives there.
  assert.notEqual(await resolveToSafeUrl("http://[2001:4860:4860::8888]/"), null);
});

test("IPv6 unspecified: mixed-notation and zero-padded spellings are blocked", async () => {
  // ::0.0.0.0 — unwrapEmbeddedV4 deliberately returns null here (low32 <= 1, the
  // `skips ::, ::1` guard), so ONLY isUnspecifiedV6's mixed-notation branch blocks it.
  assert.equal(isSafeAddrForAdmin("::0.0.0.0"), false);
  assert.equal(await verifyResolvedHost("::0.0.0.0"), false); // user policy, raw address
  // Fully zero-padded expansion — URL would canonicalize it to `::`, so go through
  // the raw-address entry points where isUnspecifiedV6 alone must catch it.
  assert.equal(isSafeAddrForAdmin("0000:0000:0000:0000:0000:0000:0000:0000"), false);
  assert.equal(await verifyResolvedHost("0000:0000:0000:0000:0000:0000:0000:0000"), false);
});

test("CGNAT top inside edge (100.127.x) is blocked", async () => {
  // Bottom inside edge (100.64) and both outside edges (100.63 / 100.128) are
  // covered above; without this, a typo like `12[0-6]` in the last alternation
  // of the CGNAT regex would pass every existing assertion.
  assert.equal(await resolveToSafeUrl("http://100.127.255.255/"), null);
});

test("a MEANINGFUL trailing slash on the path is preserved — only a bare origin is collapsed", async () => {
  // The strip was anchored to the end of the whole serialized URL, so it ate the
  // final separator of a real path: ".../application/o/token/" became
  // ".../application/o/token", a DIFFERENT resource. safe-fetch's admin and user
  // modes fetch this exact string, so every OIDC token/userinfo/JWKS call to an
  // IdP whose endpoints canonically end in "/" (Authentik) hit the wrong path —
  // and redirect:"error" turned the upstream's 301 back into a thrown
  // SafeFetchError rather than following it.
  assert.equal(
    await resolveToSafeUrl("https://8.8.8.8/application/o/token/"),
    "https://8.8.8.8/application/o/token/",
  );
  assert.equal(await resolveToSafeUrl("https://8.8.8.8/a/b/"), "https://8.8.8.8/a/b/");
  // Bare origin still normalizes (the case the strip was written for)...
  assert.equal(await resolveToSafeUrl("https://8.8.8.8/"), "https://8.8.8.8");
  // ...and a query/fragment on the root path is not an empty path.
  assert.equal(await resolveToSafeUrl("https://8.8.8.8/?a=1"), "https://8.8.8.8/?a=1");
});

test("link-local is blocked across the whole fe80::/10, not just the fe80: hextet", async () => {
  // Link-local is fe80::–febf::. The guard matched only the literal `fe80:`
  // hextet, leaving fe81–febf allowed in BOTH policies while the file header and
  // CLAUDE.md both claim link-local is blocked outright.
  for (const addr of ["fe80::1", "fe81::1", "fe90::1", "fea0::1", "febf::1"]) {
    assert.equal(isSafeAddrForAdmin(addr), false, `${addr} must be blocked (admin mode)`);
    assert.equal(await verifyResolvedHost(addr), false, `${addr} must be blocked (user mode)`);
  }
  // The neighbouring site-local range stays blocked, and fe7f/fec0 boundaries hold.
  assert.equal(isSafeAddrForAdmin("fec0::1"), false);
  // Just below the range is a normal global address and must still pass.
  assert.equal(isSafeAddrForAdmin("fe7f::1"), true);
});
