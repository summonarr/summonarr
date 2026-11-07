// The client half of the background fix-match (guardrail 37a) hands its
// consumers CODES, never English prose: both the per-row FixMatchButton and
// the issue dialog map a code to a translated line through one shared helper,
// so a French admin never sees the restart/timeout guidance in English. The
// poll loop itself (3s interval, 20 min deadline) is not driven here — these
// pin the pure mapping and, structurally, that the lib has no bare `Error`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  FixMatchClientError,
  fixMatchErrorMessage,
  fixMatchWarningMessage,
} from "../src/lib/client/fix-match.ts";
import type { Translator } from "../src/lib/i18n/translate.ts";

// Records the key + vars it was asked for so a test can assert the mapping
// without a catalog.
const t: Translator = (key, vars) => `<${key}${vars ? ":" + JSON.stringify(vars) : ""}>`;

test("every client-only outcome maps to its own translation key", () => {
  assert.equal(fixMatchErrorMessage(new FixMatchClientError("jobLost", { status: 404 }), t), "<adminQueue.fixMatch.outcome.jobLost>");
  assert.equal(fixMatchErrorMessage(new FixMatchClientError("pollLost"), t), "<adminQueue.fixMatch.outcome.pollLost>");
  assert.equal(fixMatchErrorMessage(new FixMatchClientError("pollLost", { status: 502 }), t), "<adminQueue.fixMatch.outcome.pollLost>");
  assert.equal(fixMatchErrorMessage(new FixMatchClientError("timedOut"), t), "<adminQueue.fixMatch.outcome.timedOut>");
});

test("an HTTP failure with no server message reports the status through the shared key", () => {
  assert.equal(
    fixMatchErrorMessage(new FixMatchClientError("http", { status: 503 }), t),
    '<adminQueue.common.requestFailed:{"status":503}>',
  );
});

test("`failed` passes the server's (already translated) message through verbatim, falling back to a key when it sent none", () => {
  const serverMsg = "Jellyfin a refusé l'identification";
  assert.equal(fixMatchErrorMessage(new FixMatchClientError("failed", { message: serverMsg }), t), serverMsg);
  assert.equal(fixMatchErrorMessage(new FixMatchClientError("failed", { message: "" }), t), "<adminQueue.fixMatch.outcome.failed>");
});

test("a non-client error keeps its own message; anything else is the unknown-error key", () => {
  assert.equal(fixMatchErrorMessage(new Error("boom"), t), "boom");
  assert.equal(fixMatchErrorMessage("nope", t), "<adminQueue.fixMatch.unknownError>");
  assert.equal(fixMatchErrorMessage(new Error(""), t), "<adminQueue.fixMatch.unknownError>");
});

test("a successful outcome's warning line: server note, joined notice, both, or nothing", () => {
  assert.equal(fixMatchWarningMessage({ ok: true }, t), null);
  assert.equal(fixMatchWarningMessage({ ok: true, warning: "2 of 3 copies" }, t), "2 of 3 copies");
  assert.equal(fixMatchWarningMessage({ ok: true, joined: true }, t), "<adminQueue.fixMatch.outcome.joined>");
  assert.equal(
    fixMatchWarningMessage({ ok: true, warning: "2 of 3 copies", joined: true }, t),
    "2 of 3 copies <adminQueue.fixMatch.outcome.joined>",
  );
});

test("structural: the client lib throws only FixMatchClientError — never a bare Error carrying prose", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "../src/lib/client/fix-match.ts"), "utf8");
  // Reverting any of the five old `throw new Error("The server lost track…")`
  // sites fails this pin.
  assert.equal(src.match(/throw new Error\(/g), null, "bare `throw new Error(` found in src/lib/client/fix-match.ts");
  // Every code the type names is constructible, so a consumer switch stays total.
  for (const code of ["http", "failed", "jobLost", "pollLost", "timedOut"] as const) {
    const err = new FixMatchClientError(code);
    assert.equal(err.code, code);
    assert.ok(err instanceof Error);
  }
});

