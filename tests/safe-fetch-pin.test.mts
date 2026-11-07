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
import { EventEmitter } from "node:events";
import http from "node:http";
import zlib from "node:zlib";
import net from "node:net";
import type { AddressInfo } from "node:net";
import {
  safeFetch,
  safeFetchTrusted,
  safeFetchAdminConfigured,
  SafeFetchError,
  makePinnedLookup,
  buildPinnedRequestOptions,
  PINNED_CONNECT_TIMEOUT_MS,
  PINNED_IDLE_TIMEOUT_MS,
  MAX_CONTENT_ENCODINGS,
  createDeflateDecoder,
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

// A resolver that never answers — getaddrinfo with an unreachable nameserver.
function hangDns(): void {
  (dns as { lookup: unknown }).lookup = () => new Promise(() => { /* never settles */ });
}

test("DNS phase: a caller abort is the caller's, not a timeout — network, with the caller's reason", async () => {
  hangDns();
  const ac = new AbortController();
  const p = safeFetch("http://dns-hang-caller.test/", { signal: ac.signal, timeoutMs: 5000 });
  setTimeout(() => ac.abort(new Error("caller gave up")), 30);
  const err = await settlesWithin(rejection(p), 2000);
  assert.equal(err.reason, "network");
  assert.match(err.message, /caller gave up/);
  assert.doesNotMatch(err.message, /timed out|budget/);

  // A caller signal already aborted before DNS starts is the same.
  const done = new AbortController();
  done.abort(new Error("cancelled early"));
  const early = await rejection(safeFetch("http://dns-hang-early.test/", { signal: done.signal }));
  assert.equal(early.reason, "network");
  assert.match(early.message, /cancelled early/);
});

test("DNS phase: our own budget running out is still reason timeout", async () => {
  hangDns();
  const ac = new AbortController();
  const err = await settlesWithin(rejection(safeFetch("http://dns-hang-budget.test/", { signal: ac.signal, timeoutMs: 60 })), 2000);
  assert.equal(err.reason, "timeout");
  assert.match(err.message, /exceeded the 60ms budget/);
  // The caller's OWN deadline (a TimeoutError reason) reads as a timeout, as it does mid-request.
  const own = await settlesWithin(rejection(safeFetch("http://dns-hang-own.test/", { signal: AbortSignal.timeout(40), timeoutMs: 5000 })), 2000);
  assert.equal(own.reason, "timeout");
});

test("caller AbortSignal cancels the request", async () => {
  const { port } = await listen(() => { /* never respond */ });
  const ac = new AbortController();
  const p = safeFetchAdminConfigured(`http://127.0.0.1:${port}/`, { signal: ac.signal, timeoutMs: 5000 });
  setTimeout(() => ac.abort(), 50);
  await rejection(p);
});

// ---------------------------------------------------------------------------
// fetch parity: the pinned transport keeps undici's connect and idle timeouts
// and its lenient decoding, so moving off fetch() changed no failure mode.
// ---------------------------------------------------------------------------

test("defaults are fetch's: 10s connect, 300s idle, at most 5 content-codings", () => {
  assert.equal(PINNED_CONNECT_TIMEOUT_MS, 10_000);
  assert.equal(PINNED_IDLE_TIMEOUT_MS, 300_000);
  assert.equal(MAX_CONTENT_ENCODINGS, 5);
});

test("connect timeout: a TLS handshake that never completes fails as network after connectTimeoutMs, not the whole budget", async () => {
  // Accepts the TCP connection and never answers the ClientHello.
  const sockets: net.Socket[] = [];
  const silent = net.createServer((s) => { sockets.push(s); });
  await new Promise<void>((r) => silent.listen(0, "127.0.0.1", r));
  try {
    const port = (silent.address() as AddressInfo).port;
    const t0 = Date.now();
    const err = await rejection(safeFetchAdminConfigured(`https://127.0.0.1:${port}/`, { connectTimeoutMs: 200, timeoutMs: 5000 }));
    assert.equal(err.reason, "network");
    assert.match(err.message, /Connect Timeout Error/);
    assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0}ms`);
  } finally {
    for (const s of sockets) s.destroy();
    silent.close();
  }
});

test("connect timeout stops once connected: a slow answer is not cut by it", async () => {
  const { port } = await listen((_q, r) => { setTimeout(() => r.end("late"), 600); });
  const res = await safeFetchAdminConfigured(`http://127.0.0.1:${port}/`, { connectTimeoutMs: 200, timeoutMs: 5000 });
  assert.equal(await res.text(), "late");
});

test("idle timeout: no response headers within idleTimeoutMs fails as network (Headers Timeout)", async () => {
  const { port } = await listen(() => { /* never respond */ });
  const t0 = Date.now();
  const err = await rejection(safeFetchAdminConfigured(`http://127.0.0.1:${port}/`, { idleTimeoutMs: 200, timeoutMs: 5000 }));
  assert.equal(err.reason, "network");
  assert.match(err.message, /Headers Timeout Error/);
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0}ms`);
});

test("idle timeout: a body that goes silent errors on read (Body Timeout) long before the total budget", async () => {
  const { port } = await listen((_q, r) => { r.write("partial"); /* then silence, connection held open */ });
  const t0 = Date.now();
  const res = await safeFetchAdminConfigured(`http://127.0.0.1:${port}/`, { idleTimeoutMs: 200, timeoutMs: 5000 });
  await assert.rejects(res.text(), (e: unknown) =>
    e instanceof SafeFetchError && e.reason === "network" && /Body Timeout Error/.test(e.message));
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0}ms`);
});

test("idle timeout counts silence, not total time: a slow but steady body completes", async () => {
  const { port } = await listen((_q, r) => {
    let n = 0;
    const tick = setInterval(() => {
      r.write(`c${n}`);
      if (++n === 8) { clearInterval(tick); r.end(); }
    }, 80);
  });
  const res = await safeFetchAdminConfigured(`http://127.0.0.1:${port}/`, { idleTimeoutMs: 250, timeoutMs: 5000 });
  assert.equal(await res.text(), "c0c1c2c3c4c5c6c7");
});

