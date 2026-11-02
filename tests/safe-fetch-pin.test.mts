// DNS-rebinding / connection-pinning tests for src/lib/safe-fetch.ts.
//
// The property under test: the TCP connection goes to an address that passed
// the SSRF policy, never to whatever the hostname resolves to LATER. Resolution
// is stubbed by replacing `dns/promises`.lookup (what ssrf.ts calls); the OS
// resolver (getaddrinfo, what a bare fetch(hostname) would use) is NOT stubbed,
// so a request that dials by hostname reaches whatever the OS says — "localhost"
// resolves to loopback — and the local test server sees it. A pinned request
// never does. No test touches a real remote host: the only public address used
// is TEST-NET-1 (192.0.2.1), which is unroutable.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";
import http from "node:http";
import zlib from "node:zlib";
import type { AddressInfo } from "node:net";
import {
  safeFetch,
  safeFetchTrusted,
  safeFetchAdminConfigured,
  SafeFetchError,
  makePinnedLookup,
  buildPinnedRequestOptions,
} from "../src/lib/safe-fetch.ts";

type LookupFn = typeof dns.lookup;
const realLookup = dns.lookup;
const servers: http.Server[] = [];

afterEach(() => {
  (dns as { lookup: LookupFn }).lookup = realLookup;
  while (servers.length) {
    const s = servers.pop()!;
    s.closeAllConnections();
    s.close();
  }
  delete process.env.NODE_USE_ENV_PROXY;
  delete process.env.HTTP_PROXY;
});

// Replace the resolver: `answers(host, callIndex)` returns the address list.
function stubDns(answers: (host: string, n: number) => string[]): { calls: string[] } {
  const calls: string[] = [];
  (dns as { lookup: unknown }).lookup = async (host: string) => {
    const n = calls.filter((h) => h === host).length;
    calls.push(host);
    return answers(host, n).map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };
  return { calls };
}

async function listen(
  handler: http.RequestListener,
): Promise<{ port: number; hits: http.IncomingMessage[] }> {
  const hits: http.IncomingMessage[] = [];
  const server = http.createServer((req, res) => {
    hits.push(req);
    handler(req, res);
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { port: (server.address() as AddressInfo).port, hits };
}

async function rejection(p: Promise<Response>): Promise<SafeFetchError> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof SafeFetchError, `expected SafeFetchError, got ${String(e)}`);
    return e;
  }
  assert.fail("expected rejection");
}

const ok = (_q: http.IncomingMessage, r: http.ServerResponse) => { r.end("ok"); };

// ---------------------------------------------------------------------------
// The rebinding tests
// ---------------------------------------------------------------------------

test("REBIND: validated public address is dialled, NOT what the OS resolves later (user mode)", async () => {
  const { port, hits } = await listen(ok);
  // Every ssrf lookup says "public"; the OS resolver (used by a bare fetch()) says
  // localhost = loopback, where the test server listens.
  stubDns(() => ["192.0.2.1"]);
  const err = await rejection(safeFetch(`http://localhost:${port}/`, { timeoutMs: 400 }));
  assert.match(err.reason, /timeout|network/);
  assert.equal(hits.length, 0, "the loopback server must never be reached");
});

test("REBIND: trusted mode pins too", async () => {
  const { port, hits } = await listen(ok);
  stubDns(() => ["192.0.2.1"]);
  const err = await rejection(
    safeFetchTrusted(`http://localhost:${port}/`, { allowedHosts: ["localhost"], timeoutMs: 400 }),
  );
  assert.match(err.reason, /timeout|network/);
  assert.equal(hits.length, 0);
});

test("REBIND: an answer that flips to a private address after validation is refused (user)", async () => {
  const { port, hits } = await listen(ok);
  stubDns((_h, n) => (n === 0 ? ["192.0.2.1"] : ["127.0.0.1"]));
  const err = await rejection(safeFetch(`http://flip-user.test:${port}/`, { timeoutMs: 400 }));
  assert.equal(err.reason, "ssrf-blocked");
  assert.equal(hits.length, 0);
});

