// The one IPv6 text parser (src/lib/ipv6-parse.ts) shared by the SSRF policy,
// the machine-session IP allowlist and the rate-limit bucket key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { ipv6Groups, ipv6ToBigInt } from "../src/lib/ipv6-parse.ts";

test("parses compressed, embedded-IPv4 and zone-id forms to the same groups", () => {
  assert.deepEqual(ipv6Groups("::"), [0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(ipv6Groups("::1"), [0, 0, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual(ipv6Groups("2001:DB8::8a2e:370:7334"), [0x2001, 0xdb8, 0, 0, 0, 0x8a2e, 0x370, 0x7334]);
  assert.deepEqual(ipv6Groups("::ffff:1.2.3.4"), ipv6Groups("::ffff:102:304"));
  assert.deepEqual(ipv6Groups("0:0:0:0:0:ffff:0102:0304"), ipv6Groups("::ffff:1.2.3.4"));
  assert.deepEqual(ipv6Groups("fe80::1%eth0"), ipv6Groups("fe80::1"));
  assert.equal(ipv6ToBigInt("::1"), 1n);
  assert.equal(ipv6ToBigInt("::ffff:127.0.0.1"), (0xffffn << 32n) | 0x7f000001n);
});

test("rejects what Node's isIP rejects", () => {
  for (const bad of [
    "1:2:3:4:5:6:7::8", // `::` must stand for at least one zero group
    "1::2::3",
    "1:2:3:4:5:6:7",
    "1:2:3:4:5:6:7:8:9",
    "12345::1",
    "::ffff:256.1.1.1",
    "1:2:3:4:5:6:7:1.2.3.4",
    "g::1",
    "1.2.3.4",
    "",
  ]) {
    assert.notEqual(isIP(bad), 6, `${bad} is not an IPv6 literal`);
    assert.equal(ipv6Groups(bad), null, bad);
    assert.equal(ipv6ToBigInt(bad), null, bad);
  }
});

test("the SSRF policy, the IP allowlist and the rate-limit key share this parser and keep no copy", () => {
  for (const file of ["src/lib/ssrf.ts", "src/lib/ip-allowlist.ts", "src/lib/rate-limit.ts"]) {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.match(src, /from "\.\/ipv6-parse"/, `${file} imports the shared parser`);
    assert.doesNotMatch(src, /function (ipv6ToBigInt|expandIpv6Groups|ipv6Groups)\b/, `${file} declares no IPv6 parser of its own`);
    assert.doesNotMatch(src, /split\("::"\)|indexOf\("::"\)/, `${file} expands no \`::\` itself`);
  }
});