const JSON_BODY = JSON.stringify({ ok: true, items: Array.from({ length: 50 }, (_, i) => ({ i, name: "n".repeat(20) })) });

test("decoding is as lenient as fetch: a missing gzip trailer and raw DEFLATE under 'deflate' still decode", async () => {
  const { port } = await listen((req, r) => {
    const src = Buffer.from(JSON_BODY);
    if (req.url === "/truncated-gzip") {
      const gz = zlib.gzipSync(src);
      r.setHeader("content-encoding", "gzip");
      r.end(gz.subarray(0, gz.length - 8)); // CRC32 + ISIZE trailer dropped
    } else if (req.url === "/raw-deflate") {
      r.setHeader("content-encoding", "deflate");
      r.end(zlib.deflateRawSync(src));
    } else {
      r.setHeader("content-encoding", "deflate");
      r.end(zlib.deflateSync(src));
    }
  });
  for (const p of ["/truncated-gzip", "/raw-deflate", "/zlib-deflate"]) {
    const res = await safeFetchAdminConfigured(`http://127.0.0.1:${port}${p}`);
    assert.equal(await res.text(), JSON_BODY, p);
  }
});

test("a short brotli tail yields what decoded instead of erroring, as fetch does", async () => {
  const { port } = await listen((_q, r) => {
    const br = zlib.brotliCompressSync(Buffer.from(JSON_BODY));
    r.setHeader("content-encoding", "br");
    r.end(br.subarray(0, br.length - 3));
  });
  const res = await safeFetchAdminConfigured(`http://127.0.0.1:${port}/`);
  const text = await res.text();
  assert.ok(JSON_BODY.startsWith(text), "decoded prefix of the original");
});

