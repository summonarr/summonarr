// The Radarr webhook's cache bookkeeping on MovieFileDelete and Download
// (src/app/api/webhooks/radarr/route.ts).
//
// Why: an issue's Replace file deletes a movie's file through Radarr, whose
// MovieFileDelete used to drop the RadarrAvailableItem row and record
// nothing — although Radarr still holds the movie, without a file, which is
// exactly the sync's "wanted". With neither row the synced cache said the
// instance didn't hold the movie: "Add to Radarr" was offered for the
// instance that held it and the Issues row lost its Manage icon until the
// next sync. The replacement's Download then deleted the wanted row and again
// recorded nothing.
//
// Pinned: a non-upgrade MovieFileDelete leaves a WANTED row (no available
// row); an upgrade deletion touches neither table; MovieDelete leaves neither;
// a VERIFIED Download leaves an AVAILABLE row and no wanted row, and an
// unverifiable (null) one inserts no available row (a forged payload must
// never make re-requests read "already available").
//
// Harness: tests/webhook-routes.test.mts's request scope and in-memory
// delegates, cut down to what these events touch.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.TRUST_PROXY = "true";
(globalThis as { AsyncLocalStorage?: typeof AsyncLocalStorage }).AsyncLocalStorage = AsyncLocalStorage;

let fetchHandler: (url: string) => Response = () => { throw new Error("scripted network refusal"); };
globalThis.fetch = (async (input: unknown) => fetchHandler(String(input))) as typeof fetch;
console.warn = () => {};
console.error = () => {};
Math.random = () => 0.5;

const { NextRequest } = await import("next/server");
const { workAsyncStorage } = await import("../node_modules/next/dist/server/app-render/work-async-storage.external.js");
const { workUnitAsyncStorage } = await import("../node_modules/next/dist/server/app-render/work-unit-async-storage.external.js");
const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel, shadowPrismaClientMethod } = await import("./_helpers.mts");
const { arrSettingKey } = await import("../src/lib/arr-instances.ts");

const SECRET = "radarr-default-secret";
const settings = new Map<string, string>();
shadowPrismaModel(prisma, "setting", {
  findUnique: async (args: { where: { key: string } }) =>
    settings.has(args.where.key) ? { key: args.where.key, value: settings.get(args.where.key)! } : null,
  findMany: async (args: { where?: { key?: { in?: string[] } } } = {}) => {
    const keys = args.where?.key?.in;
    return [...settings].filter(([k]) => !keys || keys.includes(k)).map(([key, value]) => ({ key, value }));
  },
  deleteMany: async () => ({ count: 0 }),
});
const replay = new Set<string>();
shadowPrismaModel(prisma, "webhookReplay", {
  create: async (args: { data: { digest: string; expiresAt: Date } }) => { replay.add(args.data.digest); return args.data; },
  updateMany: async () => ({ count: 0 }),
  delete: async (args: { where: { digest: string } }) => { replay.delete(args.where.digest); return { digest: args.where.digest }; },
  deleteMany: async () => ({ count: 0 }),
});
shadowPrismaModel(prisma, "mediaRequest", {
  updateMany: async () => ({ count: 0 }),
  findMany: async () => [],
  findFirst: async () => null,
});
shadowPrismaModel(prisma, "issueGrab", { findMany: async () => [] });

// The two cache tables, keyed `${tmdbId}:${arrInstance}`.
type Key = { tmdbId: number; arrInstance: string };
function table() {
  const rows = new Set<string>();
  const k = (r: Key) => `${r.tmdbId}:${r.arrInstance}`;
  return {
    rows,
    delegate: {
      deleteMany: async (args: { where: Key }) => ({ count: rows.delete(k(args.where)) ? 1 : 0 }),
      createMany: async (args: { data: Key[]; skipDuplicates?: boolean }) => {
        let count = 0;
        for (const r of args.data) {
          if (rows.has(k(r))) {
            if (!args.skipDuplicates) throw new Error("unique violation (P2002) — would abort the tx (guardrail 23)");
            continue;
          }
          rows.add(k(r));
          count++;
        }
        return { count };
      },
    },
  };
}
const wanted = table();
const available = table();
const txDelegates = {
  $executeRaw: async () => 0,
  mediaRequest: { updateMany: async () => ({ count: 0 }) },
  radarrWantedItem: wanted.delegate,
  radarrAvailableItem: available.delegate,
};
shadowPrismaClientMethod(prisma, "$transaction", async (arg: unknown) =>
  typeof arg === "function" ? (arg as (tx: typeof txDelegates) => Promise<unknown>)(txDelegates) : Promise.all(arg as Promise<unknown>[]),
);

