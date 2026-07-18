// Unit tests for the debounced library-scan scheduler (src/lib/library-scan.ts)
// — the path between a Radarr/Sonarr import webhook and the Plex/Jellyfin
// "rescan your library" calls. The contracts pinned here:
//   - DEBOUNCE + COALESCE: a scan waits SCAN_DEBOUNCE_MS (15s); schedules
//     arriving inside the window reset the timer and return the SAME promise
//     (one scan per burst). Past SCAN_MAX_WAIT_MS (2min) the timer is left
//     alone so a sustained webhook burst can't postpone the scan forever.
//   - QUEUE GATING: with a tmdbId hint the scan defers while THAT title is
//     still in the arr queue (tv resolves tmdb→tvdb via /series/lookup first);
//     two different titles coalescing widens to a full-queue count with no
//     per-title lookup. An unreadable queue (unconfigured arr on the count
//     path returns null) reads as "still pending" — defer, don't scan blind —
//     and after MAX_QUEUE_WAIT_RETRIES (4) the scan fires anyway so a stalled
//     queue can't block library updates indefinitely.
//   - VARIANT ROUTING: the ArrVariant slug picks the instance whose queue is
//     gated on ("4k" → the radarr4k* Setting keys), so a 4K-only grab isn't
//     rescanned early because the DEFAULT queue looks idle.
//   - BACKEND FAN-OUT: only configured backends fire; a movie scan refreshes
//     only Plex movie-type sections (tv → show), Jellyfin gets one
//     POST /Library/Refresh; per-service failures are logged with the
//     [library-scan] scope and never reject the scheduler promise; no backends
//     at all is a warn + no-op.
//   - IN-FLIGHT REUSE: a schedule arriving while a scan is running awaits the
//     running scan instead of arming a second one against the same backend.
//
// No DB or network: prisma.setting is shadowed in-memory (the arr/plex/jellyfin
// config reads), globalThis.fetch is scripted per URL, and dns/promises.lookup
// is stubbed for the safe-fetch SSRF resolver. Timers AND Date are mocked per
// test (t.mock.timers — the internal-trigger/webhook-replay pattern) so the 15s
// debounce, the 2min deadline, and arr.ts's 15s queue-state cache expiry all
// advance deterministically. Each test starts at a fresh epoch one day later
// and uses unique backend hostnames so the module-global caches in arr.ts
// (queueCache) and ssrf.ts (dnsCache) can never serve a previous test's data.
// Every test drives its scheduled scan to completion — library-scan's
// module-global pending/inFlight maps must be empty when a test ends or the
// next test would coalesce into a dead entry.
import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";

process.env.NEXTAUTH_SECRET ??= "unit-test-session-secret-0123456789abcdef";
process.env.TOKEN_ENCRYPTION_KEY ??= "ab".repeat(32); // prisma.ts pulls in token-crypto
process.env.DATABASE_URL ??= "postgresql://unit:unit@127.0.0.1:9/never_connects";

// ── DNS stub (safe-fetch resolves every backend host before fetching) ──────
const fakeLookup = async () => [{ address: "93.184.216.34", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) {
  throw new Error("could not stub dns.lookup — aborting before a real DNS query can leave the process");
}

// ── console capture ─────────────────────────────────────────────────────────
const warns: string[] = [];
const errors: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

// ── scripted fetch ──────────────────────────────────────────────────────────
type SentRequest = { url: string; method: string; headers: Headers };
const sent: SentRequest[] = [];
let respond: (url: string) => Response | Promise<Response> = (url) => {
  throw new Error(`unexpected fetch ${url} — script a responder for this test`);
};

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  sent.push({ url, method: init?.method ?? "GET", headers: new Headers(init?.headers) });
  return respond(url);
}) as typeof fetch;

const okJson = (data: unknown) =>
  new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });

// Dynamic imports so the stubs above genuinely precede the module-graph load.
const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel } = await import("./_helpers.mts");
const { scheduleLibraryScan } = await import("../src/lib/library-scan.ts");