test("the deflate decoder honours backpressure: an unread decoder does not inflate a whole high-ratio chunk", async () => {
  // 32 MiB of zeros deflates to ~32 KB — one socket chunk. Its 'data' listener
  // used to keep the inflater flowing, so the whole 32 MiB landed in the
  // decoder's buffer before the byte cap downstream could see any of it.
  const plain = 32 * 1024 * 1024;
  for (const compress of [zlib.deflateSync, zlib.deflateRawSync]) {
    const d = createDeflateDecoder();
    d.write(compress(Buffer.alloc(plain)));
    await new Promise((r) => setTimeout(r, 300)); // nobody reads
    const bound = 4 * Math.max(d.readableHighWaterMark, 64 * 1024);
    assert.ok(d.readableLength <= bound, `${compress.name}: ${d.readableLength} bytes buffered unread (bound ${bound})`);
    // Read, and the whole body still decodes.
    d.end();
    let total = 0;
    for await (const c of d) total += (c as Buffer).length;
    assert.equal(total, plain, compress.name);
  }
});

test("a deflate bomb served in one write is cut at maxResponseBytes", async () => {
  const bomb = zlib.deflateSync(Buffer.alloc(16 * 1024 * 1024));
  const { port } = await listen((_q, r) => { r.setHeader("content-encoding", "deflate"); r.end(bomb); });
  const res = await safeFetchAdminConfigured(`http://127.0.0.1:${port}/`, { maxResponseBytes: 64 * 1024 });
  await assert.rejects(res.arrayBuffer(), (e: unknown) => e instanceof SafeFetchError && e.reason === "size");
});

test("five stacked content-codings decode; a sixth is refused, as fetch refuses it", async () => {
  const { port } = await listen((req, r) => {
    const n = Number(req.url!.slice(1));
    let b = Buffer.from(JSON_BODY);
    for (let i = 0; i < n; i++) b = zlib.gzipSync(b);
    r.setHeader("content-encoding", Array(n).fill("gzip").join(", "));
    r.end(b);
  });
  assert.equal(await (await safeFetchAdminConfigured(`http://127.0.0.1:${port}/5`)).text(), JSON_BODY);
  const err = await rejection(safeFetchAdminConfigured(`http://127.0.0.1:${port}/6`));
  assert.equal(err.reason, "network");
  assert.match(err.message, /too many content-encodings in response: 6, maximum allowed is 5/);
});

test("an unknown coding in the chain passes the body through raw, as fetch does", async () => {
  const gz = zlib.gzipSync(Buffer.from(JSON_BODY));
  const { port } = await listen((_q, r) => {
    r.setHeader("content-encoding", "gzip, x-unknown");
    r.end(gz);
  });
  const res = await safeFetchAdminConfigured(`http://127.0.0.1:${port}/`);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), gz);
});

test("a decode failure keeps its reason in the error message", async () => {
  const { port } = await listen((_q, r) => {
    const gz = zlib.gzipSync(Buffer.from(JSON_BODY));
    gz[20] ^= 0xff; gz[21] ^= 0xff; gz[22] ^= 0xff;
    r.setHeader("content-encoding", "gzip");
    r.end(gz);
  });
  const res = await safeFetchAdminConfigured(`http://127.0.0.1:${port}/`);
  // Readable.toWeb used to blank a coded (zlib) error, leaving "…failed for <url>: ".
  await assert.rejects(res.text(), (e: unknown) =>
    e instanceof SafeFetchError && e.reason === "network" && /^Response body read failed for \S+: \S.*$/.test(e.message));
});

test("redirects are refused, never followed — and reported as reason \"redirect\", not a retryable network failure", async () => {
  const { port, hits } = await listen((req, r) => {
    if (req.url === "/start") { r.statusCode = 302; r.setHeader("location", "/next"); r.end(); } else r.end("followed");
  });
  const err = await rejection(safeFetchAdminConfigured(`http://127.0.0.1:${port}/start`));
  assert.match(err.message, /unexpected redirect/);
  // A 3xx is deterministic: arr reads retry "network", notify agents re-queue it,
  // and arrWriteOutcomeUnknown treats it as a write that may have happened.
  assert.equal(err.reason, "redirect");
  assert.equal(hits.length, 1, "the redirect target must not be requested");
});

