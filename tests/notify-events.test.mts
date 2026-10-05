// Pure rules for the outbound notification channels (src/lib/notify-events.ts):
// config validation per kind, the event allowlist, the versioned webhook
// payload, the {{field}} template renderer's escaping, the ntfy/Gotify bodies,
// and the retry classification.
import { test } from "node:test";
import assert from "node:assert/strict";

const {
  validateAgentConfig,
  validateAgentUrl,
  sanitizeEvents,
  buildWebhookPayload,
  renderTemplate,
  buildNtfyBody,
  buildGotifyBody,
  ntfyPublishUrl,
  gotifyMessageUrl,
  classifyStatus,
  posterUrlOf,
  eventLink,
  NOTIFY_EVENT_KEYS,
  RETRY_DELAYS_MS,
} = await import("../src/lib/notify-events.ts");

const CTX = { siteUrl: "https://s.example", title: "T", message: "M", mediaTitle: "Dune", timestamp: "2026-01-01T00:00:00.000Z" };

test("channel URLs: absolute http(s) only, never with credentials (those belong in the encrypted secret)", () => {
  assert.equal(validateAgentUrl("https://ntfy.sh"), "https://ntfy.sh/");
  assert.equal(validateAgentUrl("http://192.168.1.5:8080/hook"), "http://192.168.1.5:8080/hook");
  assert.equal(validateAgentUrl("ftp://x.example/"), null);
  assert.equal(validateAgentUrl("ntfy.sh"), null);
  assert.equal(validateAgentUrl("https://user:pw@x.example/"), null);
  assert.equal(validateAgentUrl("https://token@x.example/"), null);
  assert.equal(validateAgentUrl(42), null);
});

test("ntfy: topic charset, priority 1–5 with default 3, attachPoster only when literally true", () => {
  assert.deepEqual(validateAgentConfig("ntfy", { url: "https://ntfy.sh", topic: "summon_arr-1" }), {
    ok: true,
    config: { url: "https://ntfy.sh/", topic: "summon_arr-1", priority: 3, attachPoster: false },
  });
  assert.deepEqual(validateAgentConfig("ntfy", { url: "https://ntfy.sh", topic: "a b" }), { ok: false, error: "topic" });
  assert.deepEqual(validateAgentConfig("ntfy", { url: "https://ntfy.sh", topic: "x", priority: 6 }), { ok: false, error: "priority" });
  assert.deepEqual(validateAgentConfig("ntfy", { url: "https://ntfy.sh", topic: "x", priority: 2.5 }), { ok: false, error: "priority" });
  const r = validateAgentConfig("ntfy", { url: "https://ntfy.sh", topic: "x", attachPoster: "true" });
  assert.ok(r.ok && (r.config as { attachPoster: boolean }).attachPoster === false);
});

test("gotify: priority 0–10 with default 5", () => {
  assert.deepEqual(validateAgentConfig("gotify", { url: "https://g.example" }), { ok: true, config: { url: "https://g.example/", priority: 5 } });
  assert.deepEqual(validateAgentConfig("gotify", { url: "https://g.example", priority: 11 }), { ok: false, error: "priority" });
  assert.deepEqual(validateAgentConfig("gotify", { url: "https://g.example", priority: 0 }), { ok: true, config: { url: "https://g.example/", priority: 0 } });
});

test("webhook: header name charset, transport-owned headers refused, template must render to JSON", () => {
  assert.deepEqual(validateAgentConfig("webhook", { url: "https://h.example/x" }), {
    ok: true,
    config: { url: "https://h.example/x", template: null, headerName: "Authorization" },
  });
  for (const headerName of ["Content-Type", "host", "Content-Length", "X Bad", "Cookie"]) {
    assert.deepEqual(validateAgentConfig("webhook", { url: "https://h.example/x", headerName }), { ok: false, error: "headerName" }, headerName);
  }
  assert.deepEqual(validateAgentConfig("webhook", { url: "https://h.example/x", template: "{ not json" }), { ok: false, error: "templateInvalid" });
  // A placeholder OUTSIDE quotes renders bare text → invalid JSON → refused.
  assert.deepEqual(validateAgentConfig("webhook", { url: "https://h.example/x", template: "{\"t\": {{title}} }" }), { ok: false, error: "templateInvalid" });
  assert.ok(validateAgentConfig("webhook", { url: "https://h.example/x", template: "{\"content\": \"{{title}}: {{text}}\"}" }).ok);
  assert.deepEqual(validateAgentConfig("webhook", { url: "https://h.example/x", template: `"${"x".repeat(8_001)}"` }), { ok: false, error: "templateTooLong" });
});