// ── prisma stub: one Setting map behind plex/jellyfin/arr config reads ─────
const settings = new Map<string, string>();
shadowPrismaModel(prisma, "setting", {
  findMany: async (args: { where?: { key?: { in?: string[] } } }) => {
    const keys = args.where?.key?.in ?? [...settings.keys()];
    return keys.filter((k) => settings.has(k)).map((k) => ({ key: k, value: settings.get(k)! }));
  },
  findUnique: async (args: { where: { key: string } }) => {
    const v = settings.get(args.where.key);
    return v === undefined ? null : { key: args.where.key, value: v };
  },
});

const DEBOUNCE = 15_000; // SCAN_DEBOUNCE_MS
const DAY = 24 * 60 * 60 * 1000;
let epoch = Date.parse("2026-01-01T00:00:00Z");

// Per-test setup: fresh mocked clock (setTimeout + Date) at a new epoch, clean
// captures, empty config. NOT a beforeEach — mock.timers needs the TestContext.
function arm(t: TestContext): void {
  epoch += DAY;
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: epoch });
  settings.clear();
  sent.length = 0;
  warns.length = 0;
  errors.length = 0;
  respond = (url) => {
    throw new Error(`unexpected fetch ${url} — script a responder for this test`);
  };
}

// Drain the microtask cascade behind a mocked-timer fire. setImmediate is real
// (not in the mocked apis list), so one round runs every pending microtask
// first; three rounds cover the longest stubbed await chains comfortably.
async function flush(): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise<void>((r) => setImmediate(r));
}

const refreshCalls = (needle: string) => sent.filter((s) => s.url.includes(needle));

test("debounce holds the full 15s, then one scan refreshes only matching Plex sections plus Jellyfin", async (t) => {
  arm(t);
  // Radarr deliberately UNCONFIGURED: with a tmdbId hint the downloading check
  // returns false for an unconfigured instance, so the scan gate opens
  // immediately with zero arr fetches — the fixture most tests reuse.
  settings.set("plexServerUrl", "http://plex.t1.example:32400");
  settings.set("plexAdminToken", "plex-token-1");
  settings.set("jellyfinUrl", "http://jf.t1.example:8096");
  settings.set("jellyfinApiKey", "jf-key-1");
  respond = (url) => {
    if (url.endsWith("/library/sections")) {
      return okJson({
        MediaContainer: {
          Directory: [
            { key: "1", title: "Movies", type: "movie" },
            { key: "2", title: "Shows", type: "show" },
            { key: "3", title: "Music", type: "artist" },
          ],
        },
      });
    }
    if (url.includes("/library/sections/1/refresh")) return new Response("", { status: 200 });
    if (url.endsWith("/Library/Refresh")) return new Response(null, { status: 204 });
    throw new Error(`unexpected fetch ${url}`);
  };

  const p = scheduleLibraryScan("movie", 550);
  await flush();
  assert.equal(sent.length, 0, "nothing fires inside the debounce window");
  t.mock.timers.tick(DEBOUNCE - 1);
  await flush();
  assert.equal(sent.length, 0, "one ms short of the debounce still holds");

  t.mock.timers.tick(1);
  await p;

  const sections = sent.find((s) => s.url.endsWith("/library/sections"));
  assert.ok(sections, "Plex sections are listed first");
  assert.equal(sections.headers.get("x-plex-token"), "plex-token-1");
  assert.equal(refreshCalls("/library/sections/1/refresh").length, 1, "the movie section is refreshed");
  assert.equal(refreshCalls("/library/sections/2/refresh").length, 0, "a movie scan must not touch show sections");
  assert.equal(refreshCalls("/library/sections/3/refresh").length, 0, "non-video sections are never refreshed");

  const jf = sent.find((s) => s.url === "http://jf.t1.example:8096/Library/Refresh");
  assert.ok(jf, "Jellyfin gets its refresh");
  assert.equal(jf.method, "POST");
  assert.equal(jf.headers.get("x-mediabrowser-token"), "jf-key-1");
  assert.equal(errors.length, 0);
});