test("REBIND: admin mode still blocks link-local after a flip to 169.254.169.254", async () => {
  const { port, hits } = await listen(ok);
  stubDns((_h, n) => (n === 0 ? ["127.0.0.1"] : ["169.254.169.254"]));
  const err = await rejection(safeFetchAdminConfigured(`http://flip-admin.test:${port}/`, { timeoutMs: 400 }));
  assert.equal(err.reason, "ssrf-blocked");
  assert.equal(hits.length, 0);
});

test("PIN: admin mode dials the validated address for a name the OS cannot resolve; Host is the original name", async () => {
  const { port, hits } = await listen((req, res) => { res.end(req.headers.host ?? ""); });
  stubDns(() => ["127.0.0.1"]);
  const res = await safeFetchAdminConfigured(`http://pinned-ok.test:${port}/p?q=1`);
  assert.equal(await res.text(), `pinned-ok.test:${port}`);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].url, "/p?q=1");
});

// ---------------------------------------------------------------------------
// Address-set policy
// ---------------------------------------------------------------------------

test("MULTI: one private record among public ones refuses the request (user)", async () => {
  const { port, hits } = await listen(ok);
  stubDns(() => ["8.8.8.8", "127.0.0.1"]);
  const err = await rejection(safeFetch(`http://multi-user.test:${port}/`, { timeoutMs: 400 }));
  assert.equal(err.reason, "ssrf-blocked");
  assert.equal(hits.length, 0);
});

test("MULTI: one link-local record among private ones refuses the request (admin)", async () => {
  const { port, hits } = await listen(ok);
  stubDns(() => ["127.0.0.1", "169.254.169.254"]);
  const err = await rejection(safeFetchAdminConfigured(`http://multi-admin.test:${port}/`, { timeoutMs: 400 }));
  assert.equal(err.reason, "ssrf-blocked");
  assert.equal(hits.length, 0);
});

test("MULTI: a single bad record appearing only in the FRESH answer refuses (trusted)", async () => {
  const { port, hits } = await listen(ok);
  stubDns((_h, n) => (n === 0 ? ["192.0.2.1"] : ["192.0.2.1", "10.0.0.5"]));
  const err = await rejection(
    safeFetchTrusted(`http://multi-fresh.test:${port}/`, { allowedHosts: ["multi-fresh.test"], timeoutMs: 400 }),
  );
  assert.equal(err.reason, "ssrf-blocked");
  assert.equal(hits.length, 0);
});

test("IP literals: loopback literal is refused in user mode, allowed in admin mode", async () => {
  const { port, hits } = await listen(ok);
  const err = await rejection(safeFetch(`http://127.0.0.1:${port}/`));
  assert.equal(err.reason, "ssrf-blocked");
  assert.equal(hits.length, 0);
  const res = await safeFetchAdminConfigured(`http://127.0.0.1:${port}/`);
  assert.equal(await res.text(), "ok");
  assert.equal(hits.length, 1);
});

test("IP literals: 169.254.169.254 and 0.0.0.0 stay blocked in admin mode", async () => {
  for (const u of ["http://169.254.169.254/latest/meta-data", "http://0.0.0.0:1/"]) {
    assert.equal((await rejection(safeFetchAdminConfigured(u))).reason, "ssrf-blocked");
  }
});

// ---------------------------------------------------------------------------
// The pinned resolver / connection options
// ---------------------------------------------------------------------------

test("makePinnedLookup answers only with the pinned set, honouring family and all", () => {
  const lookup = makePinnedLookup(["192.0.2.1", "2001:db8::1"]);
  let got: unknown;
  lookup("anything.example", { all: true }, (_e, a) => { got = a; });
  assert.deepEqual(got, [
    { address: "192.0.2.1", family: 4 },
    { address: "2001:db8::1", family: 6 },
  ]);
  let single: unknown[] = [];
  lookup("anything.example", {}, (_e, a, f) => { single = [a, f]; });
  assert.deepEqual(single, ["192.0.2.1", 4]);
  lookup("anything.example", { family: 6, all: true }, (_e, a) => { got = a; });
  assert.deepEqual(got, [{ address: "2001:db8::1", family: 6 }]);
  let error: unknown;
  makePinnedLookup(["192.0.2.1"])("x", { family: 6 }, (e) => { error = e; });
  assert.equal((error as { code?: string }).code, "ENOTFOUND");
});