test("events: an unknown key (or agent.test) refuses the whole list; known keys dedupe into catalog order", () => {
  assert.deepEqual(sanitizeEvents(["request.available", "request.created", "request.available"]), ["request.created", "request.available"]);
  assert.equal(sanitizeEvents(["request.created", "agent.test"]), null);
  assert.equal(sanitizeEvents(["request.nope"]), null);
  assert.equal(sanitizeEvents("request.created"), null);
  assert.deepEqual(sanitizeEvents([...NOTIFY_EVENT_KEYS].reverse()), [...NOTIFY_EVENT_KEYS]);
});

test("payload: versioned, localized media title, poster URL only for a well-formed TMDB path, no PII fields", () => {
  const p = buildWebhookPayload(
    {
      event: "request.created",
      media: { type: "MOVIE", tmdbId: 438631, title: "Dune (English)", year: "2021", posterPath: "/d.jpg" },
      request: { id: "r1", instance: "4k" },
      actor: { name: "alice" },
      text: "please",
    },
    CTX,
  );
  assert.equal(p.version, 1);
  assert.equal(p.media?.title, "Dune", "the payload carries the title in the message's language");
  assert.equal(p.media?.type, "movie");
  assert.equal(p.media?.posterUrl, "https://image.tmdb.org/t/p/w500/d.jpg");
  assert.equal(p.url, "https://s.example/movie/438631");
  assert.deepEqual(p.request, { id: "r1", instance: "4k" });
  assert.deepEqual(p.actor, { name: "alice" });
  const keys = JSON.stringify(p);
  for (const pii of ["email", "ipAddress", "userId"]) assert.ok(!keys.includes(`"${pii}"`), pii);

  assert.equal(posterUrlOf("https://evil.example/x.jpg"), null);
  assert.equal(posterUrlOf("/../../x"), null);
  assert.equal(posterUrlOf(null), null);
});

test("links: issues → /issues, media → title page, requests without media → /requests, no site URL → null", () => {
  assert.equal(eventLink({ event: "issue.reply", media: { type: "TV", tmdbId: 1, title: "x" } }, "https://s"), "https://s/issues");
  assert.equal(eventLink({ event: "request.approved", media: { type: "TV", tmdbId: 7, title: "x" } }, "https://s"), "https://s/tv/7");
  assert.equal(eventLink({ event: "request.approved" }, "https://s"), "https://s/requests");
  assert.equal(eventLink({ event: "request.approved", media: { type: "TV", tmdbId: 7, title: "x" } }, null), null);
});

test("template: every value is JSON-string escaped, so user text can't break out of its string", () => {
  const p = buildWebhookPayload({ event: "issue.reply", actor: { name: "bob" }, text: "a \"quote\"\nnew line \\ and }" }, CTX);
  const out = renderTemplate("{\"msg\": \"{{text}}\", \"who\": \"{{actor.name}}\", \"x\": \"{{secret}}{{constructor}}\"}", p);
  const parsed = JSON.parse(out);
  assert.equal(parsed.msg, "a \"quote\"\nnew line \\ and }");
  assert.equal(parsed.who, "bob");
  assert.equal(parsed.x, "", "fields outside the allowlist render as nothing");
});