test("schedules inside the window coalesce onto the same promise and reset the timer", async (t) => {
  arm(t);
  settings.set("jellyfinUrl", "http://jf.t2.example:8096");
  settings.set("jellyfinApiKey", "jf-key-2");
  respond = () => new Response(null, { status: 204 });

  const p1 = scheduleLibraryScan("movie", 5);
  t.mock.timers.tick(8_000);
  const p2 = scheduleLibraryScan("movie", 5);
  assert.equal(p2, p1, "a coalesced schedule returns the SAME pending promise");

  // The original deadline (t=15s) passes without firing — the reset moved it.
  t.mock.timers.tick(DEBOUNCE - 1); // t = 22.999s < 8s + 15s
  await flush();
  assert.equal(sent.length, 0, "the second schedule reset the debounce");

  t.mock.timers.tick(1); // t = 23s — the moved deadline
  await p1;
  assert.equal(refreshCalls("/Library/Refresh").length, 1, "one scan for the whole burst");
});

test("a sustained burst cannot postpone the scan past the 2min max-wait deadline", async (t) => {
  arm(t);
  settings.set("jellyfinUrl", "http://jf.t3.example:8096");
  settings.set("jellyfinApiKey", "jf-key-3");
  respond = () => new Response(null, { status: 204 });

  // Webhooks every 10s (< the 15s debounce) — each reset alone would delay the
  // scan forever. Inside the 2min window they DO reset; the t=120s schedule
  // falls outside it and must leave the t=110s timer (due t=125s) armed.
  const p = scheduleLibraryScan("movie", 5); // t = 0
  for (let i = 0; i < 12; i++) {
    t.mock.timers.tick(10_000); // t = 10s … 120s
    assert.equal(scheduleLibraryScan("movie", 5), p);
    await flush();
    assert.equal(sent.length, 0, "still burst-holding");
  }
  t.mock.timers.tick(5_000); // t = 125s — the surviving timer fires
  await p;
  assert.equal(refreshCalls("/Library/Refresh").length, 1, "the burst could not starve the scan");
});

test("tv tmdbId gating: series lookup + queue defer while downloading, scan once the queue drains", async (t) => {
  arm(t);
  settings.set("sonarrUrl", "http://sonarr.t4.example:8989");
  settings.set("sonarrApiKey", "sonarr-key-4");
  settings.set("jellyfinUrl", "http://jf.t4.example:8096");
  settings.set("jellyfinApiKey", "jf-key-4");
  let queueBusy = true;
  respond = (url) => {
    if (url.includes("/api/v3/series/lookup")) return okJson([{ tvdbId: 121361 }]);
    if (url.includes("/api/v3/queue")) {
      return okJson(
        queueBusy
          ? { records: [{ series: { tvdbId: 121361 } }], totalRecords: 1 }
          : { records: [], totalRecords: 0 },
      );
    }
    if (url.endsWith("/Library/Refresh")) return new Response(null, { status: 204 });
    throw new Error(`unexpected fetch ${url}`);
  };

  const p = scheduleLibraryScan("tv", 1399);
  t.mock.timers.tick(DEBOUNCE);
  await flush();

  // The per-title gate resolves tmdb→tvdb through Sonarr, then checks the queue.
  const lookup = sent.find((s) => s.url.includes("/series/lookup"));
  assert.ok(lookup, "tmdbId hint triggers the per-title Sonarr lookup");
  assert.equal(lookup.url, "http://sonarr.t4.example:8989/api/v3/series/lookup?term=tmdb:1399");
  assert.equal(lookup.headers.get("x-api-key"), "sonarr-key-4");
  const queue = sent.find((s) => s.url.includes("/api/v3/queue"));
  assert.ok(queue?.url.includes("includeSeries=true"), "the Sonarr queue is read with series expansion");
  assert.equal(refreshCalls("/Library/Refresh").length, 0, "no rescan while the download is in flight");
  assert.equal(warns.length, 1);
  assert.match(warns[0], /\[library-scan\] tv arr still pending \(tmdbId=1399\), retry 1\/4 in 15000ms/);

  // The download imports; the next retry re-reads the queue (the 15s arr queue
  // cache has expired exactly at the retry boundary) and the scan proceeds.
  queueBusy = false;
  t.mock.timers.tick(DEBOUNCE);
  await p;
  assert.equal(refreshCalls("/Library/Refresh").length, 1, "the drained queue releases the scan");
  assert.equal(warns.length, 1, "no further retry warns after the queue drained");
});