const { POST } = await import("../src/app/api/webhooks/radarr/route.ts");

let ip = 0;
async function deliver(body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const req = new NextRequest(`http://localhost:3000/api/webhooks/radarr?token=${SECRET}`, {
    method: "POST",
    headers: { "x-forwarded-for": `203.0.113.${(ip++ % 200) + 1}` },
    body: JSON.stringify(body),
  });
  const workStore = { afterContext: { after: () => {} } };
  const requestStore = { type: "request", phase: "render", usedDynamic: false };
  const res = await workAsyncStorage.run(workStore as never, () =>
    workUnitAsyncStorage.run(requestStore as never, () => (POST as unknown as (r: unknown) => Promise<Response>)(req)),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
const has = (t: ReturnType<typeof table>, tmdbId: number, inst = "") => t.rows.has(`${tmdbId}:${inst}`);
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

beforeEach(() => {
  settings.clear();
  settings.set(arrSettingKey("radarr", "", "WebhookSecret"), SECRET);
  settings.set(arrSettingKey("radarr", "", "Url"), "http://127.0.0.1:7878");
  settings.set(arrSettingKey("radarr", "", "ApiKey"), "radarr-key");
  replay.clear();
  wanted.rows.clear();
  available.rows.clear();
  fetchHandler = () => { throw new Error("scripted network refusal"); };
});

test("a manual MovieFileDelete moves the movie to WANTED — Radarr still holds it, without a file", async () => {
  available.rows.add("603:");
  const res = await deliver({ eventType: "MovieFileDelete", deleteReason: "manual", movie: { tmdbId: 603, title: "The Matrix" } });
  assert.equal(res.status, 200);
  assert.equal(has(available, 603), false);
  assert.equal(has(wanted, 603), true, "the instance still holds the movie — 'Manage in', not 'Add to'");
  // Delivered again (or a row already there): skipDuplicates, never an aborted tx.
  replay.clear();
  assert.equal((await deliver({ eventType: "MovieFileDelete", deleteReason: "missingFromDisk", movie: { tmdbId: 603, title: "The Matrix" } })).status, 200);
  assert.equal(has(wanted, 603), true);
});

test("an UPGRADE deletion touches neither table; MovieDelete leaves neither row", async () => {
  available.rows.add("603:");
  await deliver({ eventType: "MovieFileDelete", deleteReason: "upgrade", movie: { tmdbId: 603, title: "The Matrix" } });
  assert.deepEqual([has(available, 603), has(wanted, 603)], [true, false]);
  wanted.rows.add("604:");
  available.rows.add("604:");
  await deliver({ eventType: "MovieDelete", movie: { tmdbId: 604, title: "Gone" } });
  assert.deepEqual([has(available, 604), has(wanted, 604)], [false, false], "a removed movie is wanted nowhere");
});

test("a VERIFIED Download moves the movie to AVAILABLE; an unverifiable one inserts no available row", async () => {
  wanted.rows.add("603:");
  fetchHandler = (url) => (new URL(url).pathname === "/api/v3/movie" ? json([{ tmdbId: 603, hasFile: true }]) : json({ records: [], totalRecords: 0 }));
  assert.equal((await deliver({ eventType: "Download", movie: { tmdbId: 603, title: "The Matrix" } })).status, 200);
  assert.deepEqual([has(wanted, 603), has(available, 603)], [false, true]);

  // Radarr unreachable (verdict null): the flip proceeds as before, but nothing claims availability.
  wanted.rows.add("605:");
  fetchHandler = () => { throw new Error("down"); };
  assert.equal((await deliver({ eventType: "Download", movie: { tmdbId: 605, title: "Maybe" } })).status, 200);
  assert.deepEqual([has(wanted, 605), has(available, 605)], [false, false]);
});