test("ntfy body: publish to the server ROOT with the topic in the body; click + poster only when available", () => {
  const p = buildWebhookPayload({ event: "request.available", media: { type: "MOVIE", tmdbId: 5, title: "x", posterPath: "/p.jpg" } }, CTX);
  assert.deepEqual(buildNtfyBody({ url: "https://n/", topic: "t", priority: 4, attachPoster: true }, p), {
    topic: "t",
    title: "T",
    message: "M",
    tags: ["tada"],
    priority: 4,
    click: "https://s.example/movie/5",
    attach: "https://image.tmdb.org/t/p/w500/p.jpg",
  });
  const noPoster = buildNtfyBody({ url: "https://n/", topic: "t", priority: 4, attachPoster: false }, p);
  assert.equal("attach" in noPoster, false);
  assert.equal(ntfyPublishUrl("https://ntfy.example/sub"), "https://ntfy.example/sub/");
  assert.equal(ntfyPublishUrl("https://ntfy.example/"), "https://ntfy.example/");
});

test("gotify body: plain-text display + click URL; the message endpoint carries no token", () => {
  const p = buildWebhookPayload({ event: "issue.created", media: { type: "TV", tmdbId: 9, title: "x" } }, CTX);
  assert.deepEqual(buildGotifyBody({ url: "https://g/", priority: 7 }, p), {
    title: "T",
    message: "M",
    priority: 7,
    extras: { "client::display": { contentType: "text/plain" }, "client::notification": { click: { url: "https://s.example/issues" } } },
  });
  assert.equal(gotifyMessageUrl("https://g.example/base/"), "https://g.example/base/message");
});

test("template validation renders a SPARSE sample too: a placeholder valid only while its field is set is refused", () => {
  const url = "https://h.example/x";
  // The full sample has media.tmdbId = 603 and year "1999", so an UNQUOTED
  // numeric placeholder renders a bare number there and parses — then renders
  // `{"id": }` for every event without media (arr.manual_interaction) or
  // without a tmdbId. Both samples must parse.
  assert.deepEqual(validateAgentConfig("webhook", { url, template: "{\"id\": {{media.tmdbId}}}" }), { ok: false, error: "templateInvalid" });
  assert.deepEqual(validateAgentConfig("webhook", { url, template: "{\"year\": {{media.year}}}" }), { ok: false, error: "templateInvalid" });
  assert.deepEqual(validateAgentConfig("webhook", { url, template: "{\"n\": {{votes}}}" }), { ok: false, error: "templateInvalid" });
  // Quoted, the same placeholders render "" when null and stay valid JSON.
  assert.ok(validateAgentConfig("webhook", { url, template: "{\"id\": \"{{media.tmdbId}}\", \"year\": \"{{media.year}}\", \"n\": \"{{votes}}\", \"u\": \"{{url}}\"}" }).ok);
});

test("ntfy/gotify URLs are a BASE the request path is appended to: a query or fragment is refused; a webhook keeps its query", () => {
  // `https://g.example/?token=x` + "/message" would be `…/?token=x/message` — a
  // 404 with no validation message, and a token in the plaintext config column.
  for (const url of ["https://g.example/?token=x", "https://g.example/#frag", "https://g.example/?", "https://g.example/base?x=1"]) {
    assert.deepEqual(validateAgentConfig("gotify", { url, priority: 5 }), { ok: false, error: "url" }, `gotify ${url}`);
    assert.deepEqual(validateAgentConfig("ntfy", { url, topic: "t" }), { ok: false, error: "url" }, `ntfy ${url}`);
  }
  assert.ok(validateAgentConfig("gotify", { url: "https://g.example/base/" }).ok);
  assert.ok(validateAgentConfig("ntfy", { url: "https://n.example/sub", topic: "t" }).ok);
  // Generic webhooks post to the URL as given — Discord's `?wait=true` is legitimate.
  const hook = validateAgentConfig("webhook", { url: "https://discord.com/api/webhooks/1/abc?wait=true" });
  assert.ok(hook.ok && (hook.config as { url: string }).url === "https://discord.com/api/webhooks/1/abc?wait=true");
});

test("delivery policy: 2xx ok, 408/429/5xx retry, other 4xx fail; three retries", () => {
  assert.equal(classifyStatus(200), "ok");
  assert.equal(classifyStatus(204), "ok");
  for (const s of [408, 429, 500, 502, 503]) assert.equal(classifyStatus(s), "retry", String(s));
  for (const s of [301, 400, 401, 403, 404, 413]) assert.equal(classifyStatus(s), "fail", String(s));
  assert.equal(RETRY_DELAYS_MS.length, 3);
});