test("two different titles coalescing widens to a full-queue count (no per-title lookup); tv refreshes show sections", async (t) => {
  arm(t);
  settings.set("sonarrUrl", "http://sonarr.t5.example:8989");
  settings.set("sonarrApiKey", "sonarr-key-5");
  settings.set("plexServerUrl", "http://plex.t5.example:32400");
  settings.set("plexAdminToken", "plex-token-5");
  respond = (url) => {
    if (url.includes("/api/v3/queue")) return okJson({ records: [], totalRecords: 0 });
    if (url.endsWith("/library/sections")) {
      return okJson({
        MediaContainer: {
          Directory: [
            { key: "8", title: "Movies", type: "movie" },
            { key: "9", title: "Shows", type: "show" },
          ],
        },
      });
    }
    if (url.includes("/library/sections/9/refresh")) return new Response("", { status: 200 });
    throw new Error(`unexpected fetch ${url}`);
  };

  const p1 = scheduleLibraryScan("tv", 100);
  const p2 = scheduleLibraryScan("tv", 200); // conflicting hint → full-queue check
  assert.equal(p2, p1);
  t.mock.timers.tick(DEBOUNCE);
  await p1;

  assert.equal(sent.filter((s) => s.url.includes("/series/lookup")).length, 0,
    "conflicting tmdbIds must fall back to the total-queue count, not chase one title");
  assert.equal(sent.filter((s) => s.url.includes("/api/v3/queue")).length, 1);
  assert.equal(refreshCalls("/library/sections/9/refresh").length, 1, "tv scans refresh show sections");
  assert.equal(refreshCalls("/library/sections/8/refresh").length, 0, "…and never movie sections");
});

test("variant routing: a '4k' hint gates on the radarr4k instance's queue, not the default's", async (t) => {
  arm(t);
  // ONLY the 4K instance is configured — if the scheduler consulted the default
  // instance the gate would open with zero arr fetches; the assertion below
  // proves the 4K queue was actually read.
  settings.set("radarr4kUrl", "http://radarr4k.t6.example:7878");
  settings.set("radarr4kApiKey", "r4k-key-6");
  settings.set("jellyfinUrl", "http://jf.t6.example:8096");
  settings.set("jellyfinApiKey", "jf-key-6");
  respond = (url) => {
    if (url.includes("/api/v3/queue")) return okJson({ records: [], totalRecords: 0 });
    if (url.endsWith("/Library/Refresh")) return new Response(null, { status: 204 });
    throw new Error(`unexpected fetch ${url}`);
  };

  const p = scheduleLibraryScan("movie", 550, "4k");
  t.mock.timers.tick(DEBOUNCE);
  await p;

  const queue = sent.find((s) => s.url.includes("/api/v3/queue"));
  assert.ok(queue, "the 4K queue was consulted");
  assert.ok(queue.url.startsWith("http://radarr4k.t6.example:7878/api/v3/queue"),
    "the variant slug resolves the radarr4k* Setting keys");
  assert.ok(queue.url.includes("includeMovie=true"));
  assert.equal(queue.headers.get("x-api-key"), "r4k-key-6");
  assert.equal(refreshCalls("/Library/Refresh").length, 1);
});

