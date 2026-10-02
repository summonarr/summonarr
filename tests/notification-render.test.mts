// Read-time rendering of in-app notification rows (src/lib/notification-render.ts)
// and the notification catalog's own invariants.
//
// Pinned because:
//   - the iOS app reads title/body from GET /api/notifications, so the English
//     render of a row WITH data must be byte-identical to the English text the
//     writer stored (no-hint and native readers must see exactly what they saw
//     before the column existed);
//   - rows written before `data` existed (or with a shape this module doesn't
//     know) must fall back to the stored text, never to a blank or a raw key;
//   - the server-side notification modules never call useT()/getTranslator(), so
//     the generic i18n.test.mts key scan skips them — a typo'd `notify.*` key
//     would ship as a raw dotted id in someone's inbox. Scanned here instead.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const { renderNotification, requestBodyKey } = await import("../src/lib/notification-render.ts");
const { translatorFor } = await import("../src/lib/i18n/server-locale.ts");
const { buildNotificationData } = await import("../src/lib/notification-data.ts");

const en = translatorFor("en");
const es = translatorFor("es");

// The exact English copy each writer stores (request-notifications.ts
// inAppBodyFor, requests/batch, issues/[id] and issues/[id]/messages).
const WRITERS = [
  { type: "REQUEST_APPROVED", mediaType: "MOVIE" as const, body: "Your movie request was approved and is downloading.", data: { v: 1 } },
  { type: "REQUEST_APPROVED", mediaType: "TV" as const, body: "Your TV show request was approved and is downloading.", data: { v: 1 } },
  { type: "REQUEST_AVAILABLE", mediaType: "MOVIE" as const, body: "Your movie is now available to watch.", data: { v: 1 } },
  { type: "REQUEST_AVAILABLE", mediaType: "TV" as const, body: "Your TV show is now available to watch.", data: { v: 1 } },
  { type: "REQUEST_DECLINED", mediaType: "MOVIE" as const, body: "Your movie request was declined.", data: { v: 1 } },
  { type: "REQUEST_DECLINED", mediaType: "TV" as const, body: "Your TV show request was declined.", data: { v: 1 } },
  { type: "ISSUE_RESOLVED", mediaType: "MOVIE" as const, body: "Resolved: Replaced the file", data: { v: 1, resolution: "Replaced the file" } },
  { type: "ISSUE_RESOLVED", mediaType: null, body: "Your reported issue was resolved.", data: { v: 1, resolution: null } },
  { type: "ISSUE_REPLY", mediaType: "TV" as const, body: "Ana replied: Fixed {it} now", data: { v: 1, author: "Ana", text: "Fixed {it} now" } },
];

test("English render of every writer's row is byte-identical to the stored body", () => {
  for (const w of WRITERS) {
    const row = { type: w.type, title: "Dune", body: w.body, mediaType: w.mediaType, data: w.data };
    assert.deepEqual(renderNotification(row, en), { title: "Dune", body: w.body }, `${w.type}/${w.mediaType}`);
  }
});

test("a Spanish reader gets the Spanish body; the title (a media/issue title) is never translated", () => {
  const r = (type: string, mediaType: "MOVIE" | "TV" | null, data: unknown) =>
    renderNotification({ type, title: "Dune", body: "stored", mediaType, data }, es);
  assert.deepEqual(r("REQUEST_AVAILABLE", "MOVIE", { v: 1 }), { title: "Dune", body: "Tu película ya está disponible para ver." });
  assert.equal(r("REQUEST_DECLINED", "TV", { v: 1 }).body, "Tu solicitud de serie fue rechazada.");
  assert.equal(r("ISSUE_RESOLVED", null, { v: 1, resolution: "Listo" }).body, "Resuelta: Listo");
  assert.equal(r("ISSUE_RESOLVED", null, { v: 1, resolution: null }).body, "La incidencia que reportaste se resolvió.");
  // User text is interpolated verbatim — a `{x}` inside it is not a placeholder.
  assert.equal(r("ISSUE_REPLY", null, { v: 1, author: "Ana", text: "ok {author}" }).body, "Ana respondió: ok {author}");
});