// ── stall-based give-up (replaces the fixed 20-minute window) ────────────────
import { hasStalled, progressSignature, runFixMatch, STALL_LIMIT_MS, NO_PROGRESS_LIMIT_MS } from "../src/lib/client/fix-match.ts";

test("progressSignature changes with any attempt/phase/copy movement and is empty without progress", () => {
  const base = { phase: "confirming" as const, remoteApplied: true, attempt: 3, attempts: 120, readFailures: 0 };
  assert.equal(progressSignature(undefined), "");
  assert.notEqual(progressSignature(base), progressSignature({ ...base, attempt: 4 }));
  assert.notEqual(progressSignature(base), progressSignature({ ...base, copy: 2, copies: 3 }));
  assert.equal(progressSignature(base), progressSignature({ ...base }));
});

test("hasStalled: 10 minutes of silence for a progress-reporting job, 20 for one that reports none", () => {
  assert.equal(hasStalled(STALL_LIMIT_MS - 1, 0, true), false);
  assert.equal(hasStalled(STALL_LIMIT_MS, 0, true), true);
  assert.equal(hasStalled(STALL_LIMIT_MS, 0, false), false);
  assert.equal(hasStalled(NO_PROGRESS_LIMIT_MS, 0, false), true);
});

test("runFixMatch keeps polling past 20 minutes while the job's progress keeps moving, and gives up once it stalls", async () => {
  const realFetch = globalThis.fetch;
  const realNow = Date.now;
  const realSetTimeout = globalThis.setTimeout;
  let clock = 1_000_000;
  Date.now = () => clock;
  // Each 3s poll "takes" three seconds of the fake clock; no real waiting.
  globalThis.setTimeout = ((fn: () => void, ms?: number) => { clock += ms ?? 0; return realSetTimeout(fn, 0); }) as typeof setTimeout;
  let polls = 0;
  let stallAfter = Infinity;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (url.endsWith("/api/admin/fix-match")) return json({ ok: true, jobId: "00000000-0000-0000-0000-000000000000" }, 202);
    polls++;
    // 25 minutes of polling (500 × 3s) with a moving attempt counter, then done.
    if (polls > 500) return json({ status: "done", result: { ok: true } });
    const attempt = polls < stallAfter ? polls : stallAfter;
    return json({ status: "running", progress: { phase: "confirming", remoteApplied: true, attempt, attempts: 600, readFailures: 0 } });
  }) as typeof fetch;
  try {
    const body = { server: "jellyfin" as const, mediaType: "TV" as const, correctTmdbId: 5, tmdbId: 4 };
    assert.deepEqual(await runFixMatch(body), { ok: true }, "a 25-minute job with moving progress completes");
    polls = 0; stallAfter = 10; clock = 2_000_000;
    await assert.rejects(runFixMatch(body), (e: unknown) => e instanceof FixMatchClientError && e.code === "timedOut");
  } finally {
    globalThis.fetch = realFetch; Date.now = realNow; globalThis.setTimeout = realSetTimeout;
  }
});

test("a QUEUED job is never a stall: 30 minutes in line still completes, and the UI is told its position", async () => {
  const realFetch = globalThis.fetch, realNow = Date.now, realSetTimeout = globalThis.setTimeout;
  let clock = 5_000_000;
  Date.now = () => clock;
  globalThis.setTimeout = ((fn: () => void, ms?: number) => { clock += ms ?? 0; return realSetTimeout(fn, 0); }) as typeof setTimeout;
  let polls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (String(input).endsWith("/api/admin/fix-match")) return json({ ok: true, jobId: "00000000-0000-0000-0000-000000000000" }, 202);
    polls++;
    return polls <= 600 ? json({ status: "queued", queueAhead: 2 }) : json({ status: "done", result: { ok: true } });
  }) as typeof fetch;
  const seen: Array<{ phase: string; queueAhead?: number }> = [];
  try {
    const out = await runFixMatch({ server: "plex", mediaType: "MOVIE", correctTmdbId: 5, tmdbId: 4 }, { onProgress: (p) => seen.push({ phase: p.phase, queueAhead: p.queueAhead }) });
    assert.deepEqual(out, { ok: true });
    assert.deepEqual(seen[0], { phase: "queued", queueAhead: 2 });
  } finally {
    globalThis.fetch = realFetch; Date.now = realNow; globalThis.setTimeout = realSetTimeout;
  }
});