test("per-service failure isolation: a Plex 500 is logged while Jellyfin still refreshes, and the promise resolves", async (t) => {
  arm(t);
  settings.set("plexServerUrl", "http://plex.t7.example:32400");
  settings.set("plexAdminToken", "plex-token-7");
  settings.set("jellyfinUrl", "http://jf.t7.example:8096");
  settings.set("jellyfinApiKey", "jf-key-7");
  respond = (url) => {
    if (url.endsWith("/library/sections")) return new Response("boom", { status: 500 });
    if (url.endsWith("/Library/Refresh")) return new Response(null, { status: 204 });
    throw new Error(`unexpected fetch ${url}`);
  };

  const p = scheduleLibraryScan("movie", 7);
  t.mock.timers.tick(DEBOUNCE);
  await p; // must resolve despite the Plex failure

  assert.ok(errors.some((e) => e.includes("[library-scan] plex movie:") && e.includes("500")),
    "the Plex failure is logged with its scope");
  assert.equal(refreshCalls("/Library/Refresh").length, 1, "Jellyfin is unaffected by the Plex failure");
});

test("unreadable queue (unconfigured arr, no tmdbId) defers 4 retries then scans anyway; no backends is a warn + no-op", async (t) => {
  arm(t);
  // Nothing configured at all. countRadarrQueue returns null (unknown), which
  // must read as "still pending" — scanning blind against an unknown queue is
  // the bug the tri-state exists to prevent.
  const p = scheduleLibraryScan("movie");
  for (let attempt = 1; attempt <= 5; attempt++) {
    t.mock.timers.tick(DEBOUNCE);
    await flush();
  }
  await p;

  assert.equal(sent.length, 0, "no arr, plex, or jellyfin traffic at any point");
  const retryWarns = warns.filter((w) => /arr still pending \(total queue\), retry \d\/4/.test(w));
  assert.equal(retryWarns.length, 4, "each deferred attempt warns with its retry count");
  assert.ok(warns.some((w) => w.includes("after 4 retries, scanning anyway")),
    "a permanently unreadable queue cannot block the scan forever");
  assert.ok(warns.some((w) => w.includes("[library-scan] movie: no backends configured, skipping")),
    "the scan itself degrades to a warn when nothing is configured");
});

test("a schedule arriving mid-scan awaits the running scan instead of arming a second one", async (t) => {
  arm(t);
  settings.set("jellyfinUrl", "http://jf.t9.example:8096");
  settings.set("jellyfinApiKey", "jf-key-9");
  let releaseRefresh!: (r: Response) => void;
  const held = new Promise<Response>((resolve) => { releaseRefresh = resolve; });
  respond = (url) => {
    if (url.endsWith("/Library/Refresh")) return held; // hold the scan open
    throw new Error(`unexpected fetch ${url}`);
  };

  const p1 = scheduleLibraryScan("movie", 42);
  t.mock.timers.tick(DEBOUNCE);
  await flush();
  assert.equal(refreshCalls("/Library/Refresh").length, 1, "the scan is in flight");

  // Mid-scan schedule: must ride the in-flight scan, not create a new pending entry.
  const p2 = scheduleLibraryScan("movie", 42);
  await flush();
  assert.equal(sent.length, 1, "no new work was started for the mid-scan schedule");

  releaseRefresh(new Response(null, { status: 204 }));
  await p1;
  await p2; // the returned in-flight promise resolves with the scan

  // If the mid-scan schedule HAD armed a fresh debounce, a second refresh would
  // fire on the next ticks — prove it doesn't.
  t.mock.timers.tick(DEBOUNCE);
  await flush();
  t.mock.timers.tick(DEBOUNCE);
  await flush();
  assert.equal(refreshCalls("/Library/Refresh").length, 1, "exactly one scan for the whole episode");
});
