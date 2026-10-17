// trustedProxyStartupWarnings (src/lib/local-only.ts) — the boot warnings for a
// TRUST_PROXY=true deployment. With TRUST_PROXY=true the client IP (per-IP rate
// limits, audit/device rows, the machine-session IP allowlist) comes from
// X-Forwarded-For, which is only honest when the app port is reachable through
// the reverse proxy alone and the proxy overwrites the header. The compose
// default publishes the port on every interface, so the operator is told on
// every boot. Pure rule here, wiring pinned structurally (instrumentation.ts
// can't be booted by this suite — it process.exit()s).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { trustedProxyStartupWarnings } from "../src/lib/local-only.ts";

test("TRUST_PROXY=true warns that the port must be proxy-only and the proxy must overwrite X-Forwarded-For", () => {
  for (const nodeEnv of ["production", "development", undefined]) {
    const warnings = trustedProxyStartupWarnings({ nodeEnv, trustProxy: "true", authProtocol: "https:" });
    assert.equal(warnings.length, 1, `nodeEnv=${nodeEnv}`);
    assert.match(warnings[0], /^\[startup\] TRUST_PROXY=true/);
    assert.match(warnings[0], /127\.0\.0\.1:3001:3000/, "names the loopback publish");
    assert.match(warnings[0], /OVERWRITE X-Forwarded-For/);
    assert.match(warnings[0], /proxy_set_header X-Forwarded-For \$remote_addr;/);
  }
});

test("no TRUST_PROXY=true, no warning — local-only mode has its own (evaluateLocalOnlyStartup)", () => {
  for (const trustProxy of [undefined, "", "false", "TRUE", "1", " true"]) {
    assert.deepEqual(
      trustedProxyStartupWarnings({ nodeEnv: "production", trustProxy, authProtocol: "http:" }),
      [],
      `trustProxy=${JSON.stringify(trustProxy)}`,
    );
  }
});

test("a plain-http AUTH_URL adds the header-spoofing warning, in production only", () => {
  const prod = trustedProxyStartupWarnings({ nodeEnv: "production", trustProxy: "true", authProtocol: "http:" });
  assert.equal(prod.length, 2);
  assert.match(prod[1], /AUTH_URL uses http:\/\//);
  assert.equal(trustedProxyStartupWarnings({ nodeEnv: "development", trustProxy: "true", authProtocol: "http:" }).length, 1);
  assert.equal(trustedProxyStartupWarnings({ nodeEnv: "production", trustProxy: "true", authProtocol: "" }).length, 1);
});

test("boot wires the rule: instrumentation.ts warns every line it returns, fed from the real env", () => {
  const src = readFileSync(new URL("../src/instrumentation.ts", import.meta.url), "utf8");
  const call = src.indexOf("trustedProxyStartupWarnings({");
  assert.ok(call > 0, "instrumentation.ts must call trustedProxyStartupWarnings");
  const around = src.slice(call - 40, call + 400);
  assert.match(around, /for \(const warning of trustedProxyStartupWarnings\(\{/);
  assert.match(around, /trustProxy: process\.env\.TRUST_PROXY/);
  assert.match(around, /nodeEnv: process\.env\.NODE_ENV/);
  assert.match(around, /authProtocol: authUrl\?\.protocol/);
  assert.match(around, /\}\)\) \{\s*console\.warn\(warning\);/);
  assert.doesNotMatch(src, /AUTH_URL uses http:\/\//, "the http rule lives in local-only.ts, not inline");
});

test("the deploy docs carry both rules, and the compose default binding is unchanged (owner decision)", () => {
  const readme = readFileSync(new URL("../docker-container/README.md", import.meta.url), "utf8");
  const envExample = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
  const compose = readFileSync(new URL("../docker-container/docker-compose.yml", import.meta.url), "utf8");
  for (const [name, doc] of [["README.md", readme], [".env.example", envExample]] as const) {
    assert.match(doc, /"127\.0\.0\.1:3001:3000"/, `${name} names the loopback publish`);
    assert.match(doc, /proxy_set_header X-Forwarded-For \$remote_addr;/, `${name} names the overwrite`);
  }
  assert.match(readme, /### Reach the app only through the reverse proxy \(`TRUST_PROXY=true`\)/);
  assert.doesNotMatch(readme, /proxy_set_header X-Forwarded-For\s+\$proxy_add_x_forwarded_for/, "no example appends a client-supplied value");
  // Left as-is so LAN deployments keep working; the docs and the boot warning do the steering.
  assert.match(compose, /\n\s+- "3001:3000"\n/);
});