test("a redirect refused by fetch() itself (env-proxy path, redirect:\"error\") is reason \"redirect\" too", async () => {
  process.env.NODE_USE_ENV_PROXY = "1";
  process.env.HTTP_PROXY = "http://proxy.invalid:3128";
  stubDns(() => ["127.0.0.1"]);
  const realFetch = globalThis.fetch;
  // undici's shape for redirect:"error": TypeError("fetch failed") with the reason as its cause.
  globalThis.fetch = (async () => { throw new TypeError("fetch failed", { cause: new Error("unexpected redirect") }); }) as typeof fetch;
  try {
    const err = await rejection(safeFetchAdminConfigured("http://proxied-redirect.test:9/x"));
    assert.equal(err.reason, "redirect");
    // Any other fetch failure stays "network".
    globalThis.fetch = (async () => { throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED") }); }) as typeof fetch;
    assert.equal((await rejection(safeFetchAdminConfigured("http://proxied-refused.test:9/x"))).reason, "network");
  } finally {
    globalThis.fetch = realFetch;
  }
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

// ---------------------------------------------------------------------------
// The pinned request always settles. doFetch awaits it with nothing
// racing it, so any path that neither resolves nor rejects hung the caller
// forever, whatever timeoutMs said.
// ---------------------------------------------------------------------------

// Fails the test instead of hanging the runner when `p` never settles.
async function settlesWithin<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`still pending after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

// A raw TCP server that answers every request with `reply`, then closes the
// socket or keeps it open. `closed` resolves once every accepted socket closed.
async function rawServer(reply: string, keepOpen: boolean) {
  const sockets: net.Socket[] = [];
  const closed: Promise<void>[] = [];
  const server = net.createServer((sock) => {
    sockets.push(sock);
    closed.push(new Promise<void>((r) => { sock.once("close", () => r()); }));
    sock.on("error", () => { /* the client may reset it */ });
    sock.once("data", () => {
      const bytes = Buffer.from(reply, "latin1");
      if (keepOpen) sock.write(bytes);
      else sock.end(bytes);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: (server.address() as AddressInfo).port,
    allClosed: () => Promise.all(closed),
    close: () => { for (const s of sockets) s.destroy(); server.close(); },
  };
}

test("a reason phrase new Response() refuses rejects at once as network, and the connection is torn down", async () => {
  // 0x01 is accepted by Node's parser but makes the Response constructor throw,
  // which used to escape as an uncaughtException with the promise left pending.
  const cases: Array<{ name: string; method: string; keepOpen: boolean; length: number }> = [
    { name: "GET, peer closes", method: "GET", keepOpen: false, length: 2 },
    { name: "GET, peer keeps the socket open", method: "GET", keepOpen: true, length: 2 },
    // The body never completes, so only our own teardown closes the socket.
    { name: "GET, body still owed", method: "GET", keepOpen: true, length: 100 },
    { name: "HEAD, peer keeps the socket open", method: "HEAD", keepOpen: true, length: 2 },
  ];
  for (const c of cases) {
    const srv = await rawServer(`HTTP/1.1 200 O\x01K\r\nContent-Length: ${c.length}\r\n\r\nok`, c.keepOpen);
    try {
      const t0 = Date.now();
      const err = await settlesWithin(
        rejection(safeFetchAdminConfigured(`http://127.0.0.1:${srv.port}/`, { method: c.method, timeoutMs: 5000 })),
        2000,
      );
      assert.equal(err.reason, "network", c.name);
      assert.match(err.message, /Invalid statusText/, c.name);
      assert.ok(Date.now() - t0 < 2000, `${c.name}: took ${Date.now() - t0}ms`);
      await settlesWithin(srv.allClosed(), 2000);
    } finally {
      srv.close();
    }
  }
});