test("TLS: servername, hostname and lookup are the original host / pinned set; agent is per-request", async () => {
  const o = buildPinnedRequestOptions(new URL("https://api.example.com:8443/a?b=1"), ["192.0.2.7"], {
    method: "GET", headers: {}, signal: new AbortController().signal,
  });
  assert.equal(o.hostname, "api.example.com");
  assert.equal(o.servername, "api.example.com");
  assert.equal(o.port, "8443");
  assert.equal(o.path, "/a?b=1");
  assert.equal(o.agent, false);
  let addr: unknown;
  (o.lookup as (h: string, o: object, cb: (e: null, a: unknown) => void) => void)("api.example.com", { all: true }, (_e, a) => { addr = a; });
  assert.deepEqual(addr, [{ address: "192.0.2.7", family: 4 }]);

  const lit = buildPinnedRequestOptions(new URL("https://[2001:db8::1]/x"), ["2001:db8::1"], {
    method: "GET", headers: {}, signal: new AbortController().signal,
  });
  assert.equal(lit.hostname, "2001:db8::1");
  assert.equal(lit.servername, undefined, "no SNI for an IP literal");
});

// ---------------------------------------------------------------------------
// Behaviour preserved: caps, timeouts, redirects, bodies, encodings
// ---------------------------------------------------------------------------

test("size cap: declared Content-Length over the cap is refused", async () => {
  const { port } = await listen((_q, r) => { r.setHeader("content-length", "5000"); r.end("x".repeat(5000)); });
  const err = await rejection(safeFetchAdminConfigured(`http://127.0.0.1:${port}/`, { maxResponseBytes: 1000 }));
  assert.equal(err.reason, "size");
});

test("size cap: a chunked body that streams past the cap errors while reading", async () => {
  const { port } = await listen((_q, r) => { r.write("x".repeat(600)); setTimeout(() => r.end("y".repeat(600)), 20); });
  const res = await safeFetchAdminConfigured(`http://127.0.0.1:${port}/`, { maxResponseBytes: 1000 });
  await assert.rejects(res.text(), (e: unknown) => e instanceof SafeFetchError && e.reason === "size");
});

test("size cap applies to DECODED bytes (gzip bomb)", async () => {
  const { port } = await listen((_q, r) => {
    r.setHeader("content-encoding", "gzip");
    r.end(zlib.gzipSync(Buffer.alloc(200_000, 0x61)));
  });
  const res = await safeFetchAdminConfigured(`http://127.0.0.1:${port}/`, { maxResponseBytes: 1000 });
  await assert.rejects(res.text(), (e: unknown) => e instanceof SafeFetchError && e.reason === "size");
});

test("gzip/br responses are decoded and the encoding headers are stripped", async () => {
  const { port } = await listen((req, r) => {
    const br = req.url === "/br";
    r.setHeader("content-encoding", br ? "br" : "gzip");
    r.setHeader("content-type", "application/json");
    r.end((br ? zlib.brotliCompressSync : zlib.gzipSync)(Buffer.from('{"a":1}')));
  });
  for (const p of ["/gz", "/br"]) {
    const res = await safeFetchAdminConfigured(`http://127.0.0.1:${port}${p}`);
    assert.equal(res.headers.get("content-encoding"), null);
    assert.deepEqual(await res.json(), { a: 1 });
  }
});

test("timeout: a server that never answers yields reason=timeout", async () => {
  const { port } = await listen(() => { /* never respond */ });
  const err = await rejection(safeFetchAdminConfigured(`http://127.0.0.1:${port}/`, { timeoutMs: 200 }));
  assert.equal(err.reason, "timeout");
});