test("a status poll answered 200 with something that is not the status JSON is a failed poll: pollLost after ten in a row, not a 20-minute 'running'", async () => {
  // An auth proxy that redirects an expired session to its HTML login page
  // answers 200; reading that as "still running" kept the dialog waiting for
  // the 20-minute no-progress window.
  const realFetch = globalThis.fetch, realNow = Date.now, realSetTimeout = globalThis.setTimeout;
  let clock = 7_000_000;
  Date.now = () => clock;
  globalThis.setTimeout = ((fn: () => void, ms?: number) => { clock += ms ?? 0; return realSetTimeout(fn, 0); }) as typeof setTimeout;
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  const pages: Array<() => Response> = [
    () => new Response("<!doctype html><title>Sign in</title>", { status: 200, headers: { "content-type": "text/html" } }),
    () => json({}),
    () => json({ status: "pending" }),
    // Followed through a redirect: even a status-shaped body is not the job's answer.
    () => Object.defineProperty(json({ status: "running" }), "redirected", { value: true }),
  ];
  let polls = 0;
  let page = pages[0];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).endsWith("/api/admin/fix-match")) return json({ ok: true, jobId: "00000000-0000-0000-0000-000000000000" }, 202);
    polls++;
    return page();
  }) as typeof fetch;
  try {
    for (const next of pages) {
      page = next;
      polls = 0;
      const startedAt = clock;
      await assert.rejects(
        runFixMatch({ server: "plex", mediaType: "MOVIE", correctTmdbId: 5, tmdbId: 4 }),
        (e: unknown) => e instanceof FixMatchClientError && e.code === "pollLost",
      );
      assert.equal(polls, 10, "gives up after ten failed polls in a row");
      assert.ok(clock - startedAt < NO_PROGRESS_LIMIT_MS, "long before the no-progress window");
    }
  } finally {
    globalThis.fetch = realFetch; Date.now = realNow; globalThis.setTimeout = realSetTimeout;
  }
});

test("a job started for an issue reports whether the server closed it — but a JOINED job's flag is someone else's issue", async () => {
  const realFetch = globalThis.fetch, realNow = Date.now, realSetTimeout = globalThis.setTimeout;
  let clock = 9_000_000;
  Date.now = () => clock;
  globalThis.setTimeout = ((fn: () => void, ms?: number) => { clock += ms ?? 0; return realSetTimeout(fn, 0); }) as typeof setTimeout;
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  let joined = false;
  const sent: unknown[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("/api/admin/fix-match")) {
      sent.push(JSON.parse(String(init?.body)));
      return json({ ok: true, jobId: "00000000-0000-0000-0000-000000000000", ...(joined ? { joined: true } : {}) }, 202);
    }
    return json({ status: "done", result: { ok: true, issueResolved: false } });
  }) as typeof fetch;
  try {
    const body = { server: "jellyfin" as const, mediaType: "MOVIE" as const, correctTmdbId: 5, tmdbId: 4, issueId: "issue-1", issueTitle: "Dune" };
    assert.deepEqual(await runFixMatch(body), { ok: true, issueResolved: false });
    assert.deepEqual(sent[0], { ...body, async: true }, "the issue rides the start POST");
    joined = true;
    assert.deepEqual(await runFixMatch(body), { ok: true }, "joined: the flag is dropped, never misread as this issue's");
  } finally {
    globalThis.fetch = realFetch; Date.now = realNow; globalThis.setTimeout = realSetTimeout;
  }
});

// ── the fix-match pickers (no .tsx harness: structural) ─────────────────────