test("a 101 is refused at once as network, whether the peer closes or keeps the socket open", async () => {
  for (const keepOpen of [false, true]) {
    const srv = await rawServer("HTTP/1.1 101 Switching Protocols\r\nUpgrade: x\r\nConnection: Upgrade\r\n\r\n", keepOpen);
    try {
      const t0 = Date.now();
      const err = await settlesWithin(
        rejection(safeFetchAdminConfigured(`http://127.0.0.1:${srv.port}/`, { timeoutMs: 5000 })),
        2000,
      );
      assert.equal(err.reason, "network");
      assert.match(err.message, /unexpected upgrade \(status 101\)/);
      assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0}ms`);
      await settlesWithin(srv.allClosed(), 2000);
    } finally {
      srv.close();
    }
  }
});

test("a caller abort while waiting for headers settles at once with the caller's reason", async () => {
  let reached!: () => void;
  const atServer = new Promise<void>((r) => { reached = r; });
  const { port } = await listen(() => { reached(); /* never respond */ });
  const ac = new AbortController();
  const p = safeFetchAdminConfigured(`http://127.0.0.1:${port}/`, { signal: ac.signal, timeoutMs: 5000 });
  await atServer;
  const t0 = Date.now();
  ac.abort(new Error("caller gave up"));
  const err = await settlesWithin(rejection(p), 2000);
  assert.equal(err.reason, "network");
  assert.match(err.message, /caller gave up/);
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0}ms`);
});

// A ClientRequest stand-in that reports nothing, the way Node ends some paths
// (a 101 with no 'upgrade' listener) with neither 'response' nor 'error'.
class MuteRequest extends EventEmitter {
  destroyed = false;
  closeOnEnd = false;
  setTimeout(): this { return this; }
  end(): this {
    if (this.closeOnEnd) setImmediate(() => this.emit("close"));
    return this;
  }
  destroy(): this { this.destroyed = true; return this; }
}

async function withMuteTransport<T>(closeOnEnd: boolean, run: (reqs: MuteRequest[]) => Promise<T>): Promise<T> {
  const mod = http as unknown as { request: unknown };
  const real = mod.request;
  const reqs: MuteRequest[] = [];
  mod.request = () => {
    const r = new MuteRequest();
    r.closeOnEnd = closeOnEnd;
    reqs.push(r);
    return r;
  };
  try {
    return await run(reqs);
  } finally {
    mod.request = real;
  }
}

test("a request the transport never reports on is still bounded by timeoutMs", async () => {
  await withMuteTransport(false, async (reqs) => {
    const t0 = Date.now();
    const err = await settlesWithin(rejection(safeFetchAdminConfigured("http://127.0.0.1:9/", { timeoutMs: 200 })), 2000);
    assert.equal(err.reason, "timeout");
    assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0}ms`);
    assert.equal(reqs.length, 1);
    assert.ok(reqs[0].destroyed, "the request is destroyed on abort");
  });
});

test("a request the transport never reports on is still bounded by the caller's signal", async () => {
  await withMuteTransport(false, async (reqs) => {
    const ac = new AbortController();
    const p = safeFetchAdminConfigured("http://127.0.0.1:9/", { signal: ac.signal, timeoutMs: 5000 });
    setTimeout(() => ac.abort(new Error("caller gave up")), 50);
    const err = await settlesWithin(rejection(p), 2000);
    assert.match(err.message, /caller gave up/);
    assert.ok(reqs[0].destroyed);
  });
});

test("a request that closes with neither a response nor an error fails at once, not at the timeout", async () => {
  await withMuteTransport(true, async () => {
    const t0 = Date.now();
    const err = await settlesWithin(rejection(safeFetchAdminConfigured("http://127.0.0.1:9/", { timeoutMs: 5000 })), 2000);
    assert.equal(err.reason, "network");
    assert.match(err.message, /connection closed before a response/);
    assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0}ms`);
  });
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