test("rows without usable data keep their stored text in every language", () => {
  const stored = { title: "Dune", body: "Legacy English body" };
  const cases: Array<{ type: string; mediaType: "MOVIE" | "TV" | null; data?: unknown }> = [
    { type: "REQUEST_APPROVED", mediaType: "MOVIE" }, // pre-column row: no data at all
    { type: "REQUEST_APPROVED", mediaType: "MOVIE", data: null },
    { type: "REQUEST_APPROVED", mediaType: null, data: { v: 1 } }, // no media type to pick a sentence
    { type: "ISSUE_REPLY", mediaType: null, data: { v: 1, author: "Ana" } }, // malformed
    { type: "ISSUE_REPLY", mediaType: null, data: { v: 2, author: "Ana", text: "x" } }, // unknown version
    { type: "ISSUE_REPLY", mediaType: null, data: ["not", "an", "object"] },
    { type: "SOMETHING_NEW", mediaType: null, data: { v: 1 } }, // unknown type
  ];
  for (const c of cases) {
    assert.deepEqual(renderNotification({ ...stored, ...c }, es), stored, JSON.stringify(c));
  }
});

test("a rendered body never exceeds the stored body's 1000-char cap", () => {
  const text = "x".repeat(400);
  const author = "y".repeat(800);
  const body = renderNotification({ type: "ISSUE_REPLY", title: "t", body: "b", mediaType: null, data: { v: 1, author, text } }, en).body;
  const stored = buildNotificationData("u", { type: "ISSUE_REPLY", title: "t", body: `${author} replied: ${text}` }).body;
  assert.equal(body, stored);
  assert.equal(body.length, 1000);
});

test("requestBodyKey covers exactly the three request types, and only with a media type", () => {
  assert.equal(requestBodyKey("REQUEST_AVAILABLE", "TV"), "personal.notifications.body.availableTv");
  assert.equal(requestBodyKey("REQUEST_AVAILABLE", null), null);
  assert.equal(requestBodyKey("ISSUE_REPLY", "MOVIE"), null);
});

test("buildNotificationData writes `data` only when given (rows without it keep the old shape)", () => {
  assert.equal("data" in buildNotificationData("u", { type: "T", title: "a", body: "b" }), false);
  assert.deepEqual(buildNotificationData("u", { type: "T", title: "a", body: "b", data: { v: 1 } }).data, { v: 1 });
});

// ── catalog coverage for the server-side notification modules ───────────────

const ROOT = new URL("..", import.meta.url).pathname;
function readCatalog(locale: string): Record<string, string> {
  const dir = join(ROOT, "src/lib/i18n/messages", locale);
  return Object.assign({}, ...readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8"))));
}
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "generated") continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

test("every literal notify.* key passed to a translator in src/ exists in the English catalog", () => {
  const catalog = readCatalog("en");
  // t(…), tr(…), channelT(…) and translator-returning calls like
  // interactionTranslatorSync(x)("…").
  const call = /(?:\b(?:t|tr|channelT)|\))\(\s*["'](notify\.[A-Za-z0-9_.-]+)["']/g;
  const missing: string[] = [];
  let seen = 0;
  for (const file of walk(join(ROOT, "src"))) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(call)) {
      seen++;
      const key = m[1];
      const plural = Object.keys(catalog).some((k) => k.startsWith(`${key}_`));
      if (!(key in catalog) && !plural) missing.push(`${file.slice(ROOT.length)}: ${key}`);
    }
  }
  assert.ok(seen > 100, `the scan found only ${seen} notify.* calls — is the regex still matching?`);
  assert.deepEqual(missing, []);
});

test("English notify.* strings keep the exact historical literals (spot checks)", () => {
  const c = readCatalog("en");
  assert.equal(c["notify.email.footer"], "Sent by {brand}");
  assert.equal(c["notify.media.tv"], "TV Show");
  assert.equal(c["notify.issueType.WRONG_AUDIO"], "WRONG AUDIO"); // enum-derived, casing untouched
  assert.equal(c["notify.discord.issueType.WRONG_AUDIO"], "Wrong audio");
  assert.equal(c["notify.bot.link.transferred_one"], "{count} previous Discord request have been transferred to your account.");
});