test("structural: a TMDB runtime of 0 never renders a bare digit — the runtime guards compare, never `x && <jsx>`", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const file of ["../src/components/admin/fix-match-button.tsx", "../src/components/admin/issue-fix-match-button.tsx"]) {
    const src = readFileSync(join(here, file), "utf8");
    assert.doesNotMatch(src, /\{\s*(targetRuntime|candidate\.tmdbRuntime)\s*&&/, `${file}: a 0 runtime renders "0"`);
    assert.doesNotMatch(src, /\{\s*targetRuntime\s*&&\s*`/, `${file}: the runtime delta renders "0" too`);
  }
});

test("structural: a Plex candidate row only PICKS — the remap starts from the footer's Apply, never a row click", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "../src/components/admin/fix-match-button.tsx"), "utf8");
  const row = src.slice(src.indexOf("function CandidateRow("), src.indexOf("export function FixMatchButton("));
  assert.match(row, /onClick=\{\(\) => onPick\(candidate\.guid\)\}/);
  assert.match(row, /aria-pressed=\{picked\}/);
  assert.doesNotMatch(row, /onSelect/, "a row never reaches the apply");
  assert.match(src, /onClick=\{server === "jellyfin" \? onConfirm : \(\) => \{ if \(pickedGuid\) onSelect\(pickedGuid\); \}\}/);
  assert.match(src, /disabled=\{applying \|\| \(server === "plex" && pickedGuid === null\)\}/, "Apply waits for a pick");
});

test("structural: a settled row button (fixed, or fixed with a warning) can be dismissed back to the button", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "../src/components/admin/fix-match-button.tsx"), "utf8");
  for (const phase of ["success", "conflated"]) {
    const start = src.indexOf(`if (phase === "${phase}") {`);
    assert.ok(start !== -1, phase);
    const branch = src.slice(start, src.indexOf("\n  }\n", start));
    assert.match(branch, /\{dismiss\}/, `${phase} offers the way back`);
  }
  assert.match(src, /const dismiss = \(\s*<button onClick=\{reset\}/);
});

test("structural: the issue dialog sends its issue to the job, and PATCHes it only when the job can't say", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "../src/components/admin/issue-fix-match-button.tsx"), "utf8");
  assert.match(src, /issueId, issueTitle: selected\.title,\n\s*\}, \{ signal: ac\.signal \}\);/, "the start POST carries the issue");
  assert.match(src, /const resolved = outcome\.issueResolved \?\? await resolveIssue\(selected\.title\);/);
  // One apply for both services, with a controller per side.
  assert.equal(src.match(/await runFixMatch\(/g)?.length, 1);
  assert.match(src, /const abort = side === "plex" \? plexAbort : jellyfinAbort;/);
});

test("structural: the issue dialog's header 'Use this' is disabled while a fix runs, and Back re-shows the last results without searching again", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "../src/components/admin/issue-fix-match-button.tsx"), "utf8");
  const useThis = src.slice(src.lastIndexOf("<button", src.indexOf('t("adminQueue.fixMatch.useThis")')), src.indexOf('t("adminQueue.fixMatch.useThis")'));
  assert.match(useThis, /disabled=\{busy\}/);
  assert.match(src, /if \(q === lastSearched\.current\) return;/);
  assert.match(src, /lastSearched\.current = q;\n\s*setSearchResults\(json as TmdbMedia\[\]\);/, "remembered only after a successful search");
  assert.match(src, /maxLength=\{200\}/);
});

test("structural: an add-as-request still in flight when the dialog closes never writes into the next session", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "../src/components/admin/issue-fix-match-button.tsx"), "utf8");
  const reset = src.slice(src.indexOf("const reset = useCallback("), src.indexOf("const close = useCallback("));
  assert.match(reset, /addGen\.current\+\+;/);
  const add = src.slice(src.indexOf("async function addWrongItemAsRequest("), src.indexOf("const busy ="));
  assert.match(add, /const gen = \+\+addGen\.current;/);
  assert.match(add, /if \(gen === addGen\.current\) setAddWrongState\(next\);/);
  assert.equal(add.match(/setAddWrongState\(/g)?.length, 2, "\"adding\", then the guarded outcome — no unguarded write");
});