test("timeout: a stall mid-body surfaces as a timeout SafeFetchError on read", async () => {
  const { port } = await listen((_q, r) => { r.write("partial"); /* then stall */ });
  const res = await safeFetchAdminConfigured(`http://127.0.0.1:${port}/`, { timeoutMs: 300 });
  await assert.rejects(res.text(), (e: unknown) => e instanceof SafeFetchError && e.reason === "timeout");
});

test("caller AbortSignal cancels the request", async () => {
  const { port } = await listen(() => { /* never respond */ });
  const ac = new AbortController();
  const p = safeFetchAdminConfigured(`http://127.0.0.1:${port}/`, { signal: ac.signal, timeoutMs: 5000 });
  setTimeout(() => ac.abort(), 50);
  await rejection(p);
});

test("redirects are refused, never followed", async () => {
  const { port, hits } = await listen((req, r) => {
    if (req.url === "/start") { r.statusCode = 302; r.setHeader("location", "/next"); r.end(); } else r.end("followed");
  });
  const err = await rejection(safeFetchAdminConfigured(`http://127.0.0.1:${port}/start`));
  assert.match(err.message, /unexpected redirect/);
  assert.equal(hits.length, 1, "the redirect target must not be requested");
});

test("POST bodies, methods and headers reach the server intact", async () => {
  const { port } = await listen((req, r) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () =>
      r.end(JSON.stringify({
        method: req.method,
        body: Buffer.concat(chunks).toString(),
        ct: req.headers["content-type"],
        ua: req.headers["user-agent"],
        custom: req.headers["x-custom"],
        len: req.headers["content-length"],
      })));
  });
  const res = await safeFetchAdminConfigured(`http://127.0.0.1:${port}/`, {
    method: "POST",
    body: JSON.stringify({ k: "v" }),
    headers: { "content-type": "application/json", "x-custom": "1" },
  });
  assert.deepEqual(await res.json(), {
    method: "POST", body: '{"k":"v"}', ct: "application/json", ua: "Summonarr/0.1", custom: "1", len: "9",
  });
  const bin = await safeFetchAdminConfigured(`http://127.0.0.1:${port}/`, { method: "PUT", body: new Uint8Array([104, 105]) });
  assert.equal((await bin.json()).body, "hi");
});

test("status, statusText and duplicate headers survive; 204 and HEAD have no body", async () => {
  const { port } = await listen((req, r) => {
    if (req.url === "/204") { r.statusCode = 204; r.end(); return; }
    r.statusCode = 418;
    r.setHeader("set-cookie", ["a=1", "b=2"]);
    r.end("teapot");
  });
  const res = await safeFetchAdminConfigured(`http://127.0.0.1:${port}/`);
  assert.equal(res.status, 418);
  assert.equal(res.headers.getSetCookie().length, 2);
  assert.equal(await res.text(), "teapot");
  const none = await safeFetchAdminConfigured(`http://127.0.0.1:${port}/204`);
  assert.equal(none.status, 204);
  assert.equal(await none.text(), "");
  const head = await safeFetchAdminConfigured(`http://127.0.0.1:${port}/`, { method: "HEAD" });
  assert.equal(head.status, 418);
});

test("connection refused maps to a network SafeFetchError", async () => {
  const { port } = await listen(ok);
  servers.pop()!.close();
  await new Promise((r) => setTimeout(r, 20));
  const err = await rejection(safeFetchAdminConfigured(`http://127.0.0.1:${port}/`));
  assert.equal(err.reason, "network");
});

test("env-proxy mode cannot be pinned and falls back to fetch() (documented exception)", async () => {
  process.env.NODE_USE_ENV_PROXY = "1";
  process.env.HTTP_PROXY = "http://proxy.invalid:3128";
  stubDns(() => ["127.0.0.1"]);
  const realFetch = globalThis.fetch;
  let called = "";
  globalThis.fetch = (async (u: string) => { called = u; return new Response("via fetch"); }) as typeof fetch;
  try {
    const res = await safeFetchAdminConfigured("http://proxied.test:9/x");
    assert.equal(await res.text(), "via fetch");
    assert.equal(called, "http://proxied.test:9/x");
  } finally {
    globalThis.fetch = realFetch;
  }
});
