@AGENTS.md

# Summonarr

Self-hosted media request aggregator. Users browse TMDB (trending / popular / discover / upcoming), request movies and TV, vote, and file issues. Admins approve requests and auto-fulfill via Radarr/Sonarr. The app ingests Plex and Jellyfin libraries + play history so users see availability, active sessions, and watch activity in one place. There is no public README — this file is the canonical project brief.

## Stack

- **Next.js 16.3.8** (App Router). AGENTS.md is not a suggestion — **read [node_modules/next/dist/docs/](node_modules/next/dist/docs/) before touching framework code**.
- **TypeScript** strict, path alias `@/*` → `./src/*`
- **Prisma 7.10** + **PostgreSQL 17**, schema-first. No `prisma/migrations/` directory — changes are applied via `prisma db push`.
- **Custom session auth** — a `jose`-signed (HS256) session JWT, not NextAuth (the project migrated off it; there is no `next-auth` dependency and no `auth.config.ts`). Session lifecycle lives in [src/lib/session-jwt.ts](src/lib/session-jwt.ts) (sign/verify + the cookie-vs-bearer transport binding, keys from [signing-keys.ts](src/lib/signing-keys.ts) — guardrail 6h), [src/lib/session-refresh.ts](src/lib/session-refresh.ts) (`verifyAndRefreshSession`: DB revocation, `sessionsRevokedAt`/`passwordChangedAt` cutoffs, role rotation, the sign-in deadline — guardrail 6c), [src/lib/session-cookie.ts](src/lib/session-cookie.ts), and [src/lib/auth.ts](src/lib/auth.ts) (`auth()` — JWT-only read). A custom `AuthSession` table backs per-device tracking + revocation. Providers: local credentials, Plex OAuth, Jellyfin (standard + QuickConnect), OIDC (`openid-client`).
- **Tailwind v4** — **no `tailwind.config.js`**. Theme lives inline in [src/app/globals.css](src/app/globals.css) under `@theme inline` with oklch variables and `.dark` class-based dark mode.
- **UI**: [src/components/ui/](src/components/ui/) — `@base-ui/react` (Radix-style) primitives scaffolded via the `shadcn` CLI, composed with the in-repo `@/lib/cva` and `@/lib/tw-merge` reimplementations (the `class-variance-authority` and `tailwind-merge` npm packages are **not** installed — these are hand-written equivalents; the merger's group table — named utilities AND a matrix of arbitrary `[…]`/`(…)` values — is CI-audited against the installed Tailwind, see guardrail 39). Icons are hand-written SVG components in [src/components/icons/](src/components/icons/), each rendered through `IconBase` — `lucide-react` is not installed; copy an icon file to add one. Icon types live in [icons/types.ts](src/components/icons/types.ts) (a leaf imports `./types`, never the barrel); accessibility is `iconA11y` ([icon-a11y.ts](src/components/icons/icon-a11y.ts)): only a label exposes an icon, a `role="img"` without a name is hidden. A segmented control uses [segmented-style.ts](src/components/ui/design/segmented-style.ts), never a copied recipe.
- **Client state**: plain `useState` + URL `searchParams`. No Zustand, Jotai, Redux, or TanStack Query. A page types `searchParams` as `PageSearchParams` and reads it through `first()`/`searchParamGetter` ([search-params.ts](src/lib/search-params.ts)) — a repeated key arrives as an array. The /movies and /tv filters have ONE parser and predicate pair ([browse-filters.ts](src/lib/browse-filters.ts)); the browse filter bars hold in-flight changes through `usePendingFilters` ([use-pending-filters.ts](src/components/media/use-pending-filters.ts)).
- **Data fetching**: REST API routes + `fetch` on the client, or server components calling Prisma directly. No tRPC. No server actions.
- **Checked data at every boundary** — the four shared helpers:
  - [validate.ts](src/lib/validate.ts) (`v.*` schemas + `check(schema, value)`, `Infer<S>`): data from outside the process that drives logic or a DB write is checked, never `as T`. `v.object` returns a NEW object with only the declared keys (safe to spread into a write; wrong for a GET-modify-PUT — check, then send the original). `readJsonCapped(req, max, schema)` 400s a body that fails one, and the tmdb-cache reads take an optional schema (pass one when a cached blob drives logic).
  - [client/fetch-json.ts](src/lib/client/fetch-json.ts) (`fetchJson(url, { schema, init: jsonInit(method, body), signal, timeoutMs, fallbackError })`): a client component's JSON read; never throws, answers `ok` or a failure `kind` (aborted / timeout / network = status 0 per 37a / http / invalid). Default timeout 30 s — a long synchronous route passes more. A 2xx write whose body is not JSON (`invalid`) still succeeded. It exposes no headers, so a caller that shows Retry-After keeps `fetch` + `readApiError` (`retryAfterDeltaSeconds`, [client/rate-limit.ts](src/lib/client/rate-limit.ts)).
  - [hooks/use-async-action.ts](src/hooks/use-async-action.ts) (`useAsyncAction()` → `run(key, (signal) => …, { ifBusy })`, `busy(key)`): per-key busy state; a re-run aborts the one in flight, unmount aborts all, and `run` resolves `undefined` for a dropped run. Return the value and apply it after `run` resolves (never set state inside), pass `signal` on, key per row, and use `{ ifBusy: "skip" }` for a non-idempotent submit.
  - [upstream-result.ts](src/lib/upstream-result.ts) (`UpstreamResult` = ok / missing / failed): a transient failure is never cached, stored or shown as "not found"/"empty". Cache only through `isCacheable`; never decide a write with `valueOr`. An empty list is `ok([])`.
- **Server/client boundary**: a server module never CALLS a function or reads a value imported from a `"use client"` module (guardrail 29a).
- **Package manager**: npm (see `package-lock.json`). No `packageManager` field, no `.nvmrc`.

## Commands

```bash
npm run dev         # next dev
npm run build       # next build
npm run start       # next start (production)
npm run lint        # eslint
npm run test        # node:test unit suite (tests/*.test.mts)
npm run audit:deps  # custom TypeScript dep audit
npm run audit:tw-merge  # tw-merge group table vs the installed Tailwind
```

Typechecking is **dual-compiler**: `npm run typecheck` runs the native TS 7 compiler (the `tsgo` dev-dep alias `npm:typescript@7` — also what `npx tsc` resolves to via the bin link), and `npm run typecheck:classic` runs the classic TS 6 that `next build` and typescript-eslint load via `require('typescript')`. Run BOTH before claiming types pass — the root `typescript` package MUST stay on 6 until Next and typescript-eslint support TS 7's JS API (they probe `typescript/lib/typescript.js` / `ts.Extension`, both gone in 7 — see the ignore rule in [.github/dependabot.yml](.github/dependabot.yml) and Dependabot PRs #165/#173). CI runs both checks.

The unit suite (`npm test`, Node's built-in `node:test`, files in [tests/](tests/)) covers pure/in-memory surfaces of `src/lib` plus route/proxy handlers invoked directly. Rules that always apply: claim "unit tests pass" **only** for that surface — it does NOT cover live-DB behaviour end to end (DB-bound paths run against in-memory prisma stubs; raw-SQL aggregates are not exercised); source must use **erasable TS syntax only** (no constructor parameter properties); tests must never hit a real DB or the network; new tests colocate in `tests/*.test.mts` and import source with an explicit `.ts` extension. CI also runs a headless E2E route crawl ([scripts/e2e-crawl.mts](scripts/e2e-crawl.mts)) that gates hydration/runtime correctness (guardrail 16) only. The full coverage inventory, loader details and per-area pins are in [docs/testing.md](docs/testing.md).

## Directory map

- [src/app/(app)/](src/app/(app)/) — user-facing pages: home, movies, tv, upcoming, popular, top, votes, requests, issues, donate, profile, settings, plus an `admin/` subtree (activity, users, library, backup, audit-log, stats, issues).
- [src/app/api/](src/app/api/) — REST handlers grouped by domain: `sync/`, `webhooks/`, `auth/`, `admin/`, `requests/`, `issues/`, `votes/`, `ratings/`, `play-history/`, `profile/`, `search/`, `sessions/`, `push/`, `discord/`, `cron/`, `health/`.
- [src/lib/](src/lib/) — integrations and utilities: `plex.ts`, `jellyfin.ts`, `jellyfin-availability.ts`, `arr.ts`, `cron-auth.ts`, `batch-write.ts`, `play-history.ts`, `tmdb-types.ts`, `prisma.ts`.
  - Big modules are split into FLAT SIBLINGS behind a re-export entry: `arr.ts` → `arr-client/-config/-id-map/-lookup/-add/-releases/-queue-cache`; `plex.ts` → `plex-http/-metadata/-library/-episodes/-sessions/-history/-user-state/-accounts/-pin`; `jellyfin.ts` → `jellyfin-http/-paging/-library/-episodes/-sessions/-users/-user-data/-signin`; `play-history.ts` → `play-history-record/-cache/-aggregate/-calendar/-sql-fragments/-stats/-list/…`; `auth.ts` → `auth-credentials/-session-mint/-plex/-jellyfin/-oidc/…`; the fix-match POST → `fix-match-remote/-plex/-jellyfin/-apply/-run/-conflicts`. Callers import the ENTRY; siblings import each other directly, never through the entry (a cycle). The entry's header lists its siblings.
  - NEVER put a folder named like an existing module beside it (`src/lib/x/` next to `src/lib/x.ts`): the unit-test loader resolves the extensionless import to the directory (`ERR_UNSUPPORTED_DIR_IMPORT`).
  - A Next route file exports only handlers and segment config — a pure helper a test needs goes in `src/lib`.
  - [src/lib/openapi/](src/lib/openapi/) — the OpenAPI document as modules (guardrail 25); [src/lib/client/](src/lib/client/) — browser-side helpers (fetchJson, `arr-call.ts`, `url-query.ts`, `login-answers.ts` — the login page's answer rules, `backup-file.ts` — the encrypted-backup header check pinned to backup-crypto.ts, `library-items.ts` — the only reader of the `/api/settings/{plex,jellyfin}/libraries` lists, …).
  - One home each — reuse, don't restate: [display-name.ts](src/lib/display-name.ts) (`displayName`/`nameOrEmail`), [media-server-name.ts](src/lib/media-server-name.ts) (brand names are never translated), [status-labels.ts](src/lib/status-labels.ts), [upcoming-list.ts](src/lib/upcoming-list.ts) (the /upcoming page and `GET /api/upcoming`), [activity-title-resolve-data.ts](src/lib/activity-title-resolve-data.ts) (the activity pages' one title→tmdbId read; an ambiguous library title stays unresolved), [audit-log-client.ts](src/lib/audit-log-client.ts) (audit-log date bounds: `dateFrom` local midnight, `dateTo` 24 h before the next local midnight), [admin-user-fields.ts](src/lib/admin-user-fields.ts) (`PATCH /api/admin/users/[id]` edits ONE field per request; the delegate subset rule), [schema-check.ts](src/lib/schema-check.ts) (check-schema's expectation, derived from the generated client — the schema has no `@map`/`@@map`, pinned), [live-event-frames.ts](src/lib/live-event-frames.ts) (`parseLiveEvent`: a new SSE event type needs a schema there or the browser drops it), [availability-rules.ts](src/components/media/availability-rules.ts) (the chip rules), [skeleton-primitives.tsx](src/components/loading/skeleton-primitives.tsx), [media-server-library.tsx](src/components/settings/forms/media-server-library.tsx) (both default server forms' picker/import).
- [src/app/(app)/settings/_tabs/](src/app/(app)/settings/_tabs/) — the admin settings page, one module per tab. Each tab declares the Setting keys it renders (`<TAB>_TAB_KEYS`) and the page reads only those (an undeclared key is a type error); `TAB_SECTIONS` is in `_tabs/sections.ts`, `CRON_JOBS` in `_tabs/cron-jobs.ts` (`tests/entrypoint.test.mts` reads it there). A server component builds a client form's initial props through a NON-client module (e.g. `discordFormInitial`).
- [src/components/](src/components/) — feature components; primitives under `ui/`. The admin nav is grouped (`ADMIN_NAV_GROUPS` / `NavItem.group` in [nav-items.ts](src/lib/nav-items.ts), rendered by [admin-nav-groups.tsx](src/components/layout/admin-nav-groups.tsx)); `adminNavItems` stays in group order with `/admin` first (the mobile Admin tab opens the first visible item). Collapsed groups are mirrored into the `summonarr-admin-nav-collapsed` cookie ([admin-nav-collapsed.ts](src/lib/admin-nav-collapsed.ts)) so the (app) layout renders them closed on a hard load; display-only, never read for anything else. A page that needs ANY of several flags goes in `NAV_ITEM_ANY_FEATURE_KEYS` — the arr pages need Radarr or Sonarr — and its page must enforce the same gate (`tests/nav-groups.test.mts`).
- [prisma/schema.prisma](prisma/schema.prisma) — every model (User, Account, AuthSession, MediaRequest, Plex/JellyfinLibraryItem, Radarr/Sonarr{Wanted,Available}Item, TVEpisodeCache, TmdbCache, TmdbMediaCore, Issue, IssueMessage, IssueGrab, PlayHistory, ActiveSession, DeletionVote, PushSubscription, Setting, MediaServerUser, TitleSuggestion, RecommendationTitle, …).
- [src/generated/prisma/](src/generated/prisma/) — generated client output. **Never edit by hand.**
- There is **no** `middleware.ts` — Next 16 renamed it to `proxy.ts`. See [src/proxy.ts](src/proxy.ts): per request it runs the CSRF origin check on mutating `/api/*` (the origin rules are ONE module, [trusted-origin.ts](src/lib/trusted-origin.ts), shared with cron-auth's admin-session path, the register route and the boot warning), validates+refreshes the session via `verifyAndRefreshSession` (DB-checked, refusing a token on the wrong transport — guardrail 6h), gates non-public paths (login redirect + admin/issue-admin role checks, plus the ADMIN-only `/api/settings` backstop — guardrail 6a; there is no UA-fingerprint check), and stamps the CSP nonce. There is no NextAuth `authorized()` callback — gating is inline in `proxy()`.
  - The `/api/admin` backstop is PERMISSION-based (`hasAdminAreaAccess`/`proxyAccessDecision`, [admin-access.ts](src/lib/admin-access.ts), shared with the admin layout); `/api/settings` stays exact on the ADMIN role label (`tests/admin-access.test.mts`).
  - Exemptions (public, machine, CSRF-exempt — [proxy-paths.ts](src/lib/proxy-paths.ts)) match exactly and on WHOLE path segments; restrictions fold case, so a mis-cased path can only be refused more.
  - The matcher's router-prefetch skip applies to PAGES only; every `/api` request runs the proxy (`tests/proxy-matcher.test.mts`, through Next's own matcher).
  - When the DB-checked session verify throws, a protected request gets 503 + `Retry-After: 5` (a public path passes through) — never a cleared cookie or a `/login` redirect.

## Core architecture

**Sync orchestrator** — [src/app/api/sync/route.ts](src/app/api/sync/route.ts)
- External-cron entry point, Bearer-authed via `CRON_SECRET` (or admin session).
- Runs the download-policy sync + the Plex and Jellyfin library fetch+write arms *concurrently* via `Promise.allSettled` — and each of those two arms is itself a fan-out over every configured server instance (`getSyncableMediaInstances`, guardrail 35). The Radarr and Sonarr wanted/available refreshes run earlier and are **sequential to each other** (HD+4K fetches parallelize *within* each); there is no separate TMDB "job" here beyond an expired-`TmdbCache` purge near the end.
- One shared `stillPending` snapshot is reused across both sources' marking passes. The "now available" notification fire-exactly-once guarantee is an atomic claim (`claimAvailableNotificationWinners`, an `UPDATE … RETURNING` compare-and-swap on `notifiedAvailable`) — not a plain update — so an item appearing in both libraries in the same run notifies once.
- Parallel Plex+Jellyfin sync, shared `stillPending` snapshot, `recentOnly` for Jellyfin, and batch tx timeouts landed together (the original commit hash cited here, `3dcbd79`, is not reachable in the current squashed history — see the audit note).

**Sync modes**
- **Full sync** — a staged swap, never a delete + chunked `createMany` inside one transaction: the rows bulk-load into `PlexLibraryItemStaging` / `JellyfinLibraryItemStaging` OUTSIDE any transaction, then one short `$transaction` under the source's advisory lock (2001,1 / 2001,2) runs the `serverInstance`-scoped `deleteMany` plus ONE server-side `INSERT … SELECT` — `replacePlexLibraryForInstances` / `replaceJellyfinLibraryForInstances` in [library-staging.ts](src/lib/library-staging.ts), the same helpers the per-source routes' full mode uses (the `TVEpisodeCache` twin is `replaceEpisodeCacheForSource` in [episode-cache.ts](src/lib/episode-cache.ts), which skips the stage-and-swap when Postgres's digest of the source's stored rows already matches the new set — `episodeCacheDigest`; a mismatch or a failed check rewrites as before, and `tests/db/episode-cache-digest.test.mts` proves the JS and SQL digests agree). The inline shape held the whole library's payload inside the 30s `BATCH_TX_TIMEOUT` and exceeded it on a ~9k-title library whenever the pool was busy (P2028 on every run, and a pinned connection starving the poller and crons). Atomicity is unchanged (readers see the old set or the new one). `tests/library-swap.test.mts` pins it. The orchestrator `/api/sync` route does **not** read the body — it always does a full library replace. Multi-server nuance (guardrail 35): every delete is `serverInstance`-scoped, and only the instances whose fetch *succeeded* are replaced — a failed instance's rows are deliberately left intact rather than wiped. A Plex instance whose answer is SHORT with no error is held back the same way when it already holds rows: both types empty, or ONE type with stored rows empty while a selected section of it still exists (mid-scan) or a selected key is gone from the server (Plex gives a recreated library a new key) — `plexHoldReason` ([plex-sync-guard.ts](src/lib/plex-sync-guard.ts)). NEVER hold on a stale key alone: the library pickers keep saved keys they no longer list, so such a hold could never be cleared. Ticking the recreated library, or a Resync after a deliberate removal, clears it; deselecting a library is not held. The `{ "full": true }` body flag is parsed only by the per-source routes `/api/sync/plex` and `/api/sync/jellyfin` (the admin "Resync" button), where `recentOnly = rawBody.full !== true`. The admin Re-sync and Initial DB Fill buttons send one `{ full: true, instance }` per configured server (one after another within a service: locks 2111/2112 are per service) as an admin-only `{ async: true }` background job polled with `GET ?job=` ([library-sync-jobs.ts](src/lib/library-sync-jobs.ts), guardrail 37a); `/api/admin/library-warm` has the same mode. Cron and native callers keep the synchronous answer.
- **recentOnly** (default for Jellyfin) — incremental insert-only, bounded by a 2-hour `MinDateLastSaved` window (`RECENT_WINDOW_MS`). Intentionally wider than `SYNC_INTERVAL=3600s` so one missed run is survivable.
- The episode cache's recentOnly writer is ONE function for both sources, `mergeRecentEpisodesForSource` ([episode-cache.ts](src/lib/episode-cache.ts)): insert-only, its delete scoped to the exact (tmdbId, season, episode) tuples it re-inserts, never a whole tmdbId. A recentOnly Plex resync walks only the shows its window returned, never the whole library.
- **Locks and signals** — the two-key xact locks 2001,n and 2002,n are taken only through `lockLibraryInTx` ([library-staging.ts](src/lib/library-staging.ts)) and `lockEpisodeCacheInTx` ([episode-cache.ts](src/lib/episode-cache.ts)), never re-typed literals. Every Plex walk in `/api/sync` and `/api/sync/plex` takes the advisory lock's signal; a lock that ends the walk writes nothing for Plex (stored rows kept) and the Resync answers its 503 wind-down, never 502 (guardrail 41). A per-source Resync holds its lock until its episode-cache refresh has written (`runResyncHoldingLock` + `hold`, [library-resync.ts](src/lib/library-resync.ts)) — background work a lock must outlive is registered with `hold`, never left detached.
- **Plex show file paths** come only from the type=4 episode listing (`getPlexTVEpisodes`' `episodeFilePathsOut`), written by `patchPlexShowFilePaths`; the walk never probes per show, and a recent-only Resync patches only the shows it inserted.

**Batch writes** — [src/lib/batch-write.ts](src/lib/batch-write.ts)
- `batchCreateMany(tx, rows)` chunks inserts into at most `CREATE_MANY_BATCH = 5_000` rows, fewer for wide rows: `createManyBatchSize` keeps each call under Postgres's 32,766 bind parameters so it stays ONE INSERT (guardrail 23c).
- `BATCH_TX_TIMEOUT = 30_000` — always pass this to `prisma.$transaction(..., { timeout: BATCH_TX_TIMEOUT })` for library-sized writes.

**`isCronAuthorized`** — [src/lib/cron-auth.ts](src/lib/cron-auth.ts), which holds ONLY cron authorization (`isCronAuthorized`, `getCronActor`, `CRON_SYSTEM_ACTOR`) and re-exports nothing else: import the batch-write, library-staging, episode-cache and run-ledger helpers (`cron-history.ts`: `withCronRunRecording`, `cronSkippedResponse`) from their own modules. Accepts an admin session *or* `Authorization: Bearer ${CRON_SECRET}` (compared through `safeCompareStrings`, [safe-compare.ts](src/lib/safe-compare.ts) — the one time-safe string compare). Every sync/cron route funnels through this — touch carefully. Every `/api/cron/*` route is `defineCronRoute` ([cron-route.ts](src/lib/cron-route.ts), guardrail 6).

**arrFetch** — [src/lib/arr-client.ts](src/lib/arr-client.ts) (with `ArrResponseError`, `arrErrorMessageForClient`; import through the [arr.ts](src/lib/arr.ts) entry)
- Shared Radarr/Sonarr HTTP client. 30s timeout, **50 MB** response cap (`ARR_FETCH_MAX_BYTES`), injects `X-Api-Key`, throws `ArrResponseError` on non-2xx, routes through `safeFetchAdminConfigured`.
- Body cap was raised from 10 MB because libraries with >3k movies were being silently truncated. Do not lower it.
- Read an upstream payload as `arrFetch<unknown>` and check what drives logic (validate.ts, `asRecord`/`posInt`). A broken answer takes the caller's "unusable" path — a list read that isn't a list throws, never reads as "empty" or "not in the library". Title lookups by arr id go through [arr-lookup.ts](src/lib/arr-lookup.ts); verified Sonarr series lookups are reused 30 min (`lookupSeriesIdsCached`, misses never — tests reset it with `_resetSeriesLookupCacheForTests`); the queue walk ([arr-queue-cache.ts](src/lib/arr-queue-cache.ts)) is tri-state: past `QUEUE_MAX_PAGES` it is incomplete and an unseen title reads null.
- One read per configured instance goes through `settleArrInstances` ([arr-instance-fanout.ts](src/lib/arr-instance-fanout.ts)); one Radarr/Sonarr path comparison, `comparablePath` ([arr-path.ts](src/lib/arr-path.ts)); the client-safe service name is `arrServiceName` ([arr-service-name.ts](src/lib/arr-service-name.ts)).

**Plex/Jellyfin payloads** — [media-server-payload.ts](src/lib/media-server-payload.ts): an envelope (`MediaContainer`, `QueryResult`, the Sessions array) is checked strictly and a wrong shape is a FAILED read, never empty; item fields use `loose`/`looseList`/`idKey`/`numberish`/`stringRecord`, so one odd field costs that field, not the title. A Jellyfin listing's settled shortfall is remembered process-wide (`knownShortfalls`, [jellyfin-paging.ts](src/lib/jellyfin-paging.ts)), so an unchanged one is read once per sync.

**safe-fetch helpers** — [src/lib/safe-fetch.ts](src/lib/safe-fetch.ts)
- All three helpers resolve the host ONCE per request, FRESH (uncached — the addresses checked are the addresses dialled; ssrf.ts's DNS cache now serves only `resolveToSafeUrl`, the push-subscribe check), require EVERY address to pass the mode's policy, then send the request over `node:http(s)` with a `lookup` that returns only those validated addresses (`pinnedFetch`, `makePinnedLookup`) — the connect cannot be rebound. TLS SNI/cert verification and `Host` keep the original hostname; each request uses its own agent. It keeps fetch's failure modes: undici's 10s connect timeout (TCP + TLS) and 300s idle timeout (headers or body — without it a vanished Plex SSE peer hung until the 22h recycle), and fetch's lenient decoding (sync-flush gzip/br, raw DEFLATE detected under `deflate`, at most 5 content-codings, an unknown coding passes the body raw) — `PINNED_CONNECT_TIMEOUT_MS`, `PINNED_IDLE_TIMEOUT_MS`, `MAX_CONTENT_ENCODINGS`. Exception: with `NODE_USE_ENV_PROXY` + a proxy variable the proxy dials the target, so it falls back to a fresh re-resolve check and `fetch()` by hostname. `tests/safe-fetch-pin.test.mts` pins it.
- The pinned request ALWAYS settles: a throw while building the Response (e.g. a reason phrase with a control character), a 101 upgrade, or a request that closes unreported rejects at once, and the transport watches `signal` itself, so `timeoutMs` and the caller's signal bound the wait for headers (`tests/safe-fetch-pin.test.mts`).
- IPv6 text has ONE parser, [ipv6-parse.ts](src/lib/ipv6-parse.ts) (`ipv6Groups`, zero imports): the SSRF policy, the machine-session IP allowlist and the rate-limit /64 bucket all use it. Never add a second.
- `safeFetch(url)` — full SSRF policy (resolved addresses pinned, blocks RFC1918/loopback/link-local/CGNAT/multicast). For user-supplied URLs.
- `safeFetchTrusted(url, { allowedHosts })` — required hostname allowlist; still runs the DNS-based SSRF check (resolve + per-address public-IP check, `allowPrivate=false`, and the connection is pinned to those addresses, so a DNS rebind to a private address is blocked). For fixed third-party APIs (TMDB, plex.tv, discord.com, ipinfo.io, api.trakt.tv, api.github.com, raw.githubusercontent.com, www.omdbapi.com, api.mdblist.com, api.resend.com).
- `safeFetchAdminConfigured(url)` — runs SSRF policy with `allowPrivate=true` (RFC1918/ULA/loopback OK; link-local + 0.0.0.0 still blocked). For URLs persisted in `Setting` (Radarr/Sonarr/Jellyfin/Plex server).

**Webhook auth** — [src/app/api/webhooks/](src/app/api/webhooks/) (**sonarr, radarr only**)
- There is **no Plex or Jellyfin webhook handler** — those routes were removed. Plex real-time activity comes from the SSE stream ([src/lib/plex-events.ts](src/lib/plex-events.ts)); Jellyfin activity from the 5s play-history poller. Only `radarr/route.ts` and `sonarr/route.ts` exist.
- SHA-256 + `timingSafeEqual` (`safeCompareStrings`, called in each route's own handler) against the stored webhook secret (`radarrWebhookSecret` / `sonarrWebhookSecret` + 4K variants, with a legacy shared `webhookSecret` fallback — `effectiveWebhookSecretFrom` in [arr-instances.ts](src/lib/arr-instances.ts) is that rule; new readers call it).
- The post-import availability poll probes only servers EVERY user can see (the default and unrestricted named instances, `visibleAvailabilityChecks` in [arr-webhook-events.ts](src/lib/arr-webhook-events.ts)); a restricted instance is never probed.
- Accepts either `Authorization: Bearer …` **or** a `?token=…` query param. The query-string fallback is load-bearing — see guardrails.
- No HMAC signature validation; none of these services send one.
- Payload text passed on to admins or outbound agents is cleaned and capped (`manualInteractionTitle`, `arrHealthText`); the invalid-JSON log line names the error only, never the body.
- A grab push that failed leaves a `grabPushRetry:<id>` Setting marker; webhook deliveries sweep them (`retryPendingGrabPushes`, [arr-webhook.ts](src/lib/arr-webhook.ts): markers at least 10 min old, at most one sweep per 5 min) and a marker expires after 24 h.
- The MovieDelete / MovieFileDelete / SeriesDelete cache evictions are verified with the firing instance first, like Download, and NEVER written optimistically: the rows go only when Radarr/Sonarr reports the title gone (or, for MovieFileDelete, its file gone). An unverifiable answer leaves the cache to the next sync. Sonarr's is checked by the payload tvdbId only when a request on that instance stores both ids (Sonarr-sourced), else by Sonarr's tmdb lookup — never vouched by the tvdb→tmdb cache or TMDB (14a).

**Play history** — [src/lib/play-history.ts](src/lib/play-history.ts) (the entry; the code is in the `play-history-*.ts` siblings its header lists)
- `recordCompletedSession()` ([play-history-record.ts](src/lib/play-history-record.ts)) ingests when an `ActiveSession` completes and writes a `PlayHistory` row with full playback metrics (duration, pause, codec, resolution, bitrate, device, IP, etc).
- `measurePlay` caps `playDuration` at the row's wall-clock span (`stoppedAt − startedAt`) — the accumulated `playtimeMs` and the progress fallback alike — so a new row never claims more play time than elapsed. The boot clamp in `docker-entrypoint.sh` stays: it corrects rows written before the cap.
- `getActivityCalendarUncached()` ([play-history-calendar.ts](src/lib/play-history-calendar.ts)) backs the GitHub-style 365-day heatmap in [src/components/admin/activity-calendar.tsx](src/components/admin/activity-calendar.tsx). A `$1` placeholder offset bug in its filtered-query path was fixed. The statistics time zone is now `$1` and the filters start at `$2` (guardrail 19g); the builder numbers them in order — never hard-code an offset.
- The admin history list's GROUPED mode filters CHAINS (`COALESCE(referenceId, id)`, [play-history-list.ts](src/lib/play-history-list.ts), served by [api/play-history/route.ts](src/app/api/play-history/route.ts)): a filter picks whole chains and the aggregates cover every segment of a picked one, so `watched` is chain-level there and segment-level in the ungrouped list and the export.
- A memoized aggregate fan-out goes through `runCapped` with NAMED tasks ([play-history-aggregate.ts](src/lib/play-history-aggregate.ts)), never a positional `Promise.all` tuple. Structural pins on the play-history SQL read [tests/_play-history-source.mts](tests/_play-history-source.mts) (the entry plus every sibling), never one file.
- The live poller ([sync/play-history/route.ts](src/app/api/sync/play-history/route.ts)) is a thin route over [session-poll-plex.ts](src/lib/session-poll-plex.ts) (`planPlexContinuation` is the pure stall/liveness rule), [session-poll-jellyfin.ts](src/lib/session-poll-jellyfin.ts) and the shared sweep in [session-poll-shared.ts](src/lib/session-poll-shared.ts).

**Request decisions** — [src/lib/request-transition.ts](src/lib/request-transition.ts) is the ONE claim → push → settle state machine (pushed / unknown / rolled-back / failed). Every approve/decline path (single PATCH, batch, Discord buttons) claims through it, and every Radarr/Sonarr push of an approval (those, plus auto-approve in `request-create.ts` and `request-bulk.ts`) goes through `pushApproval`. A decision path writes no status and calls no arr add itself (`tests/request-approval.test.mts`). PENDING is announced only for a rollback that LANDED. A content-rating lookup that fails is "unverified": filed, never auto-approved (`ratingCapsVerdict`); a Discord auto-approve role is exactly the global AUTO_APPROVE bit. Status labels come from ONE typed map, `REQUEST_STATUS_LABEL_KEY` ([status-labels.ts](src/lib/status-labels.ts)) — never build `requests.status.${…}` keys.

**"Now available" marking** — every library/arr mark goes through [src/lib/available-marking.ts](src/lib/available-marking.ts) (`markAvailableFromLibrary` / `claimAndAnnounce` / `flipToAvailable`). Callers keep the snapshot read (guardrail 15) and every candidate gate (14a, 35); the module re-reads only the claim flag. Never copy the notify / flip-only / already-notified split into a route again.

**Discord interactions** — every write behind a command or button decides maintenance through `maintenanceRefuses` ([request-gates.ts](src/lib/discord-interactions/request-gates.ts)) or `maintenanceGuard(sessionForUser(…))` when a linked session is in hand — the ADMIN bit of the active linked account, failing closed — never a `role === "ADMIN"` lookup. Personal-list commands get their account through `requireLinkedSiteAccount`, and read commands spend `withinDiscordReadBudget` (bucket `discord-read:<discordId>`) ([reply.ts](src/lib/discord-interactions/reply.ts)). `isDiscordSnowflake` ([discord-guild.ts](src/lib/discord-guild.ts)) is the one Discord-id check outside the settings registry. The plaintext Setting `discordCommandsRegisteredGuild` (`<clientId>:<guildId>` of the last guild registration, `''` after a global one) sits beside `discordCommandsSchemaHash`.

**Settings registry** — a new `/api/settings` key goes in [settings-registry.ts](src/lib/settings-registry.ts) with a required `type`. A sensitive key must also be in `SETTINGS_SENSITIVE_KEYS` (a load-time check throws on drift), and a key named `…ApiKey`/`…Secret`/`…Token` must be of kind `"secret"`. The cache drops a change needs are `effects` on the entry, mapped in the route's `invalidateCaches`; feature flags come from features.ts automatically. A write-only secret field starts EMPTY with the mask only as its placeholder — blank means "keep it", removal is an explicit action, never an input seeded with the mask.

**"For You" recommendations** — [src/lib/recommendations.ts](src/lib/recommendations.ts) + [src/lib/recommendation-graph.ts](src/lib/recommendation-graph.ts) + [src/lib/recommendation-quality.ts](src/lib/recommendation-quality.ts) + [src/lib/server-watch-history-data.ts](src/lib/server-watch-history-data.ts) (the servers' own history + favorites, phase 0 of the warm run). Built from the viewer's own records; cross-viewer co-watching is opt-in (`feature.behavior.forYouCoWatch`, default OFF) — guardrail 40c.

Detail: [docs/architecture/for-you-recommendations.md](docs/architecture/for-you-recommendations.md).

**Request watch grades** — [src/lib/watch-grade.ts](src/lib/watch-grade.ts) (pure rules) + [src/lib/watch-grade-data.ts](src/lib/watch-grade-data.ts) (prisma)

Detail: [docs/architecture/request-watch-grades.md](docs/architecture/request-watch-grades.md).

**Library cleanup** — [src/lib/library-cleanup.ts](src/lib/library-cleanup.ts) (pure rules) + [library-cleanup-data.ts](src/lib/library-cleanup-data.ts) (prisma) + [library-cleanup-arr.ts](src/lib/library-cleanup-arr.ts) (Radarr/Sonarr listing + delete), page `/admin/cleanup` behind `feature.admin.cleanup` (default OFF), ADMIN-only. Rule and exclusion names are the zero-import [library-cleanup-keys.ts](src/lib/library-cleanup-keys.ts) (`CLEANUP_RULES` / `CLEANUP_EXCLUSIONS`); the execute is [library-cleanup-execute.ts](src/lib/library-cleanup-execute.ts).

Detail: [docs/architecture/library-cleanup.md](docs/architecture/library-cleanup.md).

**Never watched** — [never-watched.ts](src/lib/never-watched.ts) (pure verdict) + [never-watched-data.ts](src/lib/never-watched-data.ts) (evidence loader) + [never-watched-report.ts](src/lib/never-watched-report.ts) (report, cache, chip read) + [upstream-watch.ts](src/lib/upstream-watch.ts)/[upstream-watch-data.ts](src/lib/upstream-watch-data.ts) (the media servers' own watch records), page `/admin/never-watched` behind …

Detail: [docs/architecture/never-watched.md](docs/architecture/never-watched.md).

**Watch sync (Plex ⇄ Jellyfin)** — [watch-sync.ts](src/lib/watch-sync.ts) (pure plan) + [watch-sync-data.ts](src/lib/watch-sync-data.ts) (run), page `/admin/watch-sync` behind `feature.admin.watchSync` (default OFF), ADMIN-only. Guardrail 19e.

Detail: [docs/architecture/watch-sync.md](docs/architecture/watch-sync.md).

**Missing** — [src/lib/arr-missing.ts](src/lib/arr-missing.ts) (pure rules) + [arr-missing-data.ts](src/lib/arr-missing-data.ts) (live listings), page `/admin/missing`, ADMIN-only, Sonarr and Radarr tabs.

Detail: [docs/architecture/missing.md](docs/architecture/missing.md).

**Download Queue + Radarr/Sonarr health** — page `/admin/queue`, ADMIN-only. [arr-queue.ts](src/lib/arr-queue.ts) (pure) + [arr-queue-data.ts](src/lib/arr-queue-data.ts); [arr-health.ts](src/lib/arr-health.ts) (pure) + [arr-health-data.ts](src/lib/arr-health-data.ts).

Detail: [docs/architecture/download-queue-radarr-sonarr-health.md](docs/architecture/download-queue-radarr-sonarr-health.md).

**Radarr/Sonarr monitor** — [arr-watch.ts](src/lib/arr-watch.ts) (pure) + [arr-watch-data.ts](src/lib/arr-watch-data.ts), cron `/api/cron/arr-watch` (lock 2051, `ARR_WATCH_INTERVAL`), setting `arrWatchDiskLowPercent` (Settings → Notifications → Radarr/Sonarr alerts, `PATCH /api/admin/arr-watch`). The job is ONE config, `ARR_WATCH_CRON` ([arr-watch-cron.ts](src/lib/arr-watch-cron.ts)), run by the cron route AND by a first, authenticated Radarr/Sonarr webhook delivery ([arr-watch-trigger.ts](src/lib/arr-watch-trigger.ts): in-process, coalesced, runs at least 30 s apart, armed only at boot) — never a second monitor entry point. Each run pushes the admin nav's queue count as a `nav:badges` SSE frame; the Activity count rides `activity:sessions` ([nav-badges.ts](src/lib/nav-badges.ts)).

Detail: [docs/architecture/radarr-sonarr-monitor.md](docs/architecture/radarr-sonarr-monitor.md).

**Request "Pick release"** — `GET/POST /api/requests/[id]/releases` (MANAGE_REQUESTS): interactive search on an APPROVED/AVAILABLE request's own instance, the same projected `ArrRelease` list the Issue "Replace" panel uses.

Detail: [docs/architecture/request-pick-release.md](docs/architecture/request-pick-release.md).

**Request "Why?" status** — `GET /api/requests/[id]/arr-status` (MANAGE_REQUESTS), opened by the "Why?" button on APPROVED rows of the request queue ([request-arr-status.tsx](src/components/admin/request-arr-status.tsx), read on click only). One verdict plus details from the request's OWN instance (tmdbId, mediaType, arrInstance — guardrail 32;

Detail: [docs/architecture/request-why-status.md](docs/architecture/request-why-status.md).

**Issue "Fix file" / Replace file** — one "Fix file" window ([issue-actions.tsx](src/components/admin/issue-actions.tsx); the files read, choices and delete in [issue-fix-options.tsx](src/components/admin/issue-fix-options.tsx), mounted with `key={instance}` so no per-instance state outlives a switch; rules in [issue-fix.ts](src/lib/issue-fix.ts)) in place of the old Refetch / Replace / Replace file buttons: it reads the files on disk (ADMIN), then leads with the fix that can work — delete and get a new copy (`GET/POST /api/issues/[id]/files`, ADMIN-only; rules in [issue-replace.ts](src/lib/issue-replace.ts)), search automatically (`PATCH { refetch }`) or pick a release (`/api/issues/[id]/releases`). ISSUE_ADMIN keeps the search and the release list. The routes and their iOS wire contracts are unchanged.

Detail: [docs/architecture/issue-replace-file.md](docs/architecture/issue-replace-file.md).

**"Open in Radarr/Sonarr"** — every link goes through `GET /api/admin/arr/open` (ADMIN), which resolves the title on click ([arr-links-data.ts](src/lib/arr-links-data.ts)) and 302s to the instance's page for it (Add New for a title it doesn't have). The host is the per-instance `ExternalUrl` setting (the address a BROWSER uses; plaintext, never fetched by the server), else the connection `Url`. Links render for ADMIN only: queue/missing rows, the request queue, and the movie/TV detail pages (instances whose synced cache holds the title — no live call at render).

**Admin arr management** — everything an admin used to open Radarr/Sonarr for, ADMIN-only, read live — each page paints the last answer it got at once and then reloads live ("instant, then live", guardrail 5h). Shared plumbing: [arr-admin.ts](src/lib/arr-admin.ts) (`configuredArrCfg` — a slug is never turned into Setting reads unless the registry lists it, guardrail 32; `enabledArrInstances`;

Detail: [docs/architecture/admin-arr-management.md](docs/architecture/admin-arr-management.md).

**Library match check** — [library-match.ts](src/lib/library-match.ts) (pure rules) + [library-match-data.ts](src/lib/library-match-data.ts), the "Match check" section of Admin → Library (ADMIN; it renders on a one-server deployment too, unlike the Plex↔Jellyfin diff below it).

Detail: [docs/architecture/library-match-check.md](docs/architecture/library-match-check.md).

**Observability** — admin-only `GET /api/admin/debug/arr-state?tmdbId=<id>&type=movie|tv` dumps the whole pipeline: cache rows, `attachArrPending` result, live Radarr/Sonarr check, tvdb→tmdb mapping, total wanted-table counts, and the most recent `LIBRARY_SYNC` audit row. Use this before guessing when a badge is missing.

Detail: [docs/architecture/observability.md](docs/architecture/observability.md).

**Backups** — an export carries a `Schema-Fingerprint-Normalized` header (comments stripped, whitespace collapsed, string literals kept) beside the byte `Schema-Fingerprint`; the import prefers the normalized one, so a comment-only schema edit no longer blocks a restore. NEVER change `computeSchemaFingerprint`'s algorithm: older importers read only that line.

**Logging** — custom `console.error`/`console.warn` wrapper. Namespaced with `[scope]` prefixes. `console.log` success/progress messages were intentionally removed. Silent success is the convention.

**Errors** — API routes return `NextResponse.json({ error }, { status })`, no try/catch wrapper. Shared error classes: `SafeFetchError`, `ArrResponseError`, `BackupCryptoError`, `TmdbHttpError` (read its status through `isTmdbNotFound` — a detail-page 404 never comes from message text). Upstream clients that must tell "failed" from "not found" return `UpstreamResult` (`getSuggestionsResult`/`verifyTmdbMediaResult` in tmdb.ts, `lookupOmdb`); a test that takes TMDB down for every page of a list resets `__resetTmdbBackoffsForTests` in `beforeEach`, or the next test reads the list as empty. React boundaries at [src/app/(app)/error.tsx](src/app/(app)/error.tsx) and [src/app/global-error.tsx](src/app/global-error.tsx).

## Environment

Required: `DATABASE_URL`, `NEXTAUTH_SECRET` (≥32 chars), `TOKEN_ENCRYPTION_KEY` (**exactly 64 hex chars / 32 bytes** — the AES-256-GCM key for all encrypted `Setting.value` / `Account` token fields; checked **first** at boot via `assertTokenEncryptionKey()` and `process.exit(1)` on failure in *every* environment, not just production), `AUTH_URL`, `CRON_SECRET` (≥32 chars), `TRUST_PROXY` (an internet-facing instance must sit behind a trusted reverse proxy with this set to exactly `"true"`; it is also the sole gate on reading `X-Forwarded-For`/`X-Real-IP`. With it set, the app port must be reachable only through the proxy and the proxy must OVERWRITE `X-Forwarded-For` — `trustedProxyStartupWarnings` ([local-only.ts](src/lib/local-only.ts)) says so at every boot and the docker README documents `"127.0.0.1:3001:3000"`; the compose default `"3001:3000"` is deliberately left unchanged). **In production, a blank/non-`"true"` value means LOCAL-ONLY mode and now FAILS CLOSED** — the Host guard it relies on is client-supplied and spoofable, so boot is refused unless the operator explicitly sets `SUMMONARR_ALLOW_LOCAL_ONLY=true`; a *public* `AUTH_URL` is refused either way and the opt-in cannot unlock it. Development never fails. The whole rule set is one pure function, `evaluateLocalOnlyStartup` ([src/lib/local-only.ts](src/lib/local-only.ts)), called from [instrumentation.ts](src/instrumentation.ts) — put changes there, not inline in the boot sequence. This supersedes the former "NEVER exit on a blank `TRUST_PROXY`" rule: the default docker deployment still ships it blank, so `.env.example` and [docker-container/README.md](docker-container/README.md) ship the opt-in alongside it and the Upgrading section calls it out. `TMDB_READ_TOKEN` is functionally required (core browse/search) but is **warn-only** at boot — its absence logs a warning and the app still starts. Every other fail-closed env check calls `refuse(message, "production" | "always")` inside `checkBootEnv` ([instrumentation.ts](src/instrumentation.ts)): each failing check is logged, then `bootRefused` ([boot-refusal.ts](src/lib/boot-refusal.ts)) decides the ONE exit. Never add a `process.exit` of your own; `TOKEN_ENCRYPTION_KEY` stays the only immediate exit.
Optional: `NEXTAUTH_SECRET_PREVIOUS` (verify-only: the old `NEXTAUTH_SECRET` during a planned rotation, so sessions survive it — ≥32 chars, never another secret's value, and never set after a leak; native sessions it signed die when it is removed — guardrail 6h), `OIDC_{ISSUER,CLIENT_ID,CLIENT_SECRET,DISPLAY_NAME}` (who may sign in through OIDC is the Settings → Authentication allowlist, not an env var; changing `OIDC_ISSUER` refuses existing OIDC accounts, which are bound to their issuer — guardrail 34e; and disabling a user at the IdP does NOT end their Summonarr sessions — an admin must also deactivate them, guardrail 33), `SUMMONARR_ALLOW_OAUTH_FIRST_ADMIN`, `SUMMONARR_DISABLE_MFA_ENFORCEMENT` (switches off the "require two-factor for administrators" redirect — guardrail 6d), `SUMMONARR_ALLOW_LOCAL_ONLY` (see `TRUST_PROXY` above — required to run local-only in production), `SUMMONARR_DB_WAIT_SECONDS` (default 60: how long the container's boot waits for Postgres before carrying on), `SUMMONARR_DEFAULT_LOCALE` (`en`|`es`|`fr`|`de`|`pt`|`it`|`zh`, default `en`; a region or script tag (`pt-BR`, `zh-Hans-CN`, POSIX `pt_BR.UTF-8`) is read on its primary subtag (unlike `negotiateLocale`, which skips a Traditional Chinese tag in Accept-Language, `zh-TW` here still means Simplified), and a value naming no supported language falls back to `en` and is warned about ONCE at boot via `instanceDefaultLocaleWarning()` — the fallback UI language and the language of notifications to users with no stored `User.locale`; read per request, deliberately not a Setting — see [server-locale.ts](src/lib/i18n/server-locale.ts)), `TZ` (the server process's zone, UTC when unset: the global request quota's day/week/month windows reset at its midnight — [quota.ts](src/lib/quota.ts) — and it is the statistics time zone unless the `statsTimeZone` setting overrides it, guardrail 19g), `BACKUP_DB_PASSWORD` (≥12 chars), `BASE_PATH`, `AUTH_TRUSTED_ORIGIN`, `TRUSTED_PROXY_HOPS` (default 1), `DELAYED_JOBS_MAX_{PENDING,QUEUE,CONCURRENCY}`, and the cron interval knobs (`SYNC_INTERVAL`, `UPCOMING_SYNC_INTERVAL`, `RATINGS_SYNC_INTERVAL`, `PLAY_HISTORY_SYNC_INTERVAL`, plus `LIST_CACHE_SYNC_INTERVAL`, `WARM_ACTIVITY_INTERVAL`, `WARM_MDBLIST_INTERVAL`, `WARM_OMDB_INTERVAL`, `WARM_RECOMMENDATIONS_INTERVAL`, `WARM_LIBRARY_INTERVAL`, `SCRUB_AUDIT_PII_INTERVAL`, `TRASH_SYNC_INTERVAL`, `PURGE_SESSIONS_INTERVAL`, `PURGE_NOTIFICATIONS_INTERVAL` — default 86400, the notification-inbox purge (lock 2091); `NOTIFICATION_READ_RETENTION_DAYS` (default 90) and `NOTIFICATION_RETENTION_DAYS` (default 365, never below the read value) set what it deletes; minimum 7 days each, ``PLEX_WATCHLIST_SYNC_INTERVAL` — default 1800, the watchlist auto-request poll; a no-op while `feature.behavior.watchlistAutoRequest` is off, `TRAKT_SYNC_INTERVAL` — default 1800, per-user Trakt (guardrail 34c); a no-op until a Trakt client secret is saved and watchlist auto-request or For You is on, `UPSTREAM_WATCH_SYNC_INTERVAL` — default 86400, the media servers' own watch-record snapshot for the never-watched report (guardrail 14d); a no-op while both `feature.admin.neverWatched` and `feature.admin.cleanup` are off, `WATCH_SYNC_INTERVAL` — default 300, watch sync Plex ⇄ Jellyfin (guardrail 19e); a no-op while `feature.admin.watchSync` is off, `ARR_WATCH_INTERVAL` — default 900, the Radarr/Sonarr monitor (guardrail 7c); skipped before its lock while no Radarr/Sonarr instance is enabled and configured; its first tick is ~11 minutes after boot, `ARR_SNAPSHOT_INTERVAL` — default 300, the admin arr pages' background re-reads (guardrail 5h; each view on its page's 5/10/15-minute priority); skipped before its lock while nothing is due; first tick ~5 minutes after boot), `DATABASE_POOL_MAX` (the pg pool size in [prisma.ts](src/lib/prisma.ts), default 5; a whole number 1–100, anything else keeps the default — raise it for a busy install, since syncs and interactive transactions share the pool with web requests), `SSE_MAX_LISTENERS` (default 500; bounds **both** the emitter listener cap and the concurrent SSE connection cap in `/api/events` — intentionally one knob, see [src/lib/sse-emitter.ts](src/lib/sse-emitter.ts)).

Jellyfin is **not** an env var — its server URL + API key are stored as the `jellyfinUrl` / `jellyfinApiKey` Settings, configured in Admin → Settings → Media. Login (standard + QuickConnect), library sync, play-history, fix-match, and server-user admin all read the URL via `getConfiguredJellyfinUrl()` ([src/lib/jellyfin-config.ts](src/lib/jellyfin-config.ts)). There is no `JELLYFIN_URL` fallback.

## Deployment

Multi-stage Docker (`node:26.12.1-alpine3.23`, five stages: deps → prisma-gen → builder → migrate-deps → runner) → standalone Next build, non-root `nextjs` user (UID 1001). Postgres 17-alpine sidecar with `postgres-data` volume. Internal port 3000 → host 3001. The image creates `/data` (app) and `/app/.next/cache` dirs, but neither compose file mounts them as volumes — only `postgres-data` is persisted. There are **no** external `sync-cron` / `upcoming-cron` compose services: the app container runs its **own internal cron loop** (`docker-entrypoint.sh` `_cron_loop` + `_play_history_loop`), POSTing to `http://localhost:3000/api/...` with `Bearer ${CRON_SECRET}` so the secret never leaves the container. Every job's interval default, first run and loop come from one `_CRON_JOBS` table (a serial "main" loop for the heavy jobs; watch-sync, arr-watch and arr-snapshots in a "fast" loop, each still self-excluded by its advisory lock), and play history is polled by one long-lived node process, never overlapping. The image `HEALTHCHECK` is busybox `wget` against `/api/health` (no node), the same probe as the compose files. Each cron job's `*_URL` override may name an https endpoint (the call follows the URL's scheme); the built-in loopback URLs are plain http. `tini` is PID 1; the runner's app tree is root-owned, with only `/data` and `/app/.next/cache` owned by `nextjs` — one more reason the schema-engine binary below must ship, since `db push` can no longer re-download it. Boot waits up to `SUMMONARR_DB_WAIT_SECONDS` (default 60) for Postgres, and reads `/run/secrets/postgres_password` over `POSTGRES_PASSWORD` when present. **Image-size discipline**: the migrate-deps stage prunes the Prisma CLI's dependency tree via [scripts/prune-migrate-deps.mjs](scripts/prune-migrate-deps.mjs) (~250 MB → ~66 MB — studio/dev tooling, mysql2/postgres drivers, typescript, react, etc. are never loaded by `db push`), then a build-time smoke test runs a real `db push` against an unreachable DB and requires the P1001 error — proving the pruned module graph still loads — before the tree ships. **That smoke test runs unconditionally, and it must stay that way — do NOT re-add a cross-build skip.** It was briefly gated on `TARGETPLATFORM == BUILDPLATFORM` because under QEMU the pruned CLI's wasm get-config returns corrupted bytes and reports every line of a valid schema as unparseable, which blocked the v0.25.0 release twice. That was an emulator fault, not an arch or schema one — proven by `--platform linux/arm64 --target migrate-deps` passing on a native arm64 host while the emulated CI build failed identically. **The skip is unnecessary because nothing cross-builds any more**: [docker-publish.yml](.github/workflows/docker-publish.yml) builds each platform on its own native runner (`ubuntu-latest` for amd64, `ubuntu-24.04-arm` for arm64, stitched by `docker buildx imagetools create`), and the security gate + ci.yml's docker build are amd64 on amd64 hosts. Native arm64 went from a **cancelled 3h0m22s** emulated build — GitHub's hard job ceiling, so no `timeout-minutes` could have saved it — to **~3 min**. If you ever reintroduce an emulated leg you will hit the wasm bug again; add a native runner, not a skip. The native `schema-engine-*` binary in `@prisma/engines` MUST stay: `db push` executes it and silently re-downloads it at boot when missing (a boot-time internet dependency; the bundled wasm schema engine is NOT used). The builder stage also strips the glibc sharp/libvips variants (`@img/sharp-*linux-*`) from the standalone output — the Alpine runtime is musl-only, and `outputFileTracingExcludes` does not actually drop them (tested; hence the explicit `rm`).

**Pre-upgrade dump (opt-in).** `docker-entrypoint.sh` `_pre_upgrade_dump` takes a best-effort `pg_dump -Fc` before `db push` only when `SUMMONARR_PRE_UPGRADE_DUMP_DIR` is set and writable AND `prisma migrate diff` shows a pending change (the drop/create pairs Prisma reports on every run for a raw-ops index are ignored — the exact index names in `_PRISMA_DIFF_NOISE`; a new raw-ops `@@index` must be added there, `tests/entrypoint.test.mts` enforces it). It keeps the newest `SUMMONARR_PRE_UPGRADE_DUMP_KEEP` (3), is bounded by `SUMMONARR_PRE_UPGRADE_DUMP_TIMEOUT` (900s) and must NEVER block boot. The runner image carries `postgresql17-client` for it. `SUMMONARR_ACCEPT_DATA_LOSS=true` logs a warning on every boot. Rollback procedure: [docker-container/README.md](docker-container/README.md) "Rolling back an upgrade".

## Releasing — PR-then-tag flow

The project version is duplicated across four files. Drift is the default unless every bump touches all of them in the same commit.

**The git tag is `v<X.Y.Z>`; the published image tag is bare `<X.Y.Z>`. NEVER write a `v` into a `SUMMONARR_VERSION` example.**

- `docker/metadata-action`'s `type=semver,pattern={{version}}` **strips the `v`** ([docker-publish.yml](.github/workflows/docker-publish.yml)), so pushing git tag `v0.20.2` publishes `:0.20.2`, `:0.20`, `:0`, `:latest`, `:sha-<short>` — and no `:v0.20.2`.
- [docker-container/docker-compose.yml](docker-container/docker-compose.yml) interpolates the value straight in: `ghcr.io/summonarr/summonarr:${SUMMONARR_VERSION:-latest}`. A `v`-prefixed value therefore resolves to a tag that does not exist and the pull fails with `manifest unknown`.
- This shipped broken for two releases — `:v0.20.1` and `:v0.20.2` both 404 in GHCR while `:0.20.1` / `:0.20.2` are fine — because this file told you to write the `v`. Verify a pin before documenting it:

```bash
TOK=$(curl -s "https://ghcr.io/token?scope=repository:summonarr/summonarr:pull&service=ghcr.io" | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOK" https://ghcr.io/v2/summonarr/summonarr/manifests/<X.Y.Z>
```

The release flow is **PR-then-tag**: bump versions on `build`, PR to `main`, merge, *then* tag the merge commit on `main`. Tagging before the merge orphans the tag on a feature-branch commit unreachable from `main` — `git describe` breaks, `:v<X.Y.Z>` and `:main` reference different SHAs, and the [docker-publish workflow](.github/workflows/docker-publish.yml) builds the same release twice from two different commits. (`v0.9.1` and `v0.9.2` were tagged this way; both are orphan tags. Don't repeat it.)

### Step 1 — Bump versions on `build`

`<X.Y.Z>` is bare semver; the docker tag form is `v<X.Y.Z>`. Edit all five locations in one commit:

1. [package.json](package.json) — `"version": "<X.Y.Z>"` (root field).
2. [package-lock.json](package-lock.json) — `"version": "<X.Y.Z>"` in **two** places only: the top-level field and `packages.""` (lockfile v3 keeps both; `npm install` will rewrite either if they disagree). **Do not** global-find-replace the old version across this file — common SemVers like `0.1.0` appear inside transitive-dep entries (e.g. `node_modules/yocto-queue`, `node_modules/powershell-utils`) where the `version` field must match the `resolved` URL and `integrity` hash. Edit the two project entries individually.
3. [README.md](README.md) — the `Status: v<X.Y.Z>` line at the top. The project is stable, not beta (since v0.33.0) — don't reintroduce a beta label.
4. [docker-container/README.md](docker-container/README.md) — both `SUMMONARR_VERSION=<X.Y.Z>` examples (env table row and the "Pin to a specific version" code block). **Bare semver, no `v`** — see above.
5. [README.md](README.md) `## Changelog` — **prepend** a new `### v<X.Y.Z>` block above the previous release. Group bullets under `**Added**` / `**Changed**` / `**Fixed**`. Source entries from `git log v<previous>..HEAD --oneline`, surfacing user-visible changes only (skip `chore`, `refactor`, `deps`). Conventional-commit scopes translate cleanly.

```bash
git commit -am "chore(release): v<X.Y.Z>"
git push origin build
```

### Step 2 — PR `build` → `main`

```bash
gh pr create --base main --head build --title "Build" --body "<changelog summary + test plan>"
```

Wait for review and CI. Merge.

### Step 3 — Tag the merge commit on `main`

```bash
git checkout main && git pull
git tag -a v<X.Y.Z> -m "v<X.Y.Z>"
git push origin v<X.Y.Z>
```

### Why this order

- The PR merge fires [docker-publish.yml](.github/workflows/docker-publish.yml) on the `main` push, but the job **deliberately skips** when the push contains a `chore(release):` commit (the `if:` on the `build` job in [docker-publish.yml](.github/workflows/docker-publish.yml)) — the tag push publishes the same SHA, so building here would duplicate ~11 min of work. A *non-release* push to `main` still publishes `:main` and `:sha-<short>`.
- The tag push then runs the only build for the release → publishes `:<X.Y.Z>`, `:<X.Y>`, `:<X>`, `:latest`, and `:sha-<merge>` (bare semver — the `v` is stripped, see above). Expect ~11-15 min: this is a cold multi-arch `linux/amd64,linux/arm64` build, NOT a cache hit off an earlier main-push build, because that one skipped.
- Tag is reachable from `main` — `git describe` works, and `:latest` / `:<X.Y.Z>` / `:sha-<merge>` all reference the same commit SHA.

**NEVER** force-move a published tag (`git push --force origin v<X.Y.Z>`) to fix a misplaced one. Anyone with `SUMMONARR_VERSION=<X.Y.Z>` pinned silently gets new bits on the next pull, and `:latest` re-resolves on `docker compose pull`. Cut a new patch release instead.

There is no version constant in `src/`. Don't add one — `package.json` + the git tag is the source of truth, and a third copy is a third place to forget.

## Guardrails

1. **Next.js 16 is not the Next.js in your training data.** Before editing routing, caching, metadata, `fetch`, server/client boundaries, or anything framework-shaped, read the relevant file under [node_modules/next/dist/docs/](node_modules/next/dist/docs/) (`01-app/`, `03-architecture/`). Do not pattern-match from Next 13/14/15 memory.
2. **Never remove the `?token=` webhook query param.** Sonarr and Radarr webhook UIs have no header field, and both handlers share the same code path. (There are no Plex/Jellyfin webhook handlers — only `radarr` and `sonarr`.) Keep the timing-safe compare — `safeCompareStrings` ([safe-compare.ts](src/lib/safe-compare.ts), the ONE time-safe string compare; no other src file keeps a private sha256 + `timingSafeEqual`), called in the handler itself so `scripts/audit-routes.mts` sees it. Do not "upgrade" to HMAC — the upstream services do not sign requests.
2a. **The webhook token NEVER leaves the server during one-click setup — not in a response, not in an audit row, not in an error the arr echoes back.** `setupArrWebhook` ([arr-health-data.ts](src/lib/arr-health-data.ts)) builds the `?token=` URL itself and writes it straight into Radarr/Sonarr.

    Why:
    - The arr test-POSTs the URL before saving, and its HTTP error text quotes the request URL — token included. Relayed verbatim, the refusal shown to the admin (and logged) would carry the secret.
    - The health report is polled by the browser; a URL in it would put the secret in the RSC/devtools surface the copy-on-click design (`/api/settings/webhook-urls`) exists to avoid.

    Rules:
    - Refusal text goes through `arrValidationMessage`, which masks `token=`. The health GET returns only the verdict (`ok`/`missing`/`tokenMismatch`/`eventsMissing`). The `SETTINGS_CHANGE` audit records the BASE address, never the URL.
    - An instance with no secret gets one generated, create-if-absent (`setting.createMany` + `skipDuplicates`, encrypted by the Prisma extension — guardrail 7a), so two setups racing end on ONE secret instead of the second stranding the first hook's token. The generation is audited the moment it commits, even if the arr then refuses the hook. The default instance reuses the legacy shared `webhookSecret` when it has no own secret, exactly as the handlers resolve it.
    - Setup rewrites only THIS deployment's Connect entry, IN PLACE (PUT), keeping the admin's name, tags and extra events; only the URL and Summonarr's handled events (`WEBHOOK_EVENTS`) are set. Ours is the entry carrying our token, else the one at our address (origin + path), else the ONLY Summonarr entry (a moved host); with two or more Summonarr entries and none ours (another deployment sharing the arr, e.g. staging) it creates its own beside them (`webhookSetupTarget`, [arr-health.ts](src/lib/arr-health.ts)). A blank secret row is filled only while it is blank (conditional update; a P2025 loser uses the winner's).
3. **Schema-first Prisma.** No migrations directory exists. Schema changes are applied with `prisma db push`, then `prisma generate`. Do not scaffold `prisma migrate` workflows.
4. **Bulk writes must use `batchCreateMany` + `BATCH_TX_TIMEOUT`.** Raw `createMany` on library-sized datasets blows transaction timeouts. Always chunk via `batchCreateMany` and pass `{ timeout: BATCH_TX_TIMEOUT }` to `$transaction`. Prisma's timeout never reaches Postgres (it queues a ROLLBACK behind the running statement, which keeps its locks until it finishes), so a transaction that must not overrun can call `setBatchTxTimeouts(tx)` ([batch-write.ts](src/lib/batch-write.ts)) first: Postgres-side statement and lock timeouts, below the 30s. Opt-in only — `lock_timeout` also bounds `pg_advisory_xact_lock` waits, so NEVER use it in a transaction that serializes on an advisory lock. Diagnose a failure with `describeTxFailure` + `txTrace` ([tx-diagnostics.ts](src/lib/tx-diagnostics.ts)): a P2028 names the query that started AFTER the deadline, not the slow one. The recommendation graph's per-page edge write is the user.
5. **Do not lower `ARR_FETCH_MAX_BYTES` (50 MB)** and do not bypass `arrFetch` with bare `fetch` for Radarr/Sonarr calls. The cap exists because large libraries silently truncated at 10 MB.
5a. **Pick the right `safe-fetch` helper.** Never call `fetch` directly for outbound HTTP. Hardcoded third-party URL → `safeFetchTrusted(url, { allowedHosts: [...] })`. URL persisted in `Setting` (Radarr/Sonarr/Jellyfin/Plex server) → `safeFetchAdminConfigured(url)`. URL from end-user input → `safeFetch(url)`. The `allowedHosts` arg on `safeFetchTrusted` is required and exists so a future code change can't accidentally fan that path out to user-controlled hosts.
5b. **Sole allowed direct `fetch` (internal loopback)**: The *only* exception to 5a is the controlled loopback in `src/lib/internal-trigger.ts` (`triggerFullSync`). It is used exclusively by the Plex SSE timeline handler (`plex-events.ts`) to drive a full orchestrator run (`/api/sync`) so that the advisory lock (2000), `withCronRunRecording`, `isCronAuthorized`, and `LIBRARY_SYNC` audit path are identical to an external cron. Target is always `http://127.0.0.1:${PORT}/api/sync` authenticated with `CRON_SECRET`. Update this note (and the helper) if you ever need another internal trigger. All other server HTTP must go through the safe-fetch helpers.
5c. **A queue removal is ONE bulk `DELETE /api/v3/queue/bulk` carrying ONE record id per download (`removalIds`), with every flag sent explicitly.** `removeFromQueue` + `queueRemoveQuery` ([arr-queue-data.ts](src/lib/arr-queue-data.ts), [arr-queue.ts](src/lib/arr-queue.ts)).

    Detail and rationale: [docs/guardrails/5c.md](docs/guardrails/5c.md).
5d. **NEVER send a browser-supplied file path to Radarr/Sonarr's `ManualImport`.** The command's files come ONLY from the arr's own `/api/v3/manualimport?downloadId=` response, re-read when the admin confirms; the paths in the request body only SELECT among those rows (`manualImportFiles`, [arr-queue.ts](src/lib/arr-queue.ts)).

    Detail and rationale: [docs/guardrails/5d.md](docs/guardrails/5d.md).

    Rule index (every rule, with its reasoning, is in the detail file):
    - A correction names IDS; the OBJECTS come from the instance.
5e. **On every admin arr route, a value from the browser is only ever a NAME for something the instance itself reports for that title — and no provider `fields`, history `data`, release guid or upstream credential reaches the browser, a log line or an audit row.** The 5d rule, generalized to the title manager, history, blocklist, calendar and system routes.

    Detail and rationale: [docs/guardrails/5e.md](docs/guardrails/5e.md).

    - An ADMIN GET that starts upstream work (the title release search, the queue manual-import listing) calls `crossSiteRefusal` ([cross-site.ts](src/lib/cross-site.ts)) first: 403 only when `Sec-Fetch-Site` is exactly `cross-site`; an absent header passes. A cost control, never an authorization input.

    Rule index (every rule, with its reasoning, is in the detail file):
    - Facts read from the arrs' own source (2026-10-11) — don't "fix" them back:
    - `ArrResponseError.body` is NON-enumerable, so `console.error(err)` never prints the upstream body (it can quote an indexer apikey). Read `err.body`; never spread or JSON.stringify the error; log `arrErrorMessage(err)`.
5f. **An issue's Replace file deletes ONLY files the instance reports inside the issue's scope, re-read at POST time, and it blocklists with ONE Mark failed per DOWNLOAD.**

    Detail and rationale: [docs/guardrails/5f.md](docs/guardrails/5f.md).

    Rule index (every rule, with its reasoning, is in the detail file):
    - "Unmonitor deleted episodes/movies" is undone, exactly.
    - The async JOIN key is the whole request (issue, instance, `then`, sorted fileIds); the `inFlight` claim stays per issue. NEVER key the join on the issue alone.
5g. **Delegate-facing Radarr/Sonarr status is COARSE: phase, progress, time left, the attention flag, quality names, counts and dates — NEVER an output path, download id, download client or indexer name, release title or arr URL.** `GET /api/requests/[id]/arr-status` is read by MANAGE_REQUESTS delegates, not only admins.

    Why:
    - A queue record carries the output path, download id, client and indexer; a history grab carries the apikey'd download URL (5e); the arr's own status messages quote the output path ("No files found are eligible for import in /downloads/…") and file names.

    Rules:
    - Project through `projectDownload` / `scrubMessage` only: credentials masked by `safeMessage`, the item's own private values removed whole, then URLs, absolute paths and media file names; a line that is only a file name is dropped.
    - Every queue and history record must name the title's arr id (strict `movieId`/`seriesId ===`), so an arr that ignored the query's filter can't leak another title.
    - The verdict never carries a private completeness or release rule: `sonarrSeriesCompletion` (14a) and `missingMovie` are the only ones.
    - A Radarr/Sonarr failure answered to a caller who may be a delegate (`arrError`, `failed[].error`, a job's stored answer, under `src/app/api/requests/**` and `src/app/api/issues/**`) goes through `arrErrorMessageForClient(err, t)` ([arr-client.ts](src/lib/arr-client.ts)): an ArrResponseError gets its status phrase translated (`apiUser.common.arrStatus*`, English byte-identical to `arrErrorMessage`), anything else is a translated phrase by `arrErrorKind`. NEVER `arrErrorMessage(err)` or `err.message` in such a body — a SafeFetchError's message carries the arr's internal URL, host, IP and port. `tests/arr-error-delegate-message.test.mts` pins it.
    - `tests/request-arr-status.test.mts` pins it with a planted-value leak scan (37 mutations, each fails a named test).
5h. **An admin arr page paints its last answer at once and then reads live — and a snapshot is DISPLAY ONLY: nothing that writes ever reads one.** Server: [arr-snapshot.ts](src/lib/arr-snapshot.ts) (`withAdmin(snapshotted(…))` on each admin Radarr/Sonarr READ route); client: [use-arr-snapshot.ts](src/components/admin/use-arr-snapshot.ts) + [arr-snapshot-note.tsx](src/components/admin/arr-snapshot-note.tsx).

    Detail and rationale: [docs/guardrails/5h.md](docs/guardrails/5h.md).

    Rule index (every rule, with its reasoning, is in the detail file):
    - NEVER wrap a read whose answer must not be replayed: release searches (handles are single-use and bound to one search — release-handles.ts), `/api/admin/arr/commands`, rename previews, the Why? status, or anything a non-ADMIN can read.
    - NEVER let a write path read a snapshot, and never base a form's edits on one once a live read has landed (the title manager's Settings form rebases on the live read exactly as on a background re-read; its TAG edits are a delta — `applyTagDelta` in snapshot-rules.ts — never an absolute list, because the PATCH replaces tags).
    - Kept fresh in the background, by priority.
5i. **ALWAYS make a projection over an upstream Radarr/Sonarr list linear AND bounded, whatever the arr sends: dedupe through a `Set` (NEVER `out.some(...)`/`find` in the loop), keep at most an exported cap, and read at most `PROJECTION_SCAN_FACTOR` × that cap of the raw list.** [arr-system.ts](src/lib/arr-system.ts) (`MAX_TASKS`, `MAX_TAG_ENTRIES`, `MAX_ROOT_FOLDERS`, `MAX_DISK_ENTRIES`, `MAX_PROVIDERS`; `projectCommands` reads a FIXED `MAX_COMMANDS_READ`, never derived from its `limit`; `projectFailures` reads `MAX_VALIDATION_FAILURES_READ` and counts an unread rest as an error, so a cut list is never warnings-only), [arr-stats.ts](src/lib/arr-stats.ts) (`diskSpaceEntries`), [arr-history.ts](src/lib/arr-history.ts) (`grabStatesFor`: a list's grab states read ONCE, never per row in render), [arr-title.ts](src/lib/arr-title.ts) (`MAX_CHOICES`, `MAX_ROOT_FOLDER_CHOICES`), [arr-queue.ts](src/lib/arr-queue.ts) (`MAX_MESSAGES`; the import candidates and payloads in [arr-queue-import.ts](src/lib/arr-queue-import.ts), re-exported by arr-queue.ts; its readers, `safeMessage` and the bounded `namesOf` with `MAX_LABELS` and `PROJECTION_SCAN_FACTOR`, come from the zero-import [arr-parse.ts](src/lib/arr-parse.ts), which masks credentials in queue and import text — guardrail 5e; a paged read ends through `pagedReadEnded`: a missing `totalRecords` reads on to a short page, never "total 0 = done"), [arr-calendar.ts](src/lib/arr-calendar.ts) (`MAX_CALENDAR_ENTRIES`, per instance per window), [arr-missing.ts](src/lib/arr-missing.ts) (`MAX_MISSING_ITEMS`, per instance — `missingMovieList`/`missingSeriesList`), [arr-health.ts](src/lib/arr-health.ts) (`MAX_CHECKS`, a bounded read prefix; the webhook URL's trailing slashes are stripped with one scan, never a regex), [issue-replace.ts](src/lib/issue-replace.ts) (the title's history indexed ONCE per listing, `indexReplaceHistory`, never re-scanned per file; nothing read past `MAX_REPLACE_HISTORY`).

    Why:
    - `arrFetch` caps a response only by SIZE: 50 MB is hundreds of thousands of entries. The projections run synchronously on the one event loop — from the arr-watch cron with nobody signed in, the Arr System tabs, the title manager and their snapshot refresh (5h), and the Download Queue fold (`foldQueueRecords`, also run by the arr-watch cron and the MANAGE_REQUESTS Why? status). An `out.some` dedupe was O(n²) and root-folder→disk matching O(roots × disks), so a hostile or MITM'd arr froze the whole process for minutes to hours on every tick; the advisory lock's AbortSignal cannot interrupt synchronous code.

    Rules:
    - The output cap alone is not enough: a list of duplicates or junk never reaches it, so the raw scan is bounded too.
    - The root-folder and disk caps are what keep `rootDisk`/`diskFor` bounded (projectRootFolders and the monitor's readDisks). Never pass those functions an uncapped list. Each disk's path is made comparable ONCE per list (`indexDisks`, then `rootDiskIn`/`diskIn` over that index — no hidden memo), never per (root, disk) pair, through the one path comparison `comparablePath` ([arr-path.ts](src/lib/arr-path.ts)); strip trailing separators with one scan, never a `/\/+$/` regex (it backtracks over a run of separators).
    - A merge that folds records into one row dedupes through a Set too: a Sonarr pack's episodes are keyed `season:episode` (`mergeInto`), because the folded list has no cap.
    - NEVER `x.push(...list)` or `Math.max(...list)`/`Math.min(...list)` over anything an arr sent: a spread throws RangeError past ~125k elements. A paged read appends at most one page's worth per page, one by one (`batch.slice(0, PAGE_SIZE)`); a per-instance merge (`loadCalendar`, the Missing `loadReport`) and a planner (`planSeriesSearch`) append their capped list one by one.
    - `tests/arr-projection-bounds.test.mts` pins every cap, scan bound and Set dedupe without timing (a Proxy counts element reads), and the three paged readers against 200k-record pages.
5j. **An issue's playback context is the reporter's last play, snapshotted at filing, with NO network identifier; auto-resolve closes ONLY on the first claim of a fresh grab, for a movie or a single episode, and never for a season or series.** [issue-playback-context.ts](src/lib/issue-playback-context.ts) (pure) + [-data.ts](src/lib/issue-playback-context-data.ts), [issue-auto-resolve.ts](src/lib/issue-auto-resolve.ts), called from the Radarr/Sonarr Download webhooks.

    Detail and rationale: [docs/architecture/issue-context-and-auto-resolve.md](docs/architecture/issue-context-and-auto-resolve.md).

    Why:
    - The context is a copy of one person's viewing, and the admin needs the client and the decision, not where the reporter was. A season grab matches ANY delivered episode of the season (5f), so its first import does not mean the season is fixed.

    Rules:
    - Identity goes through the shared linkage rule (guardrail 34); bitrate through `bitrateToKbps` source normalization (19a); the transcode reason is stored as recorded and translated at read (19c). Never `ipAddress`, never `location`-level detail beyond lan/wan/relay.
    - An account purge nulls `Issue.playbackContext` on that account's issues (the issues themselves survive, 33).
    - Auto-resolve is a compare-and-swap on OPEN/IN_PROGRESS, audited as `ISSUE_STATUS_CHANGE` with trigger `auto-resolve-replacement` and actor `system`, and sets NO resolution text. It runs only on the webhook's FIRST claim of a grab (never the push-retry path), within 30 days of the grab, and tells the reporter through one deactivatedAt read (33), skipping the admin whose grab landed.
    - `feature.behavior.issueAutoResolve` (default ON) switches it off without touching the grab notifications.
    - The first claim of an `IssueGrab` needs the FIRING instance's own confirmation: a file in the grab's scope (the movie; the grab's episode, season or series) whose `dateAdded` is newer than the grab — `confirmDeliveredGrabs` ([arr-grab-confirm.ts](src/lib/arr-grab-confirm.ts)), asked only when an unclaimed candidate exists. An unreachable or unusable answer claims NOTHING (one retry after the library scan, `retryUnverifiedGrabs`); NEVER claim on the payload alone — a forged or early Download burnt `notifiedAt` for good and closed the issue. A Sonarr grab is checked against its OWN stored tvdbId; without one, only when Sonarr's row names the grab's tmdbId. The push-retry of an already-claimed grab needs no confirmation. `tests/webhook-routes.test.mts` pins it.
    - `tests/issue-playback-context.test.mts` and `tests/issue-auto-resolve.test.mts` pin it; nine mutations each fail a named test.
6. **Route all cron/sync handlers through `isCronAuthorized` (or its actor-returning form `getCronActor`).** Do not re-implement `CRON_SECRET` checks inline. `getCronActor` ([cron-auth.ts](src/lib/cron-auth.ts)) is the SAME chokepoint — `isCronAuthorized` is just `getCronActor(...) !== null` — and returns who is driving the run (`{ trigger: "admin", userId, userName }` or `CRON_SYSTEM_ACTOR`) so a route needing audit attribution reads the session ONCE instead of gating with `isCronAuthorized` and then re-reading it. `scripts/audit-routes.mts` accepts either name as the cron guard. Every single-key advisory lock id is a named export of [advisory-lock.ts](src/lib/advisory-lock.ts) and no caller passes a numeric literal (`tests/cron-routes.test.mts` pins both); a cron answers "no run happened" (busy lock, not configured) only through `cronSkippedResponse`, which the admin cron table shows as a skip, not a run.
    - Every `/api/cron/*` route is `export const POST = defineCronRoute({ target, lockId, timeoutMs?, skipReason?, cacheWarm?, run })` ([cron-route.ts](src/lib/cron-route.ts)); a lock-free cron uses `withCronActor`. A pre-lock "no run" is a `skipReason` string, never a hand-built response. `scripts/audit-routes.mts` accepts both (`CRON_GUARD_TOKENS`); `tests/cron-route.test.mts` pins that they call `getCronActor` first.
    - Two-key TRANSACTION locks (`pg_advisory_xact_lock(ns, n)`) live in Postgres's separate (int, int) space and in their owning modules: 2001,n library swap (`lockLibraryInTx`), 2002,n episode cache (`lockEpisodeCacheInTx`), 2101,n registry saves, 4610 MFA per user, 4611 Trakt per profile, 4620 push registration per user, 4630 issue filing per reporter ([issue-create.ts](src/lib/issue-create.ts) — the duplicate check and insert), 4631 Discord merge per Discord user ([discord-merge.ts](src/lib/discord-merge.ts)). A new namespace takes a number not on this list.
6a. **User-session API routes must wrap their handlers with `withAuth`/`withAdmin`/`withIssueAdmin` from [src/lib/api-auth.ts](src/lib/api-auth.ts).** The wrapper runs the auth check before the handler body and returns 401/403 itself, so the guard can never be forgotten or mis-returned (the failure mode that the older inline `requireAuth(...) + if (session instanceof NextResponse) return session;` pattern allowed). Do not re-implement `auth() + isTokenExpired() + role` boilerplate inline. Callsite:

    Detail and rationale: [docs/guardrails/6a.md](docs/guardrails/6a.md).

    - `npm run audit:routes` counts a bare `requireAuth` as AUTHENTICATION only: an `/api/admin/*` route guarded by it alone fails unless it is listed in `INLINE_GUARDED_ADMIN_ROUTES` ([scripts/audit-routes.mts](scripts/audit-routes.mts)), which also demands that route's own capability check. NEVER re-add a whole-subtree allowlist entry for a session-routed prefix: `discord/` used to be one, so a new route there shipped ungated. Only `/api/interactions` (Discord-signed) is allowlisted.
    - A long-lived stream re-runs EVERY connect-time gate on its re-auth tick, not only the session read: `/api/events` re-runs `maintenanceGuard` on the refreshed session and closes on refusal. A delegate-reachable admin read that makes a live upstream call or a full recompute per request (`server-users/diagnose`, `users/[id]/watch-grade`) is rate-limited per caller before any work.
    - `/api/settings` (the bare route and its subtree) is a STRICT admin prefix (`STRICT_ADMIN_PREFIXES` in the audit): every handler there must be `withAdmin`, and the proxy 403s every non-ADMIN role on it — stricter than the `/api/admin/` backstop, which must admit MANAGE_* delegates and is PERMISSION-based (`hasAdminAreaAccess`, [admin-access.ts](src/lib/admin-access.ts) — no route admits by the ISSUE_ADMIN label alone). The settings gate mirrors `withAdmin` exactly (`hasRole` on the role label; the ADMIN bit alone is refused, `tests/admin-access.test.mts`), so a weaker wrapper on a settings route fails CI and would still be refused for everyone but an ADMIN at the proxy. Admitting a delegate there means changing the wrapper, the backstop, the list and both pins (`tests/proxy.test.mts`, `tests/audit-routes-parser.test.mts`) together, on purpose.
6b. **Session auth is dual-transport: HttpOnly cookie (web) OR `Authorization: Bearer <session-jwt>` (native/mobile clients).** Added for the iOS app (Phase 0). The bearer token is the *same* session JWT the cookie carries — there is no separate token type.

    Detail and rationale: [docs/guardrails/6b.md](docs/guardrails/6b.md).

    Rule index (every rule, with its reasoning, is in the detail file):
    - Every session reader resolves bearer-FIRST, then cookie.
    - CSRF Origin check skips when the request is bearer/native — sound only because a token is refused on the transport it wasn't minted for (guardrail 6h). There is no UA-fingerprint check.
    - The session JWT reaches a native client ONLY via the sign-in response body, ONLY when the client sends `X-Summonarr-Client`.
    - OIDC has a SECOND, native-only path, and the two must not be crossed.
    - No refresh for bearer clients
    - That forbids handing the CLIENT a new token; it does NOT forbid the server-internal forwarded-header rewrite, which is REQUIRED for both transports.
    - A privilege change ROTATES the session only where the replacement is delivered: the cookie transport through the proxy, `withAuth` and `/api/auth/me` (`allowRotation: !bearer`). Bearer requests, `requireAuth()` and the server-component readers pass `allowRotation: false`, and rotation never stamps the per-user `sessionsRevokedAt` cutoff.
    - The 10s `dbCheckedAt` window follows the token's PERMISSIONS (`recheckIntervalSeconds`): the ADMIN bit or any management bit gets it, as do the ADMIN/ISSUE_ADMIN labels; everyone else gets 60s. NEVER key it on the role label alone — a role=USER delegate kept a cleared management bit for up to 60s.
6c. **A session lives until its sign-in deadline — nothing shortens it, nothing caps it, and a native session has no deadline at all.** `verifyAndRefreshSession` rejects a token past the `expiresAt` claim and otherwise re-signs with `exp` AT that claim; `initializeTokenOnSignIn` sets the claim to the admin-configured desktop/mobile/remember-me duration for browsers and to `NEVER_EXPIRES_AT_SEC` ([session-lifetime.ts](src/lib/session-lifetime.ts)) for a caller presenting `X-Summonarr-Client`.

    Detail and rationale: [docs/guardrails/6c.md](docs/guardrails/6c.md).

    Rule index (every rule, with its reasoning, is in the detail file):
    - Never reintroduce an inactivity window or a role-based ceiling
    - "Never expires" is a sentinel deadline, NOT an absent claim.
    - The only housekeeping allowed to delete an `AuthSession` row is the `expiresAt < now` sweep
6d. **For a LOCAL-CREDENTIALS account with two-factor, a correct password NEVER mints a session — only a challenge. The session is minted ONLY by `POST /api/auth/sign-in/mfa`, through the same `signInAndMintSession` + `buildSignInResponse` as the password path.** Libraries in [src/lib/mfa/](src/lib/mfa/); the password-step branch is `mfaChallengeFor` ([signin-challenge.ts](src/lib/mfa/signin-challenge.ts)).

    Detail and rationale: [docs/guardrails/6d.md](docs/guardrails/6d.md).

    Rule index (every rule, with its reasoning, is in the detail file):
    - The factor ROWS are the only source of truth for "has 2FA"
    - An account WITHOUT 2FA gets a byte-identical password response.
    - The challenge token can never be a session.
    - Claim the challenge BEFORE touching the factor.
    - Second-factor guessing is bounded PERSISTENTLY
    - Every "use once" is a conditional UPDATE whose row count decides, never a read-then-write
    - WebAuthn is hand-rolled on purpose
    - Every enrollment CHANGE takes the current password
    - Once a factor is ACTIVE, every enrollment change ALSO needs a fresh second factor
    - Admin reset
    - Recovery-code writes serialize per user
    - "Prompt administrators to set up two-factor"
    - Native/iOS
6e. **A rate-limit bucket that bounds guessing ONE account's secret (a password, a second-factor code, a step-up password) MUST use a key prefix in `PROTECTED_PREFIXES` ([rate-limit.ts](src/lib/rate-limit.ts)). Those buckets are never evicted while they hold live hits.**

    Why:
    - The shared limiter is LRU-bounded at 100k keys, and a FULL bucket is never touched again (a refused attempt records nothing), so it drifts to the front of the eviction order. Minting ~100k cheap keys on any anonymous endpoint evicted a victim's `login-email:` bucket and handed back a fresh 50 password guesses, repeatably.
    - The per-account `mfa-user:` bucket used to be charged for passkey attempts too. Junk assertions filled it and blocked the owner's real passkey, which breaks 6d's "a passkey still works during a lockout".

    Rules:
    - Protected buckets live outside the shared map, split by KEY CLASS into process-wide maps: `login-email:` alone, `jellyfin-user:` alone, and one map for the user-id-keyed prefixes (`mfa-user:`, `profile-password:`, `profile-delete:`, `sessions-delete:`, `mfa-stepup:`, `mfa-totp-enable:`, `step-up-pw:`). When a class is full of live buckets, a NEW key in THAT class is refused (fail closed); a live bucket is never evicted to make room, and no other class is affected.
    - Why the split: `login-email:` and `jellyfin-user:` are keyed on whatever email or username was TYPED, so an anonymous flood of made-up ones fills its class. In one shared map that refused every signed-in user's session revocation, step-up, 2FA enable and password change. Every prefix names its class in `PROTECTED_PREFIXES` ([rate-limit.ts](src/lib/rate-limit.ts)); an anonymously mintable prefix gets a class of its own, NEVER the user-id class.
    - Never add a cheap, attacker-mintable key (per-IP, per-secret, per-pin) to the list, or a flood fills the protected map instead.
    - `mfa-user:` is charged for CODE methods only (TOTP, recovery). Passkey attempts are bounded by the per-IP limit and the per-token failure cap.
    - `jellyfin-user:` is reserve-and-refund like `login-email:` (`reserveRateLimit` + `refundHit`, [auth-jellyfin.ts](src/lib/auth-jellyfin.ts)): it keeps only WRONG passwords, never an unreachable server or a success.
    - `tests/rate-limit.test.mts` pins each call site's literal prefix to the list, so a renamed key fails it; it and `tests/rate-limit-classes.test.mts` pin that filling one class refuses no other.
6f. **The admin "Connect Plex" PIN is created AND polled under a per-attempt random client identifier that lives only in the signed HttpOnly connect cookie, bound to the admin who started it. NEVER the shared `PLEX_CLIENT_ID`, and never a pin id taken from the request.** [plex-flow-state.ts](src/lib/plex-flow-state.ts) (`signPlexConnectCookie`), [/api/auth/plex/pin](src/app/api/auth/plex/pin/route.ts).

    Why:
    - plex.tv hands a PIN's authToken to whoever presents the pin id and the client identifier that created it, with no code and no secret. `summonarr-server` is identical in every install and public in the source, and the old poll took any `?id=`, so anyone could poll recent pin ids and collect an admin's Plex OWNER token.

    Rules:
    - `POST` creates the PIN and sets the cookie. `PATCH` polls the cookie's pin and stores the token server-side through `savePlexAdminToken` ([plex-admin-connect.ts](src/lib/plex-admin-connect.ts)). The owner token never reaches the browser.
    - The cookie is signed with the `"plex-connect"` purpose subkey ([signing-keys.ts](src/lib/signing-keys.ts), via `signPurposeJwt`) with its own `typ` and audience, never the raw session key — so it honours `NEXTAUTH_SECRET_PREVIOUS` like the other flow tokens.
    - `tests/auth-signin-routes.test.mts` pins each leg from the attacker's side.
6g. **A password change or "sign out everywhere" must leave a session hijacker NOTHING that outlives the sessions. Anything a session can plant that would survive (a linked Discord account, a Trakt connection) needs a step-up to plant, and every step-up password draws on ONE audited per-account budget.** [step-up-auth.ts](src/lib/step-up-auth.ts), [session-footholds.ts](src/lib/session-footholds.ts), [account-security-notify.ts](src/lib/account-security-notify.ts).

    Why:
    - A password change and sign-out-everywhere ended the sessions but left push registrations, pending Discord link and merge codes and (sign-out-everywhere) the calendar feed URL. Linking Discord and connecting Trakt needed only a session, so a hijacker could link THEIR accounts and keep approving, requesting and receiving pushes as the owner after the owner's compromise response.
    - Every step-up route had its own password bucket and never audited a miss, so a stolen session could test passwords at ~11 a minute across them.
    - Restoring a backup brought back every session revoked since it was taken, and native tokens never expire (6c).

    Rules:
    - Password change and revoke-all (both modes) delete PushSubscription, DiscordLinkToken and DiscordMergeCode rows AND the pending notification-email verifications (VerificationToken `notif-email:<id>:` — the confirm link is public, so a hijacker's pending link could be confirmed after the sign-out) in the SAME transaction (`footholdDeletes` / `clearSessionFootholdsInTx`) and clear the calendar token. Then they email the owner, listing what is still connected. A redeemed Discord link and a Trakt connection are NOT removed; listing them is the defence. The web bell re-sends its browser subscription once per page load (`resync: true`) and the iOS app re-registers after sign-in, so the owner's own devices come back.
    - A resync only RESTORES a row that wipe deleted. An endpoint removed ON PURPOSE (the profile's Remove device, per-user cap eviction) is tombstoned in `PushSubscriptionRemoval` (endpoint hash only, newest 50 per user) and its resync answers 410. NEVER write a tombstone from `clearSessionFootholdsInTx`: a password change would then unsubscribe the owner's own browsers for good. Every registration write runs under the per-user lock (4620, hashtext(userId)) — [push-registration.ts](src/lib/push-registration.ts).
    - A registration write is NEVER an upsert by endpoint: an owner-scoped `updateMany`, then a `create` as the transaction's LAST statement whose P2002 propagates and is answered 409 outside it (23). The lock is per user, so an upsert's update branch could rewrite another account's keys.
    - A route that PLANTS something which outlives the sessions (`generate-link`, `initiate-merge`, the Trakt device start) also needs a FRESH second factor on an account with an active one: `requireStepUpSecondFactor` ([step-up-second-factor.ts](src/lib/step-up-second-factor.ts)), called directly after `requireStepUp` passes and before anything is minted, stored or sent. Same `secondFactor` field and `400 { error, secondFactorRequired, methods }` as 6d/6i; "has a factor" is the factor rows, and a failed lookup is a 500. The native exemption of `initiate-merge` covers both halves. `tests/discord-routes.test.mts`, `tests/trakt-device-route.test.mts` and `tests/step-up-auth.test.mts` pin it.
    - Every step-up password goes through `verifyStepUpPassword`: the protected `step-up-pw:` bucket (6e), a refund on success, `AUTH_LOGIN_FAILED` `reason: "step_up_password"` on a miss. `tests/step-up-auth.test.mts` scans `src` for any other `verifyPassword(` caller (sign-in in [auth-credentials.ts](src/lib/auth-credentials.ts) excepted).
    - The failed guess that FILLS the `step-up-pw:` budget mails the owner (`step-up-locked`) ONCE per window: `claimSignInLockoutNotice` under the bucket's key, then `void notifyStepUpLockout` — the 6i sign-in notice's shape. Raised by the failed verify only, NEVER by a refusal; a correct password sends nothing; verdict, response and timing are unchanged. It SURFACES, but does not close, the lockout a hijacked session can sustain by trickling wrong passwords (the per-route `sessions-revoke-all:` / `sessions-delete:` / `profile-password:` buckets block the owner too); closing it needs per-session failure buckets — deliberately deferred.
    - `requireStepUp` (password, or an SSO sign-in younger than 5 minutes) guards `generate-link`, the Trakt device start, `initiate-merge` and `POST /api/profile/notification-email` (before its send budget) for WEB sessions. A native session is exempt there because the shipped app has no prompt (guardrail 25) — the iOS app calls the notification-email route too, so that exemption is a wire contract. "Native" is `isNativeSessionForStepUp(session, req)` (async — ALWAYS `await` it: a bare call in `if (!…)` tests a Promise and exempts everyone; `tests/step-up-auth.test.mts` scans for it), decided by what was fixed at sign-in: the never-expiring sentinel deadline, OR a session that arrived as a bearer whose AuthSession row spans more than `MAX_CONFIGURABLE_SESSION_SECONDS` (`expiresAt - createdAt`, both written once at sign-in) — the 1-year native TTL from before 6c. NEVER read it off the token's iat: the proxy re-signs every bearer request with iat = now, so in a token's last 90 days `deadline - iat` looks like a browser's. The bearer requirement exists because v0.13.7–v0.13.8 gave a mobile BROWSER with "remember me" the same 1-year span. NEVER the transport or the `X-Summonarr-Client` header: a stolen browser cookie replayed as a bearer token, or sent with the header, is still a web session. The notification-email route PEEKS its 3-per-15-minute send budget before the step-up, so a spent budget refuses without a scrypt verify, and spends it only after the step-up passes.
    - Every completed Discord link (`mergeDiscordIntoWebAccount`, the one chokepoint for `/link` and confirm-merge) is audited and mailed to the owner after the commit, and spends its one-time code INSIDE the merge transaction (`claimCode`, a required option: a conditional delete whose count decides). NEVER consume the code before the merge (a transient failure burns it) or after it (two concurrent redemptions both link — an unbound `/link` token typed by two Discord accounts linked the account twice).
    - A pending link code is stored as its SHA-256 ONLY (`DiscordLinkToken.token`, [discord-link-token.ts](src/lib/discord-link-token.ts)), and `/link` looks the row up by the hash of what was typed — NEVER by the typed value, which would let a value read from the DB or a backup redeem it. A code minted before this shipped (plaintext in that column) therefore fails once and the user generates a new one; it expires within 10 minutes. `tests/discord-link-token.test.mts` scans every `discordLinkToken` query that names the column.
    - A pending confirm-merge code (`DiscordMergeCode.code`) is stored as an HMAC under the `discord-merge-code` signing purpose ([discord-merge-code.ts](src/lib/discord-merge-code.ts)), binding the user and the Discord id — NEVER a plain hash: it is only 48 bits, so a hash read from the DB or a backup could be brute-forced inside the window. A pre-upgrade plaintext row reads as expired (deleted, "request a new code"), never compared.
    - Self-delete (`DELETE /api/profile`) of an account with no local password needs the same recent-sign-in proof on a web session (a sign-in within 5 minutes, else `401 session-too-old`); native sessions are exempt, as above.
    - A DB restore deletes every AuthSession row and stamps every user's `sessionsRevokedAt` inside the restore transaction (backup-import.ts).
      The ONE exception is the first-run setup restore with the operator's explicit "keep sessions" opt-in (`X-Restore-Keep-Sessions: true`, `keepsSessions(mode, opts)` in backup-import.ts) for a transfer to a NEW server: it skips both writes. It counts only in `setup` mode — the admin restore routes never read it and always wipe — it defaults off, is never stored, needs a second acknowledgement in the setup panel, and is audited as `keepSessions` on `BACKUP_IMPORT`. Kept sessions verify only under the same `NEXTAUTH_SECRET`, and anything signed out or revoked after the backup works again. `tests/setup-keep-sessions.test.mts` and the keep-sessions block of `tests/backup-import.test.mts` pin it.
    - Boot refuses NEXTAUTH_SECRET, CRON_SECRET and TOKEN_ENCRYPTION_KEY sharing a value (`secretReuseError`, [boot-secrets.ts](src/lib/boot-secrets.ts)).
    - A user's quota counts what they requested AND what they filed on others' behalf (`MediaRequest.filedBy`, `quotaUsageWhere` in [quota.ts](src/lib/quota.ts)). Every quota counter uses it; `tests/quota.test.mts` fails on an inline one.
    - The CLI reset (`scripts/reset-password.mjs`) mirrors the in-app change: 12-character minimum, both cutoffs, AuthSession rows, calendar token, footholds (PushSubscription, DiscordLinkToken, DiscordMergeCode, and the pending `notif-email:<id>:` VerificationToken rows by exact prefix, never LIKE), and `--admin` sets permissions with the role.
    - Every NATIVE sign-in (the never-expiring deadline, 6c) emails the owner "app signed in" with the device label, from `signInAndMintSession` ([auth-session-mint.ts](src/lib/auth-session-mint.ts)) after the AuthSession row exists — best-effort, never awaited. A browser sign-in sends nothing, whatever its UA. `tests/auth.test.mts` pins it.
6h. **A session token is bound to the transport it was minted for and refused on the other; every signing purpose has its own HKDF subkey of `NEXTAUTH_SECRET`; and the User-Agent is NEVER an authorization input.** [session-jwt.ts](src/lib/session-jwt.ts) (`boundTransport`, `isTransportAllowed`, `verifySessionToken`), [signing-keys.ts](src/lib/signing-keys.ts).

    Detail and rationale: [docs/guardrails/6h.md](docs/guardrails/6h.md).

    Why:
    - The bearer and the cookie carried the same JWT, so a stolen browser cookie replayed as `Authorization: Bearer` skipped every cookie-only defence (6b's CSRF skip, the cron same-origin gate, privilege-change rotation), and a never-expiring native token could be planted as a cookie.
    - The raw `NEXTAUTH_SECRET` signed sessions, flow cookies, OIDC state, request tokens and the PlexTokenCache HMAC, so one purpose's MAC was valid for all of them; and changing it signed everyone out, so it was never rotated.
    - The UA-fingerprint check compared a header the client writes. It stopped no replay and signed real users out when a browser's UA changed.

    Rules:
    - The mint stamps `transport` (`"bearer"` iff the caller sent `X-Summonarr-Client`, the same signal as the never-expiring deadline; the machine session is `"cookie"`), and `buildSignInResponse` delivers the token ONLY on that transport: no session cookie for a native sign-in.
    - Every reader passes the transport the token ARRIVED on — `verifyAndRefreshSession(token, { transport })` (a required option) or `verifySessionJwt(token, transport)` — and the refusal precedes any DB read. The re-sign stamps the arrival transport into a pre-claim token.
    - A pre-claim token is INFERRED, never signed out: `dbCheckedAt` ⇒ cookie, a deadline more than `MAX_CONFIGURABLE_SESSION_SECONDS` (90 days) past `iat` ⇒ bearer, otherwise either. Keep that constant equal to the settings route's `MAX_SESSION_SECONDS`.
    - New signing needs a PURPOSE in `signing-keys.ts`, never a direct `NEXTAUTH_SECRET` read. Every JWT has its own `typ`, audience and `kid`; an unknown or missing kid is refused.
    - The two-factor flow tokens (`mfa-signin`, `passkey-register`, `mfa-stepup`) are signing purposes too; [mfa-token.ts](src/lib/mfa/mfa-token.ts) derives no key. The one hand derivation left is `pwvKey` in mfa-store.ts, an HMAC fingerprint, not a signer.
    - `NEXTAUTH_SECRET_PREVIOUS` is verify-only and forces the slow path, so browsers re-sign onto the new key at once. Native tokens are never re-issued: removing the previous secret signs out every iOS session it signed. After a LEAK, rotate WITHOUT it.
    - The legacy raw-key session path stays for native tokens minted before this change, accepted only in its legacy shape (no kid, typ "JWT", no audience, no transport claim) and never as the current key. Short-lived flow and request tokens switched with no fallback.
    - Nothing compares the `uaFingerprint` claim with the request; it is informational. A response that appends a refreshed session cookie is `private, no-store` (`markSessionResponseUncacheable`).
    - `tests/session-transport.test.mts` and `tests/signing-keys.test.mts` pin it, with the reader wiring in each reader's own suite.
6i. **A password hash records its own cost (`scrypt:2:<ln>:<r>:<p>:<salt>:<key>`, written at OWASP's N=2^17, r=8, p=1), every verify does the work of a current one, and every scrypt call goes through the process-wide hash slot. On an account with two-factor, a password CHANGE also needs a fresh second factor.** [password-hash.ts](src/lib/password-hash.ts), `authorizeWithCredentials` in [auth-credentials.ts](src/lib/auth-credentials.ts), [profile/password](src/app/api/profile/password/route.ts), [account-security-notify.ts](src/lib/account-security-notify.ts).

    Why:
    - `scrypt:1` stored no parameters, so its 2^15 cost could never be raised without breaking every stored hash.
    - Raising the cost made a legacy hash 4× cheaper to verify than the unknown-account dummy, so response time alone would have told which emails have an account.
    - scrypt runs on libuv's 4-thread pool, shared with file reads, `dns.lookup` and zlib, and each 2^17 derivation takes 128 MiB. An unbounded burst of sign-ins stalls unrelated requests and can OOM a small container.
    - A session from a phishing relay of the password plus ONE code could set a password the owner doesn't know. The password alone is exactly what the relay holds.
    - An exhausted per-account sign-in bucket also refuses the owner, with nothing to tell them why.

    Rules:
    - `verifyPassword` reads the parameters FROM the hash (bounded on read: 2^14–2^20, r ≤ 16, p ≤ 4, ≤ 256 MiB) and still accepts legacy `scrypt:1` at 2^15/8/1. A verify against a cheaper hash runs padding derivations at the stored parameters, so its work equals one at `SCRYPT_PARAMS`; `dummyVerify` uses `SCRYPT_PARAMS`, and an UNPARSEABLE stored hash also pays a dummy verify. The dummy hash is warmed by the first hash/verify or at boot (`warmPasswordHashing`, called from instrumentation.ts), never at import. `tests/password-hash.test.mts` pins equal work with `scryptWorkDone()`.
    - `authorizeWithCredentials` rehashes (`needsRehash`) after a successful verify. The rehash is AWAITED, because the 2FA challenge's `pwv` fingerprints the stored hash and a later rehash would kill the challenge. It is a CAS on the verified hash and touches neither `passwordChangedAt` nor sessions.
    - At most `MAX_CONCURRENT_HASHES` (2) derivations run at once: `withHashSlot`, a `processSingleton` (27a), FIFO, unbounded queue (refusing a verify would turn a flood into a lockout of real users). Never call `scrypt` outside it.
    - The standalone CLI copies (`scripts/reset-password.mjs`, `create-user.mjs`, `e2e-seed.mts`) keep their hashing between the `>>> password-hash` / `<<< password-hash` markers. The test runs each block and checks its output with the app's `verifyPassword` and `needsRehash`.
    - `PATCH /api/profile/password` on an account with an active factor needs `secondFactor` through `mfaSecondFactorStepUp`, checked AFTER the password verified so a wrong password never burns a code. Same body and `400 { error, secondFactorRequired, methods }` as enrollment (6d). There is NO native exemption: the native kind is chosen by whoever signs in, so a relay would just send `X-Summonarr-Client`. Without 2FA the route is byte-identical.
    - The shipped iOS app's ChangePasswordView sends no `secondFactor`. For a 2FA account it gets the 400 and shows `error`, which tells the user to change the password on the website. `API_VERSION` is not bumped: the signal is reactive, as in 6d. The iOS fix is to show its existing StepUpSheet on `secondFactorRequired`.
    - A full `login-email:` bucket mails the owner (`sign-in-locked`) ONCE per window per account: `claimSignInLockoutNotice` (synchronous, process-wide) then `void notifySignInLockout`. It fires from the failed verify that spends the last guess, where the row is already loaded, NEVER from a refusal, so a refused attempt still reads nothing from the DB (`tests/auth.test.mts`). Live local-password accounts only. The caller's response and timing are unchanged.
6j. **When the hourly Jellyfin user sync marks an identity inactive (removed from the server, or DISABLED on it), the account that signs in AS that identity (`User.jellyfinUserId`) is signed out everywhere — but only once the identity is gone from EVERY configured Jellyfin server, never for an ADMIN, and never by deleting anything.** [jellyfin-offboarding.ts](src/lib/jellyfin-offboarding.ts), called from `syncDownloadPolicies` ([download-policy.ts](src/lib/download-policy.ts)).

    Why:
    - Jellyfin refuses a removed or disabled account's sign-in, but the Summonarr session it already held kept working: a browser's until its deadline, the iOS app's forever (6c).

    Rules:
    - A disabled user (`Policy.IsDisabled`) is written `active: false` by the sync itself — the server's explicit answer, so the shrink guard doesn't apply; re-enabling re-activates the row (28: soft only).
    - "Still a member" is any ACTIVE jellyfin `MediaServerUser` row, on any server, that carries the id or is linked to the account (35: the union fails open).
    - A configured server whose `/Users` fetch failed or came back EMPTY this run and that has never stored a user is INDETERMINATE and holds every identity back. A server with stored rows is stale, not indeterminate.
    - ADMINs (role or bit) are exempt, decided on a fresh read under advisory lock 42 inside `revokeAllUserSessions`' own transaction. The revoke is audited as `SESSION_REVOKE` (`reason: "jellyfin_offboarded"`, actor `system`).
    - Offboarding acts on the active→inactive TRANSITION. The pending ids live in a process-wide ledger (27a) and leave it only once decided, after the revoke commits (27), so a failed revoke or an indeterminate run retries next hour. A restart forgets the ledger.
    - Each id enters the pending ledger the moment its inactive write commits (`noteJellyfinDepartures`), NEVER at the end of the run: the next run reads the row as already inactive, so a run that throws later would drop the departure for good.
    - `tests/download-policy.test.mts` pins every rule; each is mutation-verified.
7. **No success logs.** `console.error` and `console.warn` only, namespaced with a `[scope]` prefix. Silent success is the convention. Do not add `console.log` for happy-path events.
7a. **NEVER call `encryptToken` at the call site for `Setting.value`, `Account.{access_token,refresh_token,id_token}` or `UserTotp.secret`.** The Prisma extension handles encryption on every write to those fields and decryption on every read: it lives in [src/lib/prisma-crypto.ts](src/lib/prisma-crypto.ts) (one handler factory, `columnCryptoHandlers`, so a new protected column model is one entry in `cryptoQueryExtension`; tests call the handlers through `tests/_crypto-handlers.mts`), and [src/lib/prisma.ts](src/lib/prisma.ts) only wires it in. prisma-crypto.ts is the extension's own `encryptToken` caller, not one of the call sites below. Pre-encrypting at the route, sign-in/OIDC, or library layer produces double-encrypted rows of the form `enc:v1:<enc:v1:…>` — on read the extension decrypts once and hands callers the inner ciphertext, which then gets sent as an API key/token to upstream services and fails auth. This bug shipped in `bc81802` (a route-level pre-encryption in `/api/settings` and an `encryptingAdapter` wrapper in `auth.ts`); both were removed afterward. The remaining legitimate `encryptToken` callers are: `PushSubscription` writes ([push/subscribe](src/app/api/push/subscribe/route.ts) and [push/apns](src/app/api/push/apns/route.ts) — the latter encrypts the APNs `deviceToken`; the extension does not cover that table. That row's UNIQUE `endpoint` is a domain-separated SHA-256 of the token (`apnsEndpointFor`, [apns-endpoint.ts](src/lib/apns-endpoint.ts)), NEVER the token: the old `apns:<token>` handle kept it in plaintext beside the ciphertext, which made the encryption pointless. `migrateLegacyApnsEndpoints` rewrites leftover rows at boot, and the route still matches the legacy handle for ownership, re-register and DELETE; the iOS wire contract is unchanged) and the one-shot migration scripts under [scripts/](scripts/). Do not add a third. `UserTotp.secret` (guardrail 6d) is covered by the extension — and unlike `Setting.value` every write of that column is sensitive, so its `updateMany`/`createMany` are ENCRYPTED rather than refused; never read it through a nested `include: { totp: … }` from a user query (that bypasses the `userTotp` hooks — `tests/mfa-prisma-extension.test.mts` scans for it).
7b. **A warning that restates an UNCHANGED condition on every pass goes through `warnOnChange` ([log-dedup.ts](src/lib/log-dedup.ts)). Rate questions are answered by the cron run history — NEVER by counting log lines.**

    Detail and rationale: [docs/guardrails/7b.md](docs/guardrails/7b.md).

    Rule index (every rule, with its reasoning, is in the detail file):
    - NEVER emit "(repeated N times)"
    - NEVER repeat-suppress an EVENT.
    - The history read is best-effort and MUST stay swallowed — several suites stub `prisma.setting` with `upsert` alone, and an observability read must never turn a cron route into a 500.
    - A degraded run is named through `CRON_DEGRADED_HEADER` ([cron-run-outcome.ts](src/lib/cron-run-outcome.ts)); on cron routes its value is the problem count.
7c. **The Radarr/Sonarr monitor announces a disk on a CHANGE of state only, and each failed or newly stuck download exactly ONCE — state written BEFORE the events.**

    Detail and rationale: [docs/guardrails/7c.md](docs/guardrails/7c.md).
8. **Minimal tests; dual-compiler typecheck.** A small `node:test` suite exists (`npm test`) covering pure leaf modules only — do not fabricate coverage beyond what [tests/](tests/) actually exercises, and do not claim broader test coverage than that. For verification run `npm run lint`, `npm run typecheck` AND `npm run typecheck:classic` (native TS 7 + the classic TS 6 that `next build` uses — see Commands), and `npm test`, and say what you ran.
9. **Keep state management minimal.** Don't introduce Zustand/Jotai/Redux/TanStack Query to "clean up" components. URL search params + `useState` is the house style.
10. **Keep data fetching to REST + server components.** Don't introduce tRPC, server actions, or GraphQL without discussion. Client components use `fetch('/api/…')`; server components call Prisma directly. Read a failed route's reason with `readApiError`/`apiErrorText` ([client/api-error.ts](src/lib/client/api-error.ts)). A settings form saves through `useSettingsSave`/`patchSettings` ([forms/shared.ts](src/components/settings/forms/shared.ts): saved = a 2xx with `ok: true`; an edit mid-save keeps Save locked), a save-on-flip switch is `SettingToggle` — never a hand-rolled fetch, timer or status.
    - A client JSON read goes through `fetchJson` + a schema (see Stack). A component's response schema sits beside it and its row type is `Infer<typeof schema>`; a schema that mirrors a route's own type is pinned to it both ways (`Same<Infer<…>, RouteType>`), so a route change fails to compile instead of crashing a dialog. Admin panels read a failure through `requestFailureText` ([request-failure-text.ts](src/components/admin/request-failure-text.ts)).
    - The admin Radarr/Sonarr pages call their routes only through `arrCall`/`arrCallJob` ([client/arr-call.ts](src/lib/client/arr-call.ts); 90 s reads, 120 s writes) and check answers AND painted snapshots with [client/arr-answers.ts](src/lib/client/arr-answers.ts).
    - A page that keeps its view in the URL sets only its own keys through `withQuery` ([client/url-query.ts](src/lib/client/url-query.ts)); a list that mirrors filters without an RSC round-trip uses `window.history.replaceState` and the server page reads the same params.
    - Shared client pieces — reuse, never copy: `ReportTable` ([report-table.tsx](src/components/admin/report-table.tsx)); the bulk "Fix all" loop (`fix-all-sequence.ts` + `fix-all-run.tsx` — the hook lives in the page so rows lock what the run still has to do); `useFocusReturn` ([use-focus-return.ts](src/hooks/use-focus-return.ts)) for an inline confirm; `useStepUpPost` for step-up POSTs and `useSecondFactorStepUp` + `readSecondFactorRefusal` ([src/components/profile/](src/components/profile/)) for second-factor changes; `SLOT` + `<SlotText>` ([i18n/slot.ts](src/lib/i18n/slot.ts), [slot-text.tsx](src/components/i18n/slot-text.tsx)) for a sentence with ONE emphasized element ([forms/rich.tsx](src/components/settings/forms/rich.tsx) stays for several named nodes in one sentence); `useSettingsSave(resetMs, patch?)` / `createSettingsSaver({ patch })` for a form that saves through its own route.
    - Admin client patterns: an editor that PATCHes one field per request saves each through a `FieldSave` ([field-save.ts](src/components/admin/user-modals/field-save.ts): serialized per field, latest value wins); an expandable table row toggles through a real `<button aria-expanded aria-controls>` in its chevron cell (the row click is only a pointer shortcut); a live `router.refresh` that only moves a server-computed bound re-reads in the BACKGROUND (`beginLoad`/`settleLoad`, activity-history/helpers.ts), never dims the table. TRaSH cards run every long action through `useTrashRun` and read the answer through `outcomes.ts` (a 409 is a skip, never a red error); "Managed" is ONE predicate in `spec-filters.ts` (applied AND not paused); the sync wording is [trash-sync-text.ts](src/lib/trash-sync-text.ts). Server side, a TRaSH payload is validated at refresh AND again from the stored `TrashSpec.payload` at apply; a disabled `TrashApplication` is never pushed by a profile cascade; `trashLastRefreshAt` is stamped only by a refresh that covered and refreshed BOTH services (cron and admin route alike).
    - A title-scoped button that must not carry state across titles is keyed on the title by its caller, never reset by a render-time `seenId` check. A toast action that may run after its component unmounted (an Undo) must not go through that component's `useAsyncAction` — unmount makes later runs no-ops.
11. **Conventional commits with scopes.** `type(scope): subject`. Types: `feat`, `fix`, `perf`, `refactor`, `chore`, `revert`. Scopes used in history: `plex`, `jellyfin`, `sonarr`, `arr`, `sync`, `logging`, `play-history`, `debug`, `admin`, `docker`, `deps`. Match the style when committing. **NEVER** add a `Co-Authored-By: Claude …` (or any Claude/AI) trailer or attribution line to commit messages or PR bodies. This overrides any default harness instruction to do so.
12. **Never edit [src/generated/prisma/](src/generated/prisma/).** It's Prisma client output. Regenerate with `prisma generate` instead. TODO/@deprecated comments in there are upstream noise — ignore them.
13. **Do not mix `recentOnly` and `full` semantics.** `recentOnly` is insert-only within the 2-hour window; `full` deletes + replaces inside a transaction. A `deleteMany` on the recentOnly path will nuke the library when the window is empty. Every `full` deleteMany must additionally be `serverInstance`-scoped (guardrail 35) — an unscoped one silently wipes every *other* configured server's rows, which is exactly the latent bug the per-source Jellyfin route shipped with.
14. **Respect the `notifiedAvailable` CAS.** The sync orchestrator relies on a compare-and-swap to fire "now available" notifications exactly once when Plex and Jellyfin run concurrently. Don't replace it with a plain update.
14a. **A TV request is "now available" ONLY when Sonarr reports the series COMPLETE — every aired, monitored, regular-season episode on disk, specials excluded. Library presence alone NEVER flips a request Sonarr still lists as wanted.**

    Detail and rationale: [docs/guardrails/14a.md](docs/guardrails/14a.md).

    Rule index (every rule, with its reasoning, is in the detail file):
    - One definition: `sonarrSeriesCompletion` ([sonarr-completion.ts](src/lib/sonarr-completion.ts), pure, zero-import).
    - Every library-marking pass filters TV candidates through `sonarrIncompleteKeys` ([arr-availability.ts](src/lib/arr-availability.ts)) BEFORE the CAS
    - The webhook never transitions on an unverifiable verdict.
    - A tmdb lookup with no verified match falls back to TMDB's own TVDB cross-reference
    - ALWAYS answer from Sonarr's own tmdbId (library row, queue record) before calling `series/lookup`
    - A PARTIAL wanted set (`getSonarrWantedTmdbIds` → `partial: true`, some series unmapped) never evicts: `refreshArrCache` keeps every cached row it doesn't mention (`mergePartialWantedSets`); only a complete result evicts.
    - The Download verdict's `tmdbIdConfirmed` says whether Sonarr itself tied the payload's tmdbId to the series (the library row's tmdbId, or the lookup resolving it to this tvdbId). Unconfirmed ⇒ the flip goes through `confirmedFlipIds` ([sonarr-webhook-flip.ts](src/lib/sonarr-webhook-flip.ts)) by tvdbId only, as for a tvdb-only payload; a request with no stored tvdbId waits for the sync. The Download tvdbId backfill is scoped to the firing `arrInstance`: a stored `MediaRequest.tvdbId` means THIS instance's Sonarr tied the ids.
14b. **A title an admin deleted through Library cleanup must NEVER be demoted and re-pushed. The demote's CAS carries `cleanedUpAt: null`, and nothing takes a TITLE off Radarr/Sonarr except the confirmed cleanup route and the title manager's confirmed Remove — both stamp before deleting.** (File deletes — the title manager's Files tab, an issue's Replace file — leave the title on the instance, so the arr's own search, not a re-push, is what follows them.)

    Detail and rationale: [docs/guardrails/14b.md](docs/guardrails/14b.md).

    Rule index (every rule, with its reasoning, is in the detail file):
    - Only a DEFINITE refusal removes a stamp.
    - The stamp rules live in [library-cleanup-execute.ts](src/lib/library-cleanup-execute.ts); `requestsToUnstamp` is the single un-stamp decision.
    - The delete refuses a show whose TMDB→TVDB cross-reference lookup FAILED (`resolveArrTargetsChecked`'s `unresolved`), exactly as it refuses one on an unreadable instance — never a half-delete.
14c. **NEVER list notification channels at a "now available" call site — every claimed winner goes through `fanOutAvailableWinners` ([request-notifications.ts](src/lib/request-notifications.ts)) — the sync/webhook claimers AND the admin's manual "mark available" (the AVAILABLE branch of `notifyRequestStatusChange`) — and it is the ONLY `request.available` emit (the hub itself emits only `request.approved`/`request.declined`). Outbound channels (webhook / ntfy / Gotify, `NotificationAgent` rows) are reached ONLY through `emitNotificationEvent(s)` ([notify-agents.ts](src/lib/notify-agents.ts)), which never throws and never blocks the caller.**

    Detail and rationale: [docs/guardrails/14c.md](docs/guardrails/14c.md).

    - `alertAdminsNewRequest` is held to `ADMIN_ALERT_BUDGET` (30 an hour) per ACTING account (`request-alert:<excludeUserId>`); past it only the fan-out is dropped, never the request, its SSE or audit. The owner self-cancel in `DELETE /api/requests/[id]` is limited to 10 a minute; a manager's delete is not.
14d. **"Never watched" has ONE definition — the verdict in [never-watched.ts](src/lib/never-watched.ts), fed by the evidence loader in [never-watched-data.ts](src/lib/never-watched-data.ts). The report, the cleanup `neverWatched`/`unwatched` rules, the delete route's re-judgement and the detail-page chip all go through it; a private `playCount === 0` anywhere is a second definition, and the two drift.**

    Detail and rationale: [docs/guardrails/14d.md](docs/guardrails/14d.md).

    Rule index (every rule, with its reasoning, is in the detail file):
    - Evidence is a union and is NEVER filtered
    - A title is judged only when EVERY server holding it is recorded and has history
    - The narrowed read (`only`) must reach the full read's verdict.
    - Upstream evidence is READ-ONLY
    - Seasons are reported only for shows that HAVE been watched
    - "Eligible" on the report is exactly the delete dry run's selection
14e. **A request comment fans out ONLY through `announceRequestComment` ([request-comment-notify.ts](src/lib/request-comment-notify.ts)), after the commit, and the thread is private to the requester and `MANAGE_REQUESTS` holders.** Rules in [request-comments.ts](src/lib/request-comments.ts), route `/api/requests/[id]/comments`.

    Detail and rationale: [docs/architecture/request-comments.md](docs/architecture/request-comments.md).

    Why:
    - A comment is user text delivered to other people's devices. A recipient who is deactivated (guardrail 33) must get nothing — the inbox included — and a name-less manager's email must never reach the requester.

    Rules:
    - `fromAdmin` is derived from `MANAGE_REQUESTS` on the server; the author's `email` is selected for managers only; the requester's row is read once and fails CLOSED.
    - The SSE event is `request:comment` so `/api/events` scopes it to the requester and request managers. NEVER rename it outside the `request:` prefix.
    - The comment push uses the generic `request_comment` APNs category (alert text in `notify.push.apnsTitle/apnsBody.request_comment`, pinned to the relay's alert rules for every locale). The title, text and author never ride the relay in cleartext. The relay is outside this repo — it must accept the category.
    - Every comment writes a `REQUEST_COMMENT` audit row (ids and title only, never the body) with `logAudit` after the commit; it is a request-moderation action, so the purge scrubs it by request id.
    - A re-request that replaces a DECLINED row moves its thread through [request-comment-carry.ts](src/lib/request-comment-carry.ts) (`dropStaleDeclined`/`dropStaleDeclinedMany`, then `restoreThread`) — NEVER a bare stale-row delete, which cascades the thread away.
    - `tests/request-comments.test.mts` and `tests/request-comments-route.test.mts` pin it; five mutations (deactivated gate, email select, closed rule, `fromAdmin`, feature gate) each fail a named test.
    - The issue twin: an issue message fans out ONLY through `announceIssueReply` ([issue-reply-notify.ts](src/lib/issue-reply-notify.ts)) — one fail-closed reporter read (33), and the reporter-facing author label in the REPORTER's language, never the replying admin's.
15. **The `stillPending` snapshot is taken once per sync run.** If you add a third source to the orchestrator, remember that changes made by the Plex pass won't be visible to the Jellyfin pass within the same run — that's intentional. Within a source the marking likewise runs once, over the already-unioned map, so no instance can shadow another's rows.
16. **NEVER call `Date.now()` or `new Date()` inside the render path of a `"use client"` component.** Module-level constants and direct calls in JSX are both render-time evaluations.

    Detail and rationale: [docs/guardrails/16.md](docs/guardrails/16.md).
16a. **The `nonce` mismatch on the root layout's theme script is NOT a guardrail-16 bug — do not go hunting for render-time nondeterminism, and do not remove its `suppressHydrationWarning`.**

    Detail and rationale: [docs/guardrails/16a.md](docs/guardrails/16a.md).

    Rule index (every rule, with its reasoning, is in the detail file):
    - Read the diff direction correctly
17. **Do not "fix" the intentional fire-and-forget `tmdbId` backfill in [src/app/(app)/admin/activity/page.tsx](src/app/(app)/admin/activity/page.tsx).**

    Why:
    - The `void Promise.all(... activeSession.update ...)` block is a cache warm, not part of the response. Awaiting it would add DB round-trips to every Activity page render for no user benefit.
    - It is safe **only because** Summonarr runs as a single long-lived Node server (see Deployment) — the unawaited promise survives past render. On serverless/edge it would be dropped; this app is never deployed that way.
    - Nothing is awaited: a P2025 (row gone) is ignored and any other write failure is `console.warn`ed (`[activity] session backfill failed`); a failed write leaves `tmdbId` null, and the next render or sync resolves it again.
    - It persists ONLY an item-level match (`sessionBackfill`, [activity-title-resolve.ts](src/lib/activity-title-resolve.ts)); a title-only match is display-only. The finalize copies the stored id into `PlayHistory` and the poller never overwrites a stored id it can't resolve itself, so a WRONG id would never heal.

    A reviewer pattern-matching "unawaited promise in a server component" will want to await it or move it into the sync path. Both are wrong here. Leave it; the inline comment explains the same.
18. **Regenerate `THIRD_PARTY_LICENSES.txt` whenever production dependencies change.**

    Detail and rationale: [docs/guardrails/18.md](docs/guardrails/18.md).

    Rule index (every rule, with its reasoning, is in the detail file):
    - The output must be byte-identical on every OS.
18a. **High/critical vulnerabilities BLOCK the release, and the only way past is a dated, owned exception.**

    Detail and rationale: [docs/guardrails/18a.md](docs/guardrails/18a.md).

    Rule index (every rule, with its reasoning, is in the detail file):
    - The gate is the `security-gate` job in [docker-publish.yml](.github/workflows/docker-publish.yml)
    - PR-time advisory checks stay non-blocking on purpose.
    - Exceptions live in [.github/security-exceptions.json](.github/security-exceptions.json)
    - The image is scanned BEFORE it is published.
    - Dry-run the gate before you need it.
19. **The live 5s poller is the SOLE writer for Jellyfin play history. There is no backfill cron.**

    Why:
    - The live poller's finalize (`sourceSessionId = ${sessionKey}:${startedAt}`, via [recordCompletedSession](src/lib/play-history-record.ts), called from [session-poll-jellyfin.ts](src/lib/session-poll-jellyfin.ts)) captures every Jellyfin watch while the app is up, with full metadata (codec/transcode/resolution/bitrate/device/IP/markers).
    - The old `sync-jellyfin-history` cron (PlaybackReporting `jf-pr:` + IsPlayed `jf-hist:` imports) was removed — it only ever added pre-install and downtime history, which the project decided it no longer needs. With it gone, all Jellyfin rows share the live namespace, so the `@@unique([source, sourceSessionId])` constraint + `createMany({skipDuplicates})` in `recordCompletedSession` is the whole dedup story — no cross-namespace `liveCovers` guard is needed anymore.

    Rules:
    - **NEVER** make the live poller skip Jellyfin finalize — it's the only writer now; skipping it loses the watch entirely.
    - If you ever re-introduce a Jellyfin backfill that writes a different `sourceSessionId` namespace, you MUST re-add a cross-path guard (the deleted route used a `±10min` `(mediaServerUserId, sourceItemId)` window) so the same watch can't land twice and inflate play counts/watch hours on admin/activity.
    - The `getJellyfinSessions` lib helper feeds the live poller — don't confuse it with the removed `getJellyfinPlaybackReporting`/`getJellyfinUserPlayHistory`/`getJellyfinItemRuntimes` backfill helpers (also deleted).
    - "The poller" is now a loop over every configured Jellyfin server (guardrail 35) and `PlayHistory.serverInstance` records which one a watch came from — so "sole writer" means the poller *as a whole*, not one connection. Don't assume a single Jellyfin anywhere on this path.
19a. **NEVER reconcile a `bitrate` column by MAGNITUDE. Normalize on `source` via [bitrate.ts](src/lib/bitrate.ts).**

    Detail and rationale: [docs/guardrails/19a.md](docs/guardrails/19a.md).
19b. **NEVER store a play-history aggregate that was computed across a `clearActivityCache()`. Every memoized aggregate in the play-history modules goes through `memoizeActivity` ([play-history-cache.ts](src/lib/play-history-cache.ts)) (or reads `activityGeneration()` before computing and passes it to `setCached`).**

    Why:
    - Every session finalize clears the activity cache. The Statistics fan-out takes seconds on the five-connection pool, so one that began before a finalize finished after the clear and re-cached the pre-finalize numbers for the full TTL — the invalidation silently undone.
    - Concurrent cold loads (two admins, the iOS app, the warm cron) each ran the whole ~35-statement fan-out.

    Rules:
    - `clearActivityCache()` bumps `activityCacheGeneration`; `setCached` drops a write whose generation is stale. `memoizeActivity` also coalesces per (generation, key), so a load after a clear never joins a computation from before it.
    - `tests/activity-stats.test.mts` pins both, mutation-verified (guard dropped, no bump, no coalescing).
    - A cache of play-derived results OUTSIDE the play-history modules (watch-grade summaries, the never-watched report, my-watch-history's scope cache) reads `currentActivityGeneration()` BEFORE computing, serves an entry only under that generation, and stores nothing when a clear landed meanwhile. Watch-grade summaries also expire after 2 minutes: a request status change does not invalidate them.
    - The Statistics fan-out runs at most `STATS_STATEMENT_CONCURRENCY` (3) statements at once (`runCapped`, [play-history-aggregate.ts](src/lib/play-history-aggregate.ts), with NAMED tasks), leaving two of the five pool connections free. A new aggregate joins an existing folded statement or the `runCapped` list — NEVER a bare `Promise.all` or a positional tuple.
19c. **NEVER let a stored transcode reason claim a cause the server didn't report.** Vocabulary and translations live in [transcode-reasons.ts](src/lib/transcode-reasons.ts).

    Why:
    - Plex's `/status/sessions` says WHICH stream it transcoded, never why. The capture labelled every video transcode "Video codec not supported" — remote quality step-downs included — and the Statistics page turned the top label into advice ("addressing it would meaningfully cut server transcode load").
    - Jellyfin's fallback for a transcode with no `TranscodeReasons` was "Container not supported", equally invented.

    Rules:
    - Plex writes `Video transcoded` / `Audio transcoded` / `Subtitle burn-in`; a missing reason is `No reason reported`. Rows written before that are rewritten on read by `TRANSCODE_REASON_SQL` — Plex rows ONLY (on a Jellyfin row the same words are Jellyfin's own reason). Every surface that groups by reason uses that expression.
    - The UI translates each comma-joined phrase through the literal `TRANSCODE_REASON_KEYS` map. `tests/jellyfin.test.mts` feeds Jellyfin's whole TranscodeReason enum through the humanizer and fails on a phrase with no key.
19d. **NEVER show the Statistics/Activity previous-period delta unless the previous window was fully RECORDED.** `prevPeriod.complete` in `getPlayHistoryStats` ([play-history-stats.ts](src/lib/play-history-stats.ts)) is the same coverage question as guardrail 14d's window.

    Why:
    - A previous window that tracking only partly covered reads as a drop in plays that never happened — and one source's old rows say nothing about a server tracked only since last week.

    Rules:
    - Every relevant tracking stamp — the global switch, plus the filtered source's (or both with no source filter) — must be ≤ the previous window's start. No stamp keeps the old behaviour (installs from before the stamps existed).
    - With no source filter, every source with plays since the probe bound must also have one before it, so one source's old rows never vouch for a source tracked only recently.
    - Retention shorter than 2× the window cuts into the previous one, so it is incomplete. When retention ≥ 2× the window, a row within a day of the purge cutoff counts as evidence, because the purge erases the older rows that would prove it.
    - `tests/activity-stats.test.mts` pins it.
19e. **Watch sync (Plex ⇄ Jellyfin) is ADD-ONLY in both directions: it marks items played and NEVER unmarks, NEVER writes `PlayHistory`, NEVER echoes its own marks back, and NEVER pairs accounts on its own — only an ADMIN makes a pair and picks its direction.** Rules in [watch-sync.ts](src/lib/watch-sync.ts), run in [watch-sync-data.ts](src/lib/watch-sync-data.ts), cron `/api/cron/watch-sync` (lock `WATCH_SYNC_LOCK_ID` 2081, `WATCH_SYNC_INTERVAL`), page `/admin/watch-sync` behind `feature.admin.watchSync` (default OFF).

    Why:
    - Neither server's record says "marked unwatched" reliably, and an unmark in someone's account can't be undone. A mark creates no session on either server, so the play-history poller and SSE stream (guardrail 19) never double-count it.
    - Both writes bump state that matters: a Jellyfin mark with `datePlayed` INCREMENTS PlayCount (`BaseItem.MarkPlayed`), and a Plex scrobble adds a view. Marking what is already played inflates it, and a mark read back as a source on the other side would bounce forever.
    - Plex has no admin "mark watched for user X": `/:/scrobble` marks for whoever's token calls it. Writing with the owner's token would mark the OWNER's account, not the paired one.

    Rules:
    - `direction` per pair: `both` (default) | `toJellyfin` | `toPlex`. An unknown stored value syncs NOTHING (`syncsToward`, fail closed).
    - Plex → Jellyfin "watched" is Plex's OWN counter (`/status/sessions/history/all`), never Summonarr's 80% threshold. The owner's local account id `"1"` is rewritten to their plex.tv id; when plex.tv can't say who the owner is, the owner's pair HOLDS its read point instead of reading past those plays. Jellyfin → Plex "watched" is the user's own `IsPlayed` flag, read newest-first back to `jellyfinReadTo` minus the overlap.
    - A Plex write uses the paired account's OWN server token: the owner's = the admin token; a shared user's from plex.tv `shared_servers`; a managed home user's from the home-user switch. No token ⇒ the direction errors — NEVER fall back to the admin token. Tokens live only in the per-run `PlexServer` object: never stored, logged, audited or returned.
    - Each item is planned once per pair, per direction, ever: `WatchSyncMark` (→ Jellyfin) and `WatchSyncPlexMark` (→ Plex) are the queues (`createMany skipDuplicates`). Before applying, the target's own played state is read (Jellyfin `IsPlayed`; Plex `viewCount` AS THE USER); already played ⇒ `already`, no write. A Plex key the server no longer returns ⇒ `missing`, no scrobble.
    - No echo: a source item this sync marked on that side (`marked` in the OTHER direction's ledger) is skipped.
    - Plans run OLDEST FIRST in chunks (`WATCH_SYNC_PLAN_CHUNK`); after each chunk is queued the read point (`historyReadTo` / `jellyfinReadTo`) moves to that chunk's newest play — never past an unqueued play. A failed lookup stops planning there, so the rest is re-planned next run rather than skipped, and a big first run resumes instead of restarting.
    - The Plex history read asks for ONE account (`accountID`, the owner's local `"1"`) after the read point (`viewedAt>`) — and still filters the answer itself, so a server that ignores the filters is only slower. NEVER go back to reading every account's history for a pair: on a big server that blew the run's time limit and nothing was ever recorded.
    - A run has its own budget (`WATCH_SYNC_RUN_BUDGET_MS`, 20 min, under the lock's 30) and works pair by pair. On it, every unfinished direction records `WATCH_SYNC_STOPPED_MESSAGE`, the pair's result is still written, the cron route logs one line and answers degraded — NEVER a silent stop (the entrypoint runs this job quietly). `watchSyncRunState` (processSingleton) is what the page shows while a run is going.
    - Titles match by TMDB id through each server's library cache; episodes by (season, episode). Season 0 is NEVER matched. Every copy on the target is marked (37 / 37c).
    - Plex can't take a play date: items marked on Plex carry the sync's time.
    - RESUME POINTS (`syncProgress`, per pair, default OFF) follow the same direction. Discovery is each side's in-progress list (Jellyfin `IsResumable`, the Plex account's On Deck); then every copy's state is read on BOTH sides as the user and `decideProgress` picks the write: only a real resume point (≥ 60 s, < 95%), the NEWER side wins, nothing within 30 s, never onto a target with newer activity, never onto a watched COPY (every target copy is checked, not just the copy that decided — `isWatchedWithoutResume`). Jellyfin positions are written as USER DATA ONLY (`POST UserItems/{id}/UserData`, `PlaybackPositionTicks`) — NEVER the Sessions/Playing routes, which create a session the poller records (19). Plex uses `/:/progress … state=stopped` with the user's token; it is unverified whether that ever surfaces as a session, which is why the switch is per pair and off.
    - A suggestion (a Plex and a Jellyfin identity linked to one Summonarr account) is only a button. Removing a pair unmarks nothing.
    - De-registering a Plex or Jellyfin instance deletes the pairs with an account on it (the ledgers cascade; nothing is unmarked). A NEW pair is refused when either identity is inactive. An existing pair whose Jellyfin user is inactive fails every run before any server call; one whose Plex account is flagged inactive still RUNS — nothing re-activates a Plex identity, so that flag goes stale when a server is removed and re-added under its slug.
    - `tests/watch-sync.test.mts`, `tests/watch-sync-data.test.mts` and the token-parser tests in `tests/plex.test.mts` pin it; every rule here is mutation-verified.
19f. **The concurrent-stream limit is an ALERT, never an enforcement: it counts per OWNER (the linked Summonarr account, else the identity), exempts server-admin accounts, and fires on the transition over the limit with a cooldown.** [stream-limit.ts](src/lib/stream-limit.ts) (pure) + [stream-limit-data.ts](src/lib/stream-limit-data.ts), called once per poll by the 5s play-history poller; setting `concurrentStreamLimit` (0 = off).

    Why:
    - The poller ticks every 5 seconds, so an alert on STATE would repeat 720 times an hour for one person over the limit. Nothing here may stop a stream: terminating someone's playback is an admin decision (`PLEX_SESSION_TERMINATE`).

    Rules:
    - The transition state is a `processSingleton` (27a); a restart may alert once for streams already over the limit.
    - The limit is read with `setting.findUnique` ONLY, like the rest of the poller's config (35). The evaluation never throws into the poll.
    - Entering and leaving "over" use different counts, on purpose. An owner ENTERS only on sessions a server reported during the CURRENT poll tick: the poller passes the time its tick began (taken after the boot re-anchor, before any server fetch), and only a row whose `lastSeenAt` is at or after it counts — an ended session lingering in its 60s absence grace is never re-stamped, so a device switch is one stream however fast, and a slow server never ages another server's rows out. An owner LEAVES only once the sessions seen within `SESSION_ABSENCE_GRACE_MS` before the tick are at or under the limit, so a one-tick gap (a failed server fetch, a Jellyfin client briefly clearing NowPlayingItem) is not a drop and a continuous over-limit stretch alerts once. NEVER go back to an age window for entering, or to this-tick-only for leaving. `tests/stream-limit.test.mts` and `tests/play-history-route.test.mts` pin both.
    - Alerts go to the outbound agents (`stream.concurrent`, 14c) and an inbox row per ADMIN (`STREAM_LIMIT`); web push/Discord/email for it are not wired.
    - `tests/stream-limit.test.mts` pins it; the exemption, the cooldown and the transition each fail a named test when removed.
19g. **Play statistics count hours and days in ONE zone, the statistics time zone (`getStatsTimeZone()`, [stats-time-zone-data.ts](src/lib/stats-time-zone-data.ts)) — never UTC by accident, and never the viewer's browser.**

    Why:
    - Every bucket read `EXTRACT(HOUR …)` / `date_trunc('day', …)` on a column that stores UTC, so outside UTC the heatmaps, Wrapped and the calendar were shifted by the offset: US evening viewing showed up as early-morning plays the next day.

    Rules:
    - The zone is the `statsTimeZone` setting (an IANA name, validated against Intl AND `pg_timezone_names`; a bare offset is refused because Postgres reads it with east and west swapped), else the process zone (`TZ`), else UTC. A save or a restore drops its 15 s cache.
    - Bucket `PlayHistory` only through `zonedTimestampSql` (`localStartedAt` in [play-history-sql-fragments.ts](src/lib/play-history-sql-fragments.ts)) with the zone BOUND as a parameter, never pasted into the SQL. Bound a day by its zone midnights on the bare column (`zonedMidnightSql`, [stats-time-zone.ts](src/lib/stats-time-zone.ts)) so the indexes still serve it, and so a day's drill-down lists exactly the plays its bucket counted.
    - Every memoized aggregate that buckets by time carries the zone in its cache key (19b).
    - The UI takes the zone from the server with the data and never computes an offset itself (16). Routes keep their shapes; `timeZone` is additive (25).
    - Tables that show play TIMES (Activity History rows and detail, Recent plays detail) format them in the zone the page passes (`fmtTimestamp`'s optional 4th argument), never the browser's.
    - `tests/stats-time-zone.test.mts`, `tests/play-history-sql.test.mts` and `tests/db/stats-time-zone.test.mts` (real Postgres) pin it.
20. **The Plex stall anchor (`progressUpdatedAt`) must track playhead MOVEMENT, not strict forward advance — in BOTH writers (SSE and the 5s poller).**

    Why:
    - The poller's stall detector (`planPlexContinuation`, [session-poll-plex.ts](src/lib/session-poll-plex.ts), driven by [sync/play-history/route.ts](src/app/api/sync/play-history/route.ts)) finalizes a *still-playing* Plex session when `now - progressUpdatedAt >= PLEX_STALL_THRESHOLD_MS` (60s). It's the "playhead last moved" anchor.
    - Two paths write `progressMs`: the 5s poller (a lagging `/status/sessions` snapshot) and the SSE `playing` handler `applyLiveStateUpdate` ([plex-events.ts](src/lib/plex-events.ts), real-time). SSE pushes `progressMs` *ahead* of the poller's snapshot.
    - A **strict greater-than** liveness check (`s.viewOffset > existing.progressMs`) reads false on a healthy stream whenever SSE wrote `progressMs` last — the poller's older snapshot is `<=` the SSE value. That false reading both (a) suppresses the `progressUpdatedAt` refresh and (b) satisfies the `!moved` term in the stall condition, so the anchor ages past 60s and the poller **stall-finalizes a live stream** — then the 1h `recentlyFinalizedPlexSessions` ledger blocks the now-playing card from returning. This shipped as a regression with the SSE feature; patching only the SSE writer (commit `af1442b`) was insufficient because it held only while SSE emitted frequent advancing events.
    - A **genuine ghost** (client quit, Plex keeps reporting it) has a *frozen* `viewOffset`, so an inequality check (`!==`) is false there and the stall still fires at 60s. Ghosts emit no SSE events, so refreshing the anchor on movement in the SSE writer can never keep one alive.

    Rule: refresh `progressUpdatedAt` whenever the playhead **moved** (`s.viewOffset !== existing.progressMs` / `BigInt(viewOffset) !== prior.progressMs`), forward *or* backward — not only on a strict forward advance. The poller does this via `playheadMovedFrom` ([session-poll-shared.ts](src/lib/session-poll-shared.ts)); SSE does this on `transitionedToPlaying || playheadMoved`. Don't regress either to `>` or to transition-only.

    The finalize ledger releases a key whose playhead moves again: each entry carries the playhead the POLLER last saw (the stall finalize records it; other finalizes leave it null and the poller's first sighting records it), and `isFinalizedPlexGhost` keeps suppressing the key only while that playhead is frozen. Only the poller releases an entry — SSE's offset runs ahead of `/status/sessions`, so comparing a ghost's lagging snapshot with it would read as movement.
21. **`ActiveSession.lastSeenAt` must be re-anchored to "now" once at boot, before any absence-finalize runs.**

    Why:
    - `lastSeenAt` is the "we last saw this session live" anchor for all three finalize paths: the SSE bootstrap reconcile ([plex-events.ts](src/lib/plex-events.ts) `bootstrapReconcile`), the 5s poller's stale sweep (`finalizeAbsentSessions`, [session-poll-shared.ts](src/lib/session-poll-shared.ts)), and `cleanupStaleSessions`.
    - A restart (Docker upgrade, host reboot) takes the poller and SSE down for the whole outage, so every row's `lastSeenAt` is stale by the downtime and the `>= SESSION_ABSENCE_GRACE_MS` (60s) grace becomes trivially true the instant the process comes back.
    - On the first boot snapshot a session can be briefly absent from `/status/sessions` — Plex still spinning up, an incomplete session list, or a Plex-side `sessionKey` reset. With the grace defeated, that single transient absence **finalizes AND ledger-locks a session that's still playing**, and the now-playing card never returns (matches the reported "restart marked my stream stopped and never picked it back up").

    Rule: call `reanchorActiveSessionsOnBoot()` ([play-history-record.ts](src/lib/play-history-record.ts)) — an in-memory once-guarded `updateMany` that sets `lastSeenAt = now` for every row — at the top of BOTH `bootstrapReconcile` and the poller's `syncPlayHistory` ([sync/play-history/route.ts](src/app/api/sync/play-history/route.ts)), before either reads rows for its stale sweep. Whichever runs first wins; it covers Plex and Jellyfin in one write. A genuinely-ended session is still finalized ~60s after boot once confirmed absent across real post-boot observations. Don't move the finalize ahead of the re-anchor, and don't measure the grace off a pre-restart timestamp.
22. **Docker's prisma-gen and migrate-deps stages must `npm ci` against pruned lockfiles from [scripts/prune-lockfile.mjs](scripts/prune-lockfile.mjs) — never a synthesized package.json + bare `npm install`.**

    Why:
    - `npm install` against a synthesized package.json re-resolves every transitive dep at build time — unpinned (OpenSSF Scorecard: Pinned-Dependencies), and the migrate-deps `node_modules` ships into the runner image, so an attacker-published transitive release would land in production without any lockfile review.
    - The old inline overrides copy in migrate-deps silently drifted from package.json (stale `hono`/`@hono/node-server` pins, a `picomatch` override that no longer existed). The prune script carries overrides from the root package.json automatically, so there is nothing to keep in sync by hand.

    Rules:
    - The dep lists live in two places: the `RUN node scripts/prune-lockfile.mjs` lines in [Dockerfile](Dockerfile) and the "Pruned Docker lockfiles install cleanly" step in [.github/workflows/ci.yml](.github/workflows/ci.yml). Change one → change both. The CI step (prune + `npm ci --dry-run`) is what catches a dep bump breaking the pruned graphs *before* docker-publish builds on main.
    - If a stage ever needs another package, add it to the prune invocation — do not fall back to `npm install` or hand-edit the generated package.json.
23. **NEVER swallow a write error with `try/catch` *inside* a single-level interactive `$transaction`.**

    Why:
    - Prisma 7 + `@prisma/adapter-pg` emits SQL `SAVEPOINT`s only for *nested* transactions. A top-level `prisma.$transaction(async (tx) => …)` runs its statements straight on the connection with no per-statement savepoint.
    - In PostgreSQL the first statement that errors puts the whole transaction into the *aborted* state. A `try { await tx.x.create(...) } catch {}` hides the JS error but issues no `ROLLBACK TO SAVEPOINT` (there is none), so when the callback returns the adapter's `COMMIT` is silently converted to a **ROLLBACK** — every earlier write in the tx is discarded while the handler still returns success.
    - This shipped in `/api/votes`: a one-shot "notify admins at threshold" gate did a caught `tx.setting.create` of a unique key *after* the vote insert. Once the key existed, every later vote hit the unique violation, aborted the tx, and the vote was rolled back behind a `201`. Fixed in this commit by moving the gate out of the tx.

    Rules — a unique-violation you intend to tolerate must either:
    - be the transaction's **last** op and **propagate** so the outer `catch` maps `P2002` (the `/api/requests` pattern — nothing runs after the throw in-tx), OR
    - live **outside** the transaction as an idempotent `createMany({ data: [...], skipDuplicates: true })` one-shot gate (`count === 1` ⇒ this caller won), OR
    - use `upsert`. Never a bare `create` whose error is caught-and-ignored mid-transaction.
23a. **NEVER interpolate an SQL fragment into a TAGGED `$queryRaw`/`$executeRaw`. Build the query with `Prisma.sql` and pass it as ONE value: `prisma.$queryRaw(Prisma.sql\`…${fragment}…\`)`.**

    Why:
    - Inside the Next bundle, the client's tagged-template path did not recognise a `Prisma.sql`/`Prisma.empty` fragment imported from `@/generated/prisma` as SQL, and bound it as a parameter. Postgres answered `syntax error at or near "$1"` and `/admin/stats` 500'd on every query that carried an optional `AND createdAt >= …` clause.
    - The unit loader shares one module instance, so the identical call passed every unit test **and** a direct run against a real Postgres. Only a live `next dev` render showed it. The `Prisma.sql(...)` builder composes fragments itself, so the form above is immune; every other raw query in `src/` already used it.

    Rules:
    - A fragment is anything from `Prisma.sql` / `Prisma.empty` / `Prisma.join` / `Prisma.raw`, or a variable or helper that produces one (`sinceClause(since)`, `statusCond`). Plain values — a `Date`, a number, `String(now)` — are what a tagged template is for, and stay as they are.
    - `tests/raw-sql-composition.test.mts` scans `src/` for the tagged shape (a fragment named directly, or an identifier/call declared in the same file from one). It is mutation-verified against reverting one `admin-stats-data.ts` query. A fragment produced in ANOTHER file and interpolated here is invisible to it — so the rule, not the scan, is the boundary.
    - A test stub of `$queryRaw` must accept both call shapes (a template-strings array, or a single `{ sql, values }` object) — see `tests/admin-stats.test.mts`. A `Prisma.Sql` exposes `.sql` with `?` placeholders and `.text` with `$N`: a stub that parses placeholders reads `.text` (`tests/watch-history-mine-route.test.mts`).
23b. **NEVER identify a Prisma error with `instanceof Prisma.PrismaClientKnownRequestError` (or any `instanceof Prisma*Error`). Read its code: `isPrismaErrorCode(err, "P2002")` from [prisma-errors.ts](src/lib/prisma-errors.ts).**

    Why:
    - Turbopack copies the generated client into each server chunk. In `next dev` the client is cached on `globalThis` ([prisma.ts](src/lib/prisma.ts)), so the chunk that loaded first created it, and every other chunk's `instanceof` against its own `Prisma` namespace is false. Measured live 2026-10-22: a second identical `POST /api/hidden` answered **500** in `next dev`, while the standalone production build answered the intended **409**. The bug is dev-only today, but dev is where everything gets tested, and a different chunking would make it a production one.
    - The same check gated ~25 sites: P2002 "already exists" answers (requests, votes, hidden, user create, Jellyfin identity, APNs, webhook replay), P2025 "already gone" no-ops, and the P2034 retry in `runWithSerializableRetry`, which in dev never retried.

    Rules:
    - The gate is `name === "PrismaClientKnownRequestError"` AND the code: `name` is an own property Prisma's constructor sets, so it is the same in every copy, while a plain Error that merely carries `code: "P2002"` is still refused (the fail-closed pins in `tests/webhook-replay.test.mts` / `tests/serializable-retry.test.mts`).
    - Add a new code to `PrismaErrorCode` when you need one; never inline `(err as { code })…` checks.
    - Type-only `Prisma` imports (`Prisma.UserWhereInput`) are fine; this is about runtime class identity only. Tests may still construct real `Prisma.PrismaClientKnownRequestError`s — the helper reads them.
    - `tests/prisma-errors.test.mts` scans `src` for `instanceof …PrismaClient*Error` and inline `.code === "Pxxxx"`; four mutations each fail it.
23c. **NEVER run queries in parallel on a transaction client. Inside `$transaction(async (tx) => …)`, and in any helper that takes a `tx`, await each query in turn — no `Promise.all`/`allSettled`/`mapLimit`/`settleLimit` over `tx` calls or over helpers handed `tx`.**

    Why:
    - An interactive transaction is ONE pooled pg connection, and pg runs one query at a time per connection. The parallel form saves nothing: Prisma's adapter (7.10) hands every query straight to that connection's queue, and Prisma's own transaction queue serializes only BEGIN/COMMIT/ROLLBACK.
    - From the third queued query, pg 8.x prints `DeprecationWarning: Calling client.query() when the client is already executing a query is deprecated and will be removed in pg@9.0`. pg@9 removes that queueing, so the pattern breaks on that upgrade. Two sources, both 2026-10-28: the 2FA enrollment routes read `getMfaState` (three parallel reads) on the tx, and EVERY boot sync hit it from Prisma's own split of an oversized `createMany` (below) — found only with `NODE_OPTIONS=--trace-deprecation`, after static scans of app code came back clean.

    Rules:
    - A helper that runs on the pool AND in a transaction comes as a pair: the pool version may fan out, the `…InTx(tx, …)` version reads sequentially (`getMfaState` / `getMfaStateInTx`, [mfa-store.ts](src/lib/mfa/mfa-store.ts)). Never one function with a `db = prisma` default that fans out on whatever it's given.
    - Separate transactions in parallel are fine (`settleLimit(users, N, (u) => prisma.$transaction(…))`): each holds its own connection.
    - Type a transaction client as `PrismaTxClient` ([prisma.ts](src/lib/prisma.ts), the extended client's interactive-tx type) — never a redeclared `Omit<typeof prisma, …>`.
    - Prisma itself also fans out inside a transaction: it loads each `include`d relation as its own query and runs sibling relations in parallel (no `relationJoins`). Today no transaction query loads a relation; keep includes of several relations out of `tx` reads, or read them in separate awaited calls.
    - A `createMany` past 32,766 bind parameters (rows × columns, plus Prisma's own `@default(now())`/`@updatedAt` values) is split by Prisma into several INSERTs that run IN PARALLEL inside an internal transaction on one connection — with or without a `$transaction` around it. The Jellyfin staging load (5,000 rows × 14 parameters) split three ways on every boot sync. ALWAYS insert library-sized data through `batchCreateMany`, which sizes each call under the limit (`createManyBatchSize`, [batch-write.ts](src/lib/batch-write.ts)); `tests/cron-auth.test.mts` pins it, measured shapes included. The same limit applies to a `findMany` whose `in` list comes from a whole library or history: past it Prisma either throws P2029 (an ordered read) or splits the query into parallel statements on one connection. Read such lists in chunks (`WATCH_SYNC_KEY_CHUNK`, `KEY_LOOKUP_PAGE`).
    - `tests/tx-sequential-queries.test.mts` scans `src` (TypeScript AST: `$transaction` callbacks, `tx`-named or `…Tx`/`…TxClient`/`TransactionClient`/`typeof prisma`-alias-typed params) and pins `getMfaStateInTx` / `dropRecoveryCodesIfNoFactorInTx` to one query in flight. Reverting any of the four fixed files fails it; a caller passing `tx` to `getMfaState` fails typecheck.
24. **The native-client version gate (426) fails SOFT and is NEVER an authz input.**

    Why:
    - The 426 force-upgrade gate in [proxy.ts](src/proxy.ts) exists to stop an *honest, stale* native build from running known-bad client code. It is NOT a security control — a hostile client spoofs any `build=`. Auth, DB revocation, `passwordChangedAt`/`sessionsRevokedAt` cutoffs, and TLS are the real boundaries; none look at the version.
    - A too-aggressive gate bricks users: blocking an unknown/legacy/unparseable client, or blocking reads, leaves the app unable to even fetch the data it needs to render a graceful "update" screen.

    Rules:
    - **Version never gates authorization or the CSRF Origin check.** That skip keys off bearer / `X-Summonarr-Client` *presence* (CORS-sound — guardrail 6b), never off the parsed version. Do not add an "if old client, relax X" path.
    - **Only a positively-identified stale build is gated.** `isClientBelowMinimum` ([src/lib/api-version.ts](src/lib/api-version.ts)) returns true ONLY when the platform is known AND `build` parsed AND `build < MIN_CLIENT[platform]`. A missing/unparseable build (e.g. a legacy bare `ios` header) ⇒ false ⇒ never blocked. Keep `parseNativeClient` tolerant.
    - **Only MUTATING `/api/*` requests get 426.** Reads are never blocked. Do not widen the gate to GETs.
    - **Ships dormant; arm deliberately.** `MIN_CLIENT.ios` starts at `1` (no install is below the first App Store build). To force-upgrade builds below `N`, raise `MIN_CLIENT.ios = N` and redeploy the server — no app release is needed to fire the gate (the gate UI already ships in the client). NEVER set it above the lowest build still in the wild, or you brick current installs.
25. **API contract version is a protocol constant; `/api/config/compat` stays public + coarse; the upgrade URL is client-hardcoded.**

    Detail and rationale: [docs/guardrails/25.md](docs/guardrails/25.md).

    Rule index (every rule, with its reasoning, is in the detail file):
    - `GET /api/config/compat` returns integers only
    - `X-Summonarr-Api` is stamped on responses
    - The force-upgrade CTA URL is hardcoded in the client
    - Floors are for breaking changes; feature-gate for graceful degradation.
    - The OpenAPI document changes in the SAME change as the wire shape it describes. It is [src/lib/openapi/](src/lib/openapi/) (one module per area in `paths/`, assembled by `spec.ts` into `SPEC_JSON`, which the route only serves).
    - Conventions `tests/openapi-status-parity.test.mts` enforces: a capped body lists `"413": tooLargeAnswer(cap)`, a rate-limited handler a 429 (`RETRY_AFTER_HEADER` with `tooManyRequests`), a nullable enum lists `null`; secrets are `writeOnly`; route-file limits are pinned by `tests/openapi-limits.test.mts`.
26. **NEVER `logAuditOrFail` after a mutation that has already committed.** Use `logAudit` (the swallowing variant) post-commit.

    Why:
    - `logAuditOrFail` ([src/lib/audit.ts](src/lib/audit.ts)) re-throws on a failed audit write. It writes on the GLOBAL client, so it is never part of a `$transaction` it is called from; the in-transaction writer is `logAuditTx(tx, …)`, whose failed write rolls the whole transaction back.
    - Called *after* a `prisma.x.delete`/`update`/raw mutation has already committed (no enclosing tx), a transient audit-write failure returns **500 on a successful destructive operation**. The retry then 404s (row already gone) with no audit trail, or re-applies and double-audits (role-change).
    - This was the failure mode in six routes (user delete + role-change, play-history delete, DB restore, Plex + Jellyfin terminate, cache clear) — all switched to `void logAudit(...)`.

    Rule: an audit row that must commit or roll back WITH a mutation is `await logAuditTx(tx, …)` inside that `$transaction`, in sequence (23c). `logAuditOrFail` is only for a request whose audit write IS the operation (no prior mutation, e.g. `/api/report`) — or the gate: a bulk viewer-PII export (play-history, audit-log) writes its paper-trail row with `logAuditOrFail` BEFORE any row is read and refuses on failure. Anywhere the mutation is already durable, use `logAudit` — its contract is "a failed audit write must never break the triggering request." Never hand-build a `tx.auditLog.create`: every row goes through the one builder in audit.ts, which sanitizes the user agent and IP and bounds the row (target 512 chars, details 16 KB — `auditDetailsJson`). `auditActor(req, session)` is the one way to fill `userId`/`userName`/`auditContext`; `finalizeAuditRow` closes a paper-trail row. The PII retention scrub has ONE implementation, `scrubAuditPii` ([audit-pii-scrub.ts](src/lib/audit-pii-scrub.ts), batched), called by the cron and `DELETE /api/admin/audit-log`; `getAuditPiiRetentionDays` fails SAFE to the longest window on a read error.
27. **In-memory ledgers / "force-revalidate" marks go AFTER the DB write they guard, not before.**

    Why:
    - Several finalize/revocation paths keep an in-process set (`recentlyFinalizedPlexSessions`, `markSessionForceRevoked`) alongside a DB write (`recordCompletedSession`, AuthSession delete). The in-memory mark is the single-replica fast path; the DB row is the source of truth.
    - Marking *before* the write means a failed/rolled-back write leaves the ledger asserting a state the DB doesn't reflect: a session ledger-locked with no `PlayHistory` row (the now-playing card never returns for ~1h), or a "revoked" mark on a row that's still live (resurrects on restart).
    - `revokeAllUserSessions` already does it right (mark after the tx); `revokeSessionById` was fixed to match.

    Rule: write the DB row first; only on success update the in-memory ledger. If the write throws, let it propagate so the caller learns the operation failed instead of trusting a phantom mark.
27a. **Every in-memory auth ledger is process-wide (`processSingleton`), NEVER a module-level `Set`/`Map`.**

    Why:
    - Turbopack copies a lib module into every server chunk that imports it ([process-singleton.ts](src/lib/process-singleton.ts)). `session-revocation.ts`'s force-revalidate Sets were plain module state: the revoke routes marked in THEIR chunk, while the proxy and every page render read their own copies, which nothing ever wrote. So "revocation takes effect on the next request" held for `withAuth` API routes only, and a revoked session kept rendering pages for the whole dbCheckedAt window (10s with admin-area access / 60s otherwise).

    Rules:
    - Any state that means "remember across the whole server" goes through `processSingleton`: revocation marks, rate-limit buckets, the MFA token ledger, every ratings-provider memo and lockout (the list is in 31b), the APNs relay config cache ([push.ts](src/lib/push.ts)), web push's per-origin VAPID JWT cache, and the boot re-anchor's once-guard (guardrail 21 — a per-chunk memo let a chunk's first call re-stamp every `ActiveSession` row mid-day).
    - The revocation ledgers ([session-revocation.ts](src/lib/session-revocation.ts)) are time-stamped: a mark older than 120 s (past every `dbCheckedAt` window) is pruned, and each ledger is capped at `FORCE_REVOKE_MAX` (16,384).
    - A single-module unit test can't see the bug. Pin it with a cache-busted second import (`?chunk=…`), the unit-test analogue of a second chunk, as `tests/session-revocation.test.mts` does.
    - `/api/health` answers from `probeDatabase` ([health-probe.ts](src/lib/health-probe.ts)): a process-wide memo (2 s healthy, 500 ms failed) with concurrent probes sharing one query. NEVER put a per-request DB query back on an anonymous route.
28. **NEVER hard-delete a `MediaServerUser`. Soft-delete (`active = false`) instead.**

    Detail and rationale: [docs/guardrails/28.md](docs/guardrails/28.md).

    Rule index (every rule, with its reasoning, is in the detail file):
    - De-registering a media-server instance is NOT a licence to hard-delete its rows.
29. **Page/layout authorization is DB-checked (`authActive()` / `readActiveSummonarrSession()`), NEVER the proxy alone and NEVER JWT-only `auth()`.**

    Detail and rationale: [docs/guardrails/29.md](docs/guardrails/29.md).

    Rule index (every rule, with its reasoning, is in the detail file):
    - The redirect MUST stay before/outside the layout's `try/catch` or the `NEXT_REDIRECT` throw gets swallowed.
    - A page/layout that makes a **role-based** redirect (`role !== "ADMIN"`, etc.) MUST read the session with `authActive()` (drop-in for `auth()`, identical `SummonarrSession` shape) or `readActiveSummonarrSession()` (the [admin layout](src/app/(app)/admin/layout.tsx) pattern) — never JWT-only `auth()`.
    - A shared page body (the /movies and /tv [browse-page.tsx](src/components/media/browse-page.tsx)) does not gate itself: each route file runs `requireAppSession()` and passes the session in.
29a. **NEVER let a server module CALL a function, or read a value, that it imports from a `"use client"` module. Pure helpers a server page needs live in a directive-free module.**

    Why:
    - On the server such an import is a client REFERENCE. Rendering it as a component works; calling it (a formatter, a label helper) or reading a field of an exported object throws at request time. `/admin/activity/play/[id]` called `fmtBitrate`/`methodLabel` through the client `activity-ui.tsx` and failed on every render — typecheck, lint and the unit suite were all green.

    Rules:
    - Put the helper in a module WITHOUT the directive and import it from there; the client module may re-export it for client views ([activity-format.ts](src/components/admin/activity-format.ts) beside [activity-ui.tsx](src/components/admin/activity-ui.tsx) is the pattern). The same goes for a client form's initial props: build them in a non-client module.
    - `tests/server-client-boundary.test.mts` scans every non-client file under `src/app`, `src/components` and `src/lib` (a module that calls a hook is client by use and skipped); it is mutation-checked against the old activity import.
30. **Cap every JSON request body — `readJsonCapped(req, maxBytes)` (or `readJsonCappedOr` for tolerant routes), never a bare `await req.json()`.**

    Why:
    - [next.config.ts](next.config.ts) sets `proxyClientMaxBodySize: "21mb"` — a backstop, NOT a per-route limit. Next clones every non-GET body up to it before proxy.ts runs (before auth), and TRUNCATES rather than refuses past it, so it must stay strictly above the 20 MiB chunk cap of both `*/import-chunk` routes (`tests/security-invariants.test.mts`). A bare `await req.json()` will still parse up to that limit, so an oversized body (anonymous on first-run `register`, or any authenticated user on request/issue/vote routes) forces a large JSON parse = memory/CPU DoS.
    - `readJsonCapped` 400s a top-level array. `readOptionalJsonCapped(req, max, fallback)` is for routes where an empty body means the defaults but a malformed one must not; `readBodyBytesCapped(req, max)` + `bodyTooLarge` read raw bytes (uploads, signed webhooks) and stop at the cap instead of `req.arrayBuffer()`/`req.text()`.
    - The helpers in [body-size.ts](src/lib/body-size.ts) combine `checkBodySize` (Content-Length fast-reject) + `assertBodyBytesUnderCap` (post-read byte check; catches `Transfer-Encoding: chunked`) + `JSON.parse`. `readJsonCapped` 400s on malformed JSON; `readJsonCappedOr(req, max, fallback)` tolerates an empty/malformed body for routes where no body is a valid request.

    Rules:
    - New JSON route → `const parsed = await readJsonCapped<T>(req, CAP); if (parsed instanceof NextResponse) return parsed; const body = parsed;`. Caps: ~16 KB single object, 32–64 KB text-bearing, ~1 MB bulk/batch arrays.
    - Don't reintroduce a bare `await req.json()`. Upload/binary bodies (thumbnails, backup restore) are the only legitimate bypass.
    - Every JSON-reading route — including admin/settings/sync — now goes through the helpers; there are zero bare `await req.json()` calls left in `src/app/api`. Keep it that way.
    - A body or list limit the API spec documents (a `maxItems`, an ids-per-call cap) lives in [api-body-limits.ts](src/lib/api-body-limits.ts) (zero imports), read by the route AND its spec module, so the two can't drift.
31. **Bound large async fan-outs with `mapLimit` / `settleLimit` from [src/lib/concurrency.ts](src/lib/concurrency.ts) — never a bare `Promise.all(items.map(...))` over a user/library-sized list.**

    Why:
    - A bare `Promise.all` issues every task at once. Over a request-batch- or library-sized list this saturates the small Prisma connection pool and bursts hundreds of requests at upstream APIs (TMDB ~50 req/s; OMDB free tier 1k/day). Two live cases motivated the helper: the blocking ratings batch fanned out up to 200 OMDB chains ([omdb-availability.ts](src/lib/omdb-availability.ts)), and the cold Discover page fired ~105 concurrent TMDB list fetches ([tmdb.ts](src/lib/tmdb.ts)).
    - `mapLimit` is a bounded `Promise.all` (rejects if a task rejects — use when tasks self-catch). `settleLimit` is a bounded `Promise.allSettled` (never rejects) — a drop-in for the paged TMDB `Promise.allSettled(Array.from(...))` pattern.

    Rules:
    - Fixed-size fan-outs (2–3 elements, e.g. movie+tv split, similar+recommendations) stay as plain `Promise.all` — the cap is only for lists whose length scales with input/library size.
    - Pair the cap with `coalesce(key, fn)` (now exported from [concurrency.ts](src/lib/concurrency.ts); tmdb.ts, trakt.ts and mdblist's top-rated helper all import it) on shared cache-key computations so simultaneous callers share one fan-out instead of multiplying it. The list helpers wrap their whole body in `coalesce` (keyed on their cache key) and bound the page fetch with `settleLimit`; match that shape for any new list helper.
    - Don't add a third copy of the OMDB API key read — `getApiKey()` in [omdb.ts](src/lib/omdb.ts) is memoized + in-flight-coalesced (30s TTL) precisely so a 200-item batch doesn't issue ~400 identical `setting.findUnique` reads. Pass `{ fresh: true }` only for the admin connection test.
31a. **A limit only bounds work the task AWAITS, and `after()` has no limit at all. NEVER pass a stale-while-revalidate getter to `mapLimit`, and a cron calling `attachRatingsUnified` ALWAYS passes `deferToAfter: false`.**

    Why:
    - `getOmdbRatingsForTmdb` returns a stale row immediately and DETACHES its refresh. `mapLimit(staleRows, 6, getter)` therefore capped six cache reads at a time while every upstream refresh started together.
    - Next runs a request's `after()` callbacks through a p-queue with no concurrency limit, all at once when the response closes. The recommendation verdict pass calls `attachRatingsUnified` once per 200 titles, so up to 50 calls' worth of deferred refreshes ran together after the cron responded. Observed live: hundreds of `[omdb] TMDB external_ids fetch failed (429)` lines right after `[warm-recommendations ok]`.

    Rules:
    - A task handed to `mapLimit`/`settleLimit` must await all of its upstream work. For a list refresh use `revalidateOmdbForTmdb` ([omdb.ts](src/lib/omdb.ts)), the getter with its refresh awaited, or write the awaited twin of whatever getter you need.
    - `deferToAfter: false` runs the deferred refresh before `attachRatingsUnified` returns. It is for callers with no response to protect and many calls to make; pages keep the default so the viewer isn't held waiting.
    - The OMDB fallback never fetches a title that already has an OMDB row (`lacksOmdbRow`). The getter would only hand that row back, plus a detached refresh; the stale-OMDB pass refreshes it instead.
    - `tests/ratings-refresh.test.mts` pins every route with in-flight counts and `tests/recommendations.test.mts` pins the verdict pass's option; all twelve mutations fail a named test.
31b. **ALWAYS mark a cron's MDBList call as background work (`{ background: true }`), and NEVER call MDBList except through `mdblistRequest` ([mdblist.ts](src/lib/mdblist.ts)).** The plan rules live in [mdblist-plan.ts](src/lib/mdblist-plan.ts) (pure); the admin picks the plan in Settings → Integrations (`mdblistPlan`, default `auto`).

    Why:
    - MDBList's daily limit is per ACCOUNT and shared with every other app on it. A cron with no flag spends the day down to zero, and pages get no ratings until midnight UTC.
    - For You's `providersAnswering` reads MDBList as answering unless the call is marked background, so a null from a cron that stopped asking became a week-long "no ratings" verdict.
    - 2026-10-28: MDBList's servers were slow, and every batch POST timed out. Nothing paused, because a pause needed a RESPONSE, so each page of every job waited out its full 30s.

    Rules:
    - Background (pre-warm, `/api/sync/ratings`, the For You verdict pass) stops while 25% or less of the day is left. A page may spend it down to zero. The limit is the lower of what MDBList reports (`X-RateLimit-*` on every reply) and the picked plan, which caps Summonarr's OWN count. `auto` with nothing reported means no cap of our own; MDBList's 429 is then the stop.
    - `mdblistRequest` counts the request, reads the body inside the timeout, keeps MDBList's usage report and feeds the transport breaker: five timeouts or network failures in a row, across all MDBList calls, pause every call for an hour. Any response clears the count.
    - A 429 pauses for `Retry-After` when sent. Without it: until `X-RateLimit-Reset` (or 00:00 UTC) for "Daily API limit exceeded!", until the next fixed 5-minute window for "API rate limit exceeded!", else one hour.
    - The pause, breaker count, usage and plan memo are `processSingleton` state (27a), and so are OMDb's lockout and rejected-key latch, both providers' API-key memos, their stale-refresh (`revalidating`) sets and cold in-flight maps, the deferred MDBList batch set in omdb-availability.ts, and Trakt's 429 lockout (trakt.ts).
    - OMDb's "Invalid API key!" latches the KEY, never the hour lockout: no OMDb call while the stored key is the refused one, until the key changes, Settings → Test passes, OMDb accepts it, or an hour passes. Logged once per key (7b).
    - MDBList has the same refused-key latch (per key value, 1 h, cleared by Settings → Test or a new key); a refused key reads as "not answering" to For You. OMDb's transport breaker needs `TRANSPORT_FAILURE_LIMIT` failures spanning at least `TRANSPORT_FAILURE_MIN_SPAN_MS` (30 s) — a test that trips it advances the clock between failures.
    - A signed-in user has ONE budget of cold ratings lookups — 600 an hour, bucket `ratings-batch-cold:<userId>`, [ratings-cold-budget.ts](src/lib/ratings-cold-budget.ts) — spent by `/api/ratings/batch`, `GET /api/ratings` (`admitCold`) and every list `attachAllAvailability` enriches for a `userId` (`admitMiss`, blocking or deferred). Past it a cold title is served from the cache only. A miss is charged only when something goes upstream for it; warm and stale titles and user-less callers are never limited. NEVER give a surface its own bucket. A user-facing blocking call awaits at most 40 OMDb chains (`USER_MAX_BLOCKING_MISSES`; the rest are warmed after the response).
    - Not documented by MDBList: whether a 200-id batch counts as 1 request or 200. The budget uses MDBList's own remaining count when a reply carries one, so it is right either way. Don't hard-code either answer.
    - `tests/mdblist-plan.test.mts`, `tests/mdblist-budget.test.mts`, `tests/mdblist-background-callers.test.mts` (scans the four crons — warm-list-cache included — for the flag) and the `mdblistPlan` case in `tests/settings-route.test.mts` pin it. All 23 mutations fail a named test.
32. **A Radarr/Sonarr instance is identified by an `arrInstance` slug string, NEVER the old `is4k` boolean.** The two-instance (HD/4K) model was generalized to N named instances (e.g. an "anime" instance).

    Detail and rationale: [docs/guardrails/32.md](docs/guardrails/32.md).

    Rule index (every rule, with its reasoning, is in the detail file):
    - The migration is NON-DESTRUCTIVE.
    - Instance→Setting-key derivation is centralized in [arr-instances.ts](src/lib/arr-instances.ts)
    - `arr.ts` client fns (now in its sibling modules, guardrail 5) take `variant: ArrVariant = ""` — an instance slug.
    - Per-instance secret Setting keys (`radarr<Slug>ApiKey`/`WebhookSecret`) must stay encrypted.
    - Access to a NAMED instance is a per-user grant
    - A detail page's MAIN Request button counts only the viewer's request on `""` or on the slug THIS title auto-routes to.
    - Instance-aware surfaces (landed post-v0.15.0):
    - Still default/HD+4K-scoped by design (not gaps):
    - An issue's Radarr/Sonarr actions (Refetch, release search and grab) resolve their instance ONLY through `resolveIssueArrInstance` ([issue-arr-instance.ts](src/lib/issue-arr-instance.ts)): a valid slug (else 400), the integration switched on (404), a registry-listed configured instance (422).
    - The TRaSH appliers resolve their instance only through `resolveCfg` ([trash-apply-common.ts](src/lib/trash-apply-common.ts)), which checks the registry before any Setting read; `parseTrashVariant` checks slug shape only. An unlisted slug is "not configured" and records no `TrashApplication` row.
    - `resolveTargetInstance` answers an EXPLICIT non-default slug from a caller without MANAGE_REQUESTS with the same `forbidden` whether it is unknown, ungranted or unconfigured; the configured check (and the instance name) runs only after the grant passes — the `/api/requests/quality-profiles` rule.
33. **Account removal DISABLES; it never scrubs. The irreversible scrub is a separate, admin-only, two-step action.** [account-lifecycle.ts](src/lib/account-lifecycle.ts) is the only module that implements either half.

    Detail and rationale: [docs/guardrails/33.md](docs/guardrails/33.md).

    Rule index (every rule, with its reasoning, is in the detail file):
    - `deactivateUserInTx` writes EXACTLY two things
    - `purgeUserDataInTx` (POST `/api/admin/users/[id]/purge`) is the only place that scrubs
    - Identity survives, so SIGN-IN must be refused explicitly.
    - Notifications are suppressed at two chokepoints, not per channel.
    - NEVER test for a purged row with a bare `purgedAt != null`
    - Callers MUST short-circuit an already-disabled row before calling `deactivateUserInTx` — re-running it on a disabled ADMIN sees its own row excluded from the count and throws `LastAdminError` spuriously.
    - An admin-action audit row ABOUT a user goes under that user's `user:<id>` target and names them by `targetUserId` (+ `targetUser` only when they have a display name), never by email; any other id (a session, a request) goes in details. A request moderation row (`request:<rid>`: REQUEST_APPROVE/DECLINE/DELETE) names the requester by `requesterId` (+ `requestedBy` only when they have a display name — `requesterAuditDetails`). The purge finds `user:<id>` rows by target, the moderation rows of every request the account still OWNS by exact request id (`scrubOwnedRequestPii`), request rows by `requesterId` (`scrubRequesterPii`), and legacy `session:<sid>` revoke rows and `requestedBy`-only request rows by the email read before the purge rewrites it — NEVER by display name. NEVER put an email (or anything with a `"`/`\` in its JSON) into a Prisma `contains` term: it is a LIKE with no ESCAPE; narrow by key/target/action and let the exact `match` predicate decide.
    - NEVER page an update-while-reading loop with Prisma `cursor` + `skip: 1`: the cursor positions on the UNFILTERED table, so once the loop rewrites the cursor row out of the filter, `skip: 1` drops the next matching row. Page on a strict `id: { gt: lastId }` bound (`scrubTargetPiiFromAudit`).
    - An admin-target pre-check uses `isAdminTarget` ([account-lifecycle.ts](src/lib/account-lifecycle.ts): the ADMIN role OR the ADMIN bit) — the same rule as the in-transaction `lockTargetInTx` re-check.
    - A MANAGE_USERS delegate manages accounts at or below its own level: every delegate-reachable `/api/admin/users/[id]` handler decides through `targetRefusal(row, callerPerms)` before its transaction and again under lock 42 (`lockTargetInTx(tx, id, callerPerms)`). A target whose EFFECTIVE mask holds `MANAGEMENT_MASK` bits the caller lacks is refused 403; the same or fewer bits stay manageable. NEVER gate a new handler there on `isAdminTarget` alone; a system caller passes `Permission.ADMIN`. `tests/account-lifecycle.test.mts` and the "peer rule" tests in `tests/admin-routes.test.mts` pin it.
34. **`MediaServerUser → User` attribution resolves on the provider SUBJECT id first, email second — and NEVER overwrites a manual pin.** This binding is what makes play history belong to somebody: both `getMyWatchHistory` and every admin per-user view resolve through `MediaServerUser.userId`.

    Detail and rationale: [docs/guardrails/34.md](docs/guardrails/34.md).

    Rule index (every rule, with its reasoning, is in the detail file):
    - Neither resolver may filter on `deactivatedAt`
    - `manualUserLink = true` means an admin set the binding by hand — automatic resolution must skip the row entirely.
    - The subject match stays instance-agnostic even though SIGN-IN is bound to a server (34e).
34a. **The request watch grade scores only APPROVED, MATURED, COVERED requests, reads attribution through `linkedIdentityBranches`, and never gives an F to a user whose watches can't be seen.** Rules in [watch-grade.ts](src/lib/watch-grade.ts), data in [watch-grade-data.ts](src/lib/watch-grade-data.ts).

    Detail and rationale: [docs/guardrails/34a.md](docs/guardrails/34a.md).

    Rule index (every rule, with its reasoning, is in the detail file):
    - Only APPROVED requests are graded, and approval counts per TITLE on an instance.
    - `MediaRequest.approvedAt` records DECISIONS, and only the `/api/requests` routes (POST's create path lives in [request-create.ts](src/lib/request-create.ts), which the watchlist auto-request shares — …
    - Rows older than the column carry their `createdAt`, stamped ONCE EVER
    - TV is scored PER SEASON and the best season counts
    - One title, one unit.
    - Other viewers are PEOPLE, counted through the same linkage rule.
    - The audience is read ONLY where it can change a verdict
    - The letter cutoffs and the requests a letter needs are settings, and cutoffs must stay STRICTLY descending.
    - The preview judges exactly what a save would
34b. **A watchlist auto-request files ONLY through `createMediaRequest` ([request-create.ts](src/lib/request-create.ts)), and the `AutoRequestLedger` is what stops it re-requesting in a loop.** Rules in [auto-request.ts](src/lib/auto-request.ts), the Plex half in [plex-watchlist.ts](src/lib/plex-watchlist.ts).

    Detail and rationale: [docs/guardrails/34b.md](docs/guardrails/34b.md).

    Rule index (every rule, with its reasoning, is in the detail file):
    - Never write a `MediaRequest` from the auto-request code.
    - `requested` is TERMINAL.
    - A Summonarr watchlist add is always attempted
    - Gates, in order:
    - The Plex token is the user's own
    - The SERVER-TOKEN path is the optional second way in
    - An ADMIN-token 401/403 NEVER reaches the branch that deletes a user's `Account` rows.
    - Consent: the server path reads only users with `User.plexWatchlistOptInAt` set
    - Friend → user is subject-first and never by email
    - Every POLLED source files through `fileAutoRequestTitles` ([auto-request.ts](src/lib/auto-request.ts))
    - Discord's `/watchlist add` is a Summonarr watchlist add
    - The Discord `/request` pick files through `createMediaRequest` too; shared request rules live in [request-policy.ts](src/lib/request-policy.ts), never in a route
34c. **A user's Trakt account is connected ONLY by the device-code flow, its tokens live ONLY in an `Account { provider: "trakt" }` row, and only a REFUSED grant ends the connection.** Rules in [trakt-user.ts](src/lib/trakt-user.ts), cron `/api/cron/sync-trakt` (lock `TRAKT_SYNC_LOCK_ID`, `TRAKT_SYNC_INTERVAL`).

    Detail and rationale: [docs/guardrails/34c.md](docs/guardrails/34c.md).

    Rule index (every rule, with its reasoning, is in the detail file):
    - The device code never leaves the server.
    - Both app credentials are admin Settings, both encrypted
    - Tokens are raw on write
    - Refresh before use, write both tokens together.
    - Watchlist auto-request is 34b, unchanged:
    - The history is imported, never read live
    - In For You the Trakt history IS watch history, under the SAME cap.
34d. **Linking, unlinking or auto-linking a media-server identity needs the ADMIN bit. A MANAGE_USERS delegate keeps only the download-policy half of the route, and may not create a local account under a media-server user's email.** [server-users/[id]](src/app/api/admin/server-users/[id]/route.ts), [admin/users POST](src/app/api/admin/users/route.ts).

    Why:
    - Linking an identity is what makes its watch history readable by its new owner (`/api/play-history/mine*`).
    - Delegates used to be allowed to re-link ordinary members, guarded only against themselves, admins and the server owner. But a delegate can create a local account with a password they choose, so they could link a member's identity to that puppet account, sign in as it and read everything the member watched.
    - `resolveMediaServerUser` falls back to an EMAIL match for an identity with no provider-bound account (34). A delegate creating `friend@…` with a password of their choosing got that friend's identity bound to it on the next poll.

    Rules:
    - The route refuses `userId`/`autoLink` from a caller without the ADMIN bit with a 403, before it reads the identity, and writes nothing. A body mixing `downloadsEnabled` with a link field is refused whole: 400 for an ADMIN (a delegate gets the 403 first).
    - The Users page passes `canLink` (the ADMIN bit) to the server-user table. A delegate sees each binding read-only and is sent no account list.
    - An ADMIN keeps the unrestricted escape hatch, which is why the route exists.
    - An account created through `POST /api/admin/users` by a caller without the ADMIN bit is marked `User.createdByDelegate`, and automatic linking NEVER binds a marked account to an identity by EMAIL: `emailLinkAllowed` ([play-history-identity.ts](src/lib/play-history-identity.ts)) is the one rule for both automatic email linkers (`resolveMediaServerUser`, the hourly Jellyfin sync). The create-time 403 only sees identities that exist today, so a delegate could pre-create `future-friend@…` and inherit that person's history when they joined. A subject match and an ADMIN's manual link are unaffected; the marker is never cleared and never on the wire. A new automatic email linker must call `emailLinkAllowed`.
    - `tests/admin-routes.test.mts`, `tests/server-users-link-ui.test.mts` and `tests/admin-users-audit-routes.test.mts` pin it.
34e. **A sign-in identity is bound to the source that vouched for it: a Jellyfin id to the server it was FIRST seen on (`User.jellyfinInstance`), an OIDC subject to its issuer (`Account.issuer`). The `jellyfin-<id>@jellyfin.local` address is NEVER a lookup key, and no human-created account may hold a reserved domain.** [auth-jellyfin.ts](src/lib/auth-jellyfin.ts) and [auth-oidc.ts](src/lib/auth-oidc.ts) (the identity lookups; [auth.ts](src/lib/auth.ts) re-exports them), [jellyfin-identity.ts](src/lib/jellyfin-identity.ts), [oidc-signin.ts](src/lib/oidc-signin.ts), [oidc-allowlist.ts](src/lib/oidc-allowlist.ts), [reserved-email.ts](src/lib/reserved-email.ts).

    Detail and rationale: [docs/guardrails/34e.md](docs/guardrails/34e.md).

    Why:
    - Jellyfin sign-in matched the global `User.jellyfinUserId` from ANY configured server. Whoever runs a second registered server controls its database, so they could mint a user carrying an admin's id and sign in as the admin. OIDC matched `sub` alone, so a changed `OIDC_ISSUER` could sign a new IdP's user into an old account.
    - Jellyfin sign-in fell back to ANY row whose email was the synthetic address, so a delegate or an OIDC user who created that address inherited the Jellyfin user's next sign-in.

    Rule index (every rule, with its reasoning, is in the detail file):
    - A mismatched server or issuer is REFUSED (`instance_mismatch` / `issuer_mismatch`), never re-bound. A pre-34e null adopts with a conditional write — Jellyfin by the first-seen rule, OIDC on its next sign-in. A NEW Jellyfin account takes the first-seen rule too: an id first seen on another server is refused `instance_mismatch` and nothing is created, so a twin can't sign in before its owner and take their history.
    - The OIDC groups box splits on NEWLINES only (`parseGroupLines`, [oidc-allowlist.ts](src/lib/oidc-allowlist.ts)): a comma is legal in a group name (an LDAP DN, `Plex, Friends`), and splitting there stores fragments that match nothing or an unrelated group. Domains still accept commas.
    - Both OIDC routes go through `resolveOidcSignIn`: allowlist, lookup, verified-only `notificationEmail`, an audited `AUTH_LOGIN_FAILED`. Never re-inline any of it in a route.
    - The OIDC allowlist fails CLOSED on an unreadable value and applies to returning users too. Nothing in it ends a session: disabling a user at the IdP does NOT sign them out of Summonarr — deactivate them (33).
    - The flow cookie is `__Host-` on HTTPS, and the callback never falls back to the unprefixed name there.
    - Reserved domains (`@jellyfin.local`, `@discord.local`, `@deleted.invalid`) are refused at register, `POST /api/admin/users`, OIDC create and Plex create.
    - The binding gates SIGN-IN only. Attribution (34) still matches the subject across servers.
35. **A Plex/Jellyfin server is identified by a `serverInstance` slug string, and availability is a UNION across every configured server — NOTHING routes to a specific one.** Mirrors guardrail 32's arr model with that one deliberate divergence: an arr *request* must land on exactly one instance, whereas the only question multi-server answers here is "is this watchable somewhere, and what's playing right now."

    Detail and rationale: [docs/guardrails/35.md](docs/guardrails/35.md).

    Rule index (every rule, with its reasoning, is in the detail file):
    - Key derivation is centralized in [media-instances.ts](src/lib/media-instances.ts)
    - Every library write is `serverInstance`-scoped and every fan-out is all-or-nothing
    - `TVEpisodeCache` has no `serverInstance` column
    - Session ids carry the instance, and the finalize ledger must respect it.
    - Auth: the membership union fails open, and an INDETERMINATE instance poisons it.
    - On the PLEX membership, poller, backfill and SSE paths, read config with `setting.findUnique` ONLY
    - Per-instance secret Setting keys must stay encrypted.
    - De-registering an instance must clean up its derived rows
    - A RESTRICTED instance's library counts only for users granted it, and that answer must be produced in the DATA layer.
    - The sync-side grant filter is PRE-CAS, and that is not a style choice.
    - Instance-aware surfaces:
    - Still default-only by design (not gaps):
35a. **A list built from USER records (votes, requests, anything keyed by title) subtracts the titles hidden from the viewer BEFORE paging — `titlesHiddenFromViewer` ([media-visibility.ts](src/lib/media-visibility.ts)) — never only at the write gate.**

    Why:
    - `POST /api/votes` refused a vote on a title the voter couldn't see (35), but `GET /api/votes` and the `/votes` page listed every voted title to everyone: a restricted server's holdings, with other voters' reasons about them, were one page view away for any account.

    Rules:
    - Hidden = held ONLY on servers the viewer holds no grant for. A title the viewer can see somewhere is not hidden, and neither is one in no library at all (a vote outlives the copy). The scope goes into the paging `where` (`NOT: titleKeysWhere(hidden)`) and the total is reduced by it, or page counts drift.
    - The helper reads the registry once, returns `[]` with no library read on an unrestricted deployment, for an ADMIN, or for a fully granted user, and takes a LAZY key loader so the page pays the voted-titles read only when something is hidden.
    - `tests/media-visibility-read-path.test.mts` pins the list and the fast path (mutation-verified).
    - `POST /api/report` `vote_reason` follows the votes list: the votes feature on, a non-blank reason, another voter's vote, a title not hidden from the reporter — else the 404 of a missing vote.
    - The viewer's own "not interested" titles (`HiddenItem`) leave a paged POOL the same way: `/top` and `/api/top-rated` share ONE pipeline ([top-rated.ts](src/lib/top-rated.ts)) that drops them before paging and orders its default view from CACHED IMDb ratings only (`readCachedImdbRatings`, never an upstream warm over the pool); `attachAllAvailability` drops them BEFORE enrichment.
36. **An unconfigured media server is SKIPPED, never failed. A client must decide that BEFORE the request, not from the response.**

    Detail and rationale: [docs/guardrails/36.md](docs/guardrails/36.md).

    Rule index (every rule, with its reasoning, is in the detail file):
    - Pass `plexConfigured`/`jellyfinConfigured` from the server component and call only what exists.
    - `/api/sync` reports `skippedSources` alongside `failedSources`
    - Red means a CONFIGURED server failed.
    - Never sum `plexMarked` and `jellyfinMarked`.
    - One POST to `/api/sync` already syncs Jellyfin.
37. **NEVER build a Jellyfin series→tmdbId map from `JellyfinLibraryItemData.itemId` alone — use `buildSeriesItemIdIndex`.** This is the SAME-server, multi-*library* twin of guardrail 35 (which is about multi-*server*); the two are independent.

    Detail and rationale: [docs/guardrails/37.md](docs/guardrails/37.md).

    Rule index (every rule, with its reasoning, is in the detail file):
    - `JellyfinLibraryItem.jellyfinItemIds String[] @default([])` holds EVERY id the title occupies, `jellyfinItemId` included.
    - Every read ORs the two columns — never swap wholesale to `has`/`hasSome`.
    - Which copy becomes the stored row is `prefersCandidate` — newest `addedAt`, item-id tiebreak — NOT arrival order.
    - fix-match remaps EVERY copy, serially.
    - A title-mode transaction re-reads the old row under the library lock and derives what stays on it from THAT read (updateMany/deleteMany only). TV plays move by the row key only when every copy left the old row; otherwise by `sourceShowId` of the moved copies.
37a. **A fix-match runs as a BACKGROUND JOB with a polled status — never as a request the browser waits on.** `POST /api/admin/fix-match` with `async: true` answers 202 + `jobId` at once and the client polls `GET /api/admin/fix-match/status?id=`; the registry is [fix-match-jobs.ts](src/lib/fix-match-jobs.ts), the client half is [client/fix-match.ts](src/lib/client/fix-match.ts).

    Why:
    - A Jellyfin series identify keeps refreshing every season and episode for minutes after `RemoteSearch/Apply` returns, and the route (rightly) waits to confirm. A reverse proxy keeps one request open for ~60s (nginx, NPM) to 100s (Cloudflare), so the browser got a **502 while the remap succeeded** — the operator saw "failed", retried, and queued yet another full refresh on an already-busy server.
    - The in-process job outlives the request the same way guardrail 17's backfill does (single long-lived Node server). The status route 404s after a restart and the client tells the operator to re-sync instead of retrying.

    Rules:
    - The synchronous default (no `async`) is a **wire contract the iOS app pins** — keep it byte-identical; gate a native switch on the reported `apiVersion` (guardrail 25), never by changing the default.
    - The same key (server + instance + mediaType + from→to) already running ⇒ the same job is returned, never a second remap of one title.
    - A job's `error` is the client-safe message only — the route still logs the real detail before throwing `FixMatchError`. A failed remap's message is a TRANSLATED diagnosis (`FixMatchDiagnosticError` → `apiAdmin.fixMatch.*` via `clientFailure`, [fix-match-run.ts](src/lib/fix-match-run.ts)) whose variables are ids, counts and a library name only.
    - Only an IDENTICAL job joins. A job that would rewrite the same item under another target — same item, or a title-mode job and any job on that title — is refused 409 ([fix-match-conflicts.ts](src/lib/fix-match-conflicts.ts)).
    - Jobs past `MAX_RUNNING_JOBS` QUEUE (status `queued`, `queueAhead` on the status route; a bounded queue 429s past `MAX_QUEUED_JOBS`) — they are not refused. A queued job is never a stall.
    - The client gives up on a RUNNING job only when its progress signature stops changing (`STALL_LIMIT_MS`), never on a fixed wall-clock window: copies run serially and a multi-copy series legitimately outlasts any fixed number. Every runner therefore reports each attempt, phase and copy (`copy`/`copies`) through `report`.
    - A client job poller that gives up on network failures or a proxy's own 5xx (a body that is not JSON — nginx's 502/504, Cloudflare's 520–524) answers status 0 ("no answer — it may still be running"), NEVER the proxy's status: every caller reads a non-2xx as the job's own failure. Every answer of a job route is JSON, a thrown job's `null` 500 included, so it stays terminal. The loop is ONE shared helper, `pollJob` ([job-poll.ts](src/lib/client/job-poll.ts)), used by `runReplaceFileJob`, the release searches and the title manager's file delete; `tests/client-job-poll.test.mts` pins it. A 2xx that is not JSON or was redirected is a FAILED poll too, and `onGiveUp("unreachable" | "outOfPolls")` tells the two status-0 cases apart. The 502/503/504 set is one constant, [gateway-status.ts](src/lib/gateway-status.ts) — pair it with "is the body the route's own JSON".
    - A Plex title remaps EVERY copy in `plexRatingKeys` (the twin of the Jellyfin loop), touching a rider key only when Plex says it still carries the old id; copies that fail stay on the old row. Both servers carry the removed row's descriptive columns to the corrected row and UNION item keys into an existing target row (`fix-match-rows.ts`) — a remap never replaces keys or drops `addedAt`.
    - The job tray (`GET /api/admin/fix-match/jobs`, `FixMatchTray`) is coarse: title, server, status, outcome — never a ratingKey, path or token.
    - A fix for an issue sends `issueId` with the async POST (title mode only); the JOB closes the issue on success through `resolveIssueAfterAction` ([issue-transitions.ts](src/lib/issue-transitions.ts): a CAS to RESOLVED, only for an issue about the same title, refused to a non-ADMIN in maintenance) and reports `issueResolved`. NEVER close it from the browser after the poll — the close must not depend on the tab staying open. A joined job closes the joiner's issue too; the synchronous POST ignores `issueId`.
37b. **Exactly one TMDB id may keep a `PlexLibraryItem` row per conflated Plex ratingKey, and WHICH one must resolve the same way on every run.** The Plex twin of 37's `prefersCandidate`. One definition — [plex-dedupe.ts](src/lib/plex-dedupe.ts) — called by BOTH writers, the orchestrator's Plex arm and the admin Resync route.

    Detail and rationale: [docs/guardrails/37b.md](docs/guardrails/37b.md).

    Rule index (every rule, with its reasoning, is in the detail file):
    - Look the prior mapping up BY RATING KEY
    - Honour a pin only when its tmdbId is in the batch.
    - Every remaining choice is a total order over the candidates, never arrival order.
    - One definition, not two agreeing copies.
    - Which COPY of a duplicated title is kept is `prefersPlexCopy` ([plex-library.ts](src/lib/plex-library.ts)): newest `addedAt`, an undated copy never beats a dated one, then the greater ratingKey — in a section and across sections.
37c. **A Plex title's EVERY ratingKey on a server lives in `PlexLibraryItem.plexRatingKeys`, and every ratingKey read ORs it against `plexRatingKey`.** The Plex twin of 37 (`jellyfinItemIds`).

    Detail and rationale: [docs/guardrails/37c.md](docs/guardrails/37c.md).

    Rule index (every rule, with its reasoning, is in the detail file):
    - Written by both Plex writers (orchestrator arm, `/api/sync/plex`) from `plexLibraryRatingKeys(data)` — canonical key first, then `duplicateRatingKeys` collected across sections, within a section, and from legacy-agent resolution (`foldDuplicateRatingKeys`, which NEVER mutates: one entry object is …
    - `plexRatingKeys` is NEVER made exclusive on write.
    - Folding copies is LINEAR: collect every losing copy's ratingKey per tmdb id and call `foldDuplicateRatingKeys` ONCE per id after the walk — NEVER `withDuplicateRatingKeys` in a loop on a growing accumulator (cubic with `keys.includes`: a hostile Plex server listing a few thousand items under one tmdb guid froze the event loop). `tests/plex-dup-keys-bounds.test.mts` counts the work.
    - A key held by several rows resolves through `pickPlexRowForKey` / `indexPlexRowsByKey` ([plex-dedupe.ts](src/lib/plex-dedupe.ts)) — the canonical holder, else the lowest tmdbId (37b's total order); the ONLY place one owner is picked — NEVER a `findFirst` without an order, and never last-write-wins …
37d. **ALWAYS send `CollapseBoxSetItems=false` (`JELLYFIN_NO_COLLECTION_GROUPING`, [jellyfin-http.ts](src/lib/jellyfin-http.ts)) on every Jellyfin `/Items` query that can list a Movie or a Series.**

    Why:
    - Summonarr calls Jellyfin with an API key, and an API key has no user. For a user-less query Jellyfin replaces every member of a collection with its BoxSet. The server's "group movies/shows into collections" settings are only read when there IS a user, so turning them off does nothing for us. `ExcludeItemTypes=BoxSet` doesn't help either, because the grouping runs after the type filter. Neither does `MinDateLastSaved` or `SearchTerm`. Only an explicit `false` always wins (`Folder.CollapseBoxSetItems` / `AllowBoxSetCollapsing` in Jellyfin's source).
    - Seen live on Jellyfin 12.2 (2026-10-13): the library sync was missing 2,230 of 9,134 movies, every one of them in a TMDB collection. Each read as "Plex only", and requests for them never saw Jellyfin. Practical Magic 2 arrived, Jellyfin created the Practical Magic Collection, and the 1998 film disappeared with it. A user token sees everything, so a check made while signed in to Jellyfin looks fine. Reproduce with an API key.

    Rules:
    - Every `/Items` query is built by `jellyfinItemsUrl` ([jellyfin-http.ts](src/lib/jellyfin-http.ts)), which adds the flag after the selection params unless the query is Episode-only — the sync, the availability probe, the never-watched played-items read and fix-match's confirmation search included. A query limited to `Episode` can't be grouped and is exempt.
    - The library sync never turns a BoxSet into a title. A listing that still returns one logs once through `warnOnChange` (7b): it means the server ignored the flag and titles are missing.
    - `tests/jellyfin.test.mts` stubs the grouping (members appear only when the flag is sent) and scans `src` for `/Items?` literals that can list a Movie or Series without it (only the builder's own literal is exempt). Every site is mutation-verified.
37e. **A library match check Fix rematches ONE item (fix-match's `itemKey` mode), and the route believes only the stored flag.**

    Why:
    - The tmdbId mode remaps EVERY copy holding the old id (37). A title often holds a correct copy beside the wrong one ("Ghost in the Shell (2017)" matched to the 1995 film's id beside the real 1995 film), and "fixing" the id would rematch the correct copy too.
    - An unmatched item has no id and no library row, so the tmdbId mode can't name it at all.

    Rules:
    - `itemKey` only NAMES an item the last stored check flagged on that server and instance (`findMatchFlag`). The current id, media type and path come from the flag, never the body. An item the check didn't flag is a 404, and a malformed key is a 400, with nothing sent.
    - The DB phase moves only that key (`moveItemToTitleInTx`). The item leaves every other title's row on its server: a row left with no copy is deleted, and a row whose canonical copy it was falls back to its next copy. It joins the corrected title's row. Plays move by THIS item's key, never filtered by the old id (an unmatched item's plays carry none): a movie by `sourceItemId`, an episode by `sourceShowId`. The episode cache is left to the next full sync, which has no item key to move one copy's episodes. The flag leaves the stored report in the same transaction.
    - Item jobs are keyed by the item (`fixMatchJobKey`), so two unmatched items fixed to one title are two jobs. The tmdbId mode and its wire contract are unchanged.
    - `tests/fix-match-routes.test.mts`, `tests/library-match.test.mts` and `tests/library-match-data.test.mts` pin it. 20 of 21 mutations fail a named test; the survivor removes a redundant abort check.
37f. **A library item's on-disk path is ADMIN data. A route a MANAGE_ISSUES delegate can reach (fix-match `file-info`, `candidates`) answers them the FILE NAME only — `libraryPathFor` ([library-path-view.ts](src/lib/library-path-view.ts)) — and a title-keyed cache is projected on the way OUT, never on the way in.**

    Why:
    - `library-sample-paths` and `issues/[id]/files` are `withAdmin` because mount layout is admin data, but the two `withIssueAdmin` fix-match reads returned every configured server's full paths for any tmdbId a delegate named — the whole library's filesystem layout, by enumeration.
    - The candidates cache is keyed by the title, so a projection applied before `setCachedCandidates` would serve an ADMIN's full paths to the next delegate, or a delegate's names to the next ADMIN.

    Rules:
    - The dialogs only ever showed the file name (the path was a tooltip), so the delegate view loses nothing they used. The arr path match inside the route still uses the full path.
    - `tests/fix-match-routes.test.mts` pins both routes for a delegate and the cached answer for both roles.
38. **`'unsafe-eval'` in the CSP is gated on `NODE_ENV === "development"` and NEVER widens. Don't delete the branch either.**

    Why:
    - React's development build calls `eval()` to reconstruct server-side error stacks in the browser, and Turbopack's HMR runtime evaluates modules the same way. Without the carve-out every `next dev` page logged *"eval() is not supported in this environment"* and those debugging features were dark — a permanent console error that trains people to ignore the dev console, which is the only place dev-only hydration **warnings** ever surface (guardrail 16a).
    - Widening it is a real vulnerability, not a lint nit: `'unsafe-eval'` makes any string reaching `eval()`/`new Function()` executable, which is most of what the per-request nonce + `'strict-dynamic'` policy exists to prevent. Production is the response an attacker can reach.

    Rules:
    - The condition lives in [src/proxy.ts](src/proxy.ts)'s `buildCsp(nonce)`, which reads `NODE_ENV` on every call. `next build` sets `NODE_ENV=production`, so Turbopack constant-folds the branch away — the string is **absent from the production bundle**, not merely false at runtime. Verify that way (`grep unsafe-eval` the built `.next/server/chunks/*.js`), not by reading the source.
    - `tests/proxy.test.mts` pins BOTH directions (development grants it; `production`/`test`/unset never do). A one-sided pin would be satisfied by a hardcoded constant — keep both.
    - Next's CSP guide documents this exact carve-out and states neither React nor Next uses `eval()` in production. `style-src` needs no dev branch here: it is already `'unsafe-inline'` in every environment.
    - [SECURITY.md](SECURITY.md) describes the **shipped** posture. It stays accurate only while this branch is dev-only — if that ever changes, that file changes with it.
39. **A new `tw-merge` group goes BEFORE the catch-all it narrows, and `npm run audit:tw-merge` must stay green.**

    Detail and rationale: [docs/guardrails/39.md](docs/guardrails/39.md).

    Rule index (every rule, with its reasoning, is in the detail file):
    - Order is load-bearing
    - Constrain the value shape when the prefix is an ordinary word.
    - An arbitrary value's GROUP is decided by its value shape, exactly as Tailwind types it — through the shared fragments at the top of [tw-merge.ts](src/lib/tw-merge.ts) (`LEN`, `WIDTH_ARB`, …
    - Utilities that COMPOSE get one group EACH, never a shared one.
    - A group whose NAME can equal a real class is a trap.
    - A shorthand never evicts a longhand — override a primitive's longhand with the SAME longhand (`px-0`, never `p-0`).
    - Variants are split at the LAST top-level `:`
    - Legitimate same-family collapses are allowlisted with a reason
40. **"For You" per-title data is SERVER-WIDE, and it is the ONLY source. The engine makes no upstream call at all — the SCHEDULING is what makes that safe.**

    Detail and rationale: [docs/guardrails/40.md](docs/guardrails/40.md).

    Rule index (every rule, with its reasoning, is in the detail file):
    - The order is the guarantee: SELECT, then BUILD, then COMPUTE.
    - A seed cap IS a build-budget knob — changing one changes what the build must cover.
    - The required set is built WITHOUT the per-run cap.
    - `conclusive` is derived from SEED COVERAGE, not from whether anything came back.
    - A graph refresh that THROWS aborts the run (the orphan sweep alone is survived, as `sweepFailed`).
    - Coverage is the NODE STAMP (`suggestionsRefreshedAt`), never the presence of edges.
    - `RecommendationTitle` has TWO distinct null states and they are not interchangeable.
    - The stored verdict is deliberately TMDB-FREE; re-blend the TMDB term per candidate with `withTmdbTerm`
    - Verdicts are resolved PRIORITY-FIRST over the required set's own suggestion targets
    - Never stamp a VERDICT from a failed lookup either, and clearing a cache must reach the copies.
    - Never stamp a source from an INCONCLUSIVE page.
    - The warm-library cron pre-builds the same edges, and that is an ACCELERANT — never a substitute for the required build.
    - **NEVER gate the required build on it.** `refreshRecommendationGraph` must keep building the required set uncapped on every recommendations run; a prewarm that already covered a title simply makes that build find it TTL-fresh and do nothing.
    - The trending/popular pool is warmed by the refresh, not by the first user.
40a. **Every cached TMDB payload is ENGLISH. Another language is a display-time OVERLAY (`localizeMedia`, [tmdb-localize.ts](src/lib/tmdb-localize.ts)) — NEVER add `language=` to a fetch whose result lands in a shared cache key.**

    Detail and rationale: [docs/guardrails/40a.md](docs/guardrails/40a.md).

    Rule index (every rule, with its reasoning, is in the detail file):
    - English is a no-op that returns the input array
    - A details blob has ONE key builder and ONE content builder (`tmdbDetailsKey`, `buildDetailsMedia`).
    - Serve-stale namespaces are never lazily deleted.
    - Country names: TMDB's `production_countries[].name` is authoritative and the English page renders it unchanged; another language is translated through Intl ONLY via `localizedProductionCountry` …
    - Stored data stays English; each SENDER localizes the title for the language its message is WRITTEN in, at send time, never written back.
    - The iCal feed reads cached translations ONLY
    - A language-tagged poster is chosen per locale by vote; a poster tagged with a region must match one of the locale's tags, and a region-less Chinese poster is NEVER used for `zh` (the script can't be told — Traditional posters would leak into Simplified).

40b. **The BROWSER is sent a subset of the message catalog — `clientCatalog` ([catalogs.ts](src/lib/i18n/catalogs.ts)), never `CATALOGS` — and a client module may only read keys from areas it is sent.**

    Why:
    - The root layout serialises the active catalog into every full page load; all 24 areas were ~94 KB gzipped on every document, the login page included. The server translates from `CATALOGS` (every area) and is unaffected.

    Rules:
    - `SERVER_ONLY_AREAS` (`apiAdmin`/`apiAuth`/`apiUser`) are never sent; `ADMIN_ONLY_AREAS` (admin queue/arr/manage, settings, trash) go only to a session passing the admin layout's gate (computed in the root layout from the session claims). A new area is sent to everyone unless it is added to one of those lists.
    - NEVER read a server-only key from a module a client component imports, and NEVER read an admin-only key from non-admin client code: the key renders as the raw string. `tests/i18n-client-catalog.test.mts` walks the client import graph to prove both; a file-level false positive is allowlisted there WITH a reason (and a check that no client calls the server-only function).
    - Admin client UI belongs under `components/admin|settings` or `app/(app)/admin|settings`; a shared component that must show in non-admin views (`activity-ui`) keeps its area in the sent set (`adminActivity` is).
    - The scan reads COMMENTS too: a shared client module (`src/lib/client/*`) must not quote an admin-only key even in an example once a non-admin view can import it.

40c. **"For You" is built from the VIEWER'S OWN records: the media servers' own history and Jellyfin favorites (`ServerWatchedTitle`), Trakt history and ratings, watchlist and requests. Cross-viewer co-watching (`CoWatchSuggestion`) is OPT-IN behind `feature.behavior.forYouCoWatch`, default OFF — and NEVER a play: nothing here writes or is read as `PlayHistory`.** [server-watch-history.ts](src/lib/server-watch-history.ts) (pure) + [server-watch-history-data.ts](src/lib/server-watch-history-data.ts) (phase 0 of the warm-recommendations run), taste and quit-show rules in [recommendations.ts](src/lib/recommendations.ts), co-watch build in [recommendation-graph.ts](src/lib/recommendation-graph.ts).

    Detail and rationale: [docs/guardrails/40c.md](docs/guardrails/40c.md).

    Why:
    - PlayHistory starts the day Summonarr was installed (guardrail 19), so For You seeded from a sliver of a viewer's taste and recommended films they had watched years before.
    - "Watched" is not "liked": a 3/10 seeded "Because you watched…", and two episodes of a 60-episode show read as a fan.

    Rules:
    - The import is INCREMENTAL and per identity: Plex is walked back only to the oldest identity's read point (`ServerWatchCursor`), each Jellyfin user is asked only what they played since theirs. A recent unresolved play (`UNRESOLVED_HOLD_MS`, 48 h) holds the read point just before it. An identity's rows and read point commit in ONE transaction, and a read point counts strictly AFTER itself — never at — so no play counts twice. A Jellyfin incremental read adds ONE play per item, never its lifetime `PlayCount`. An aborted walk writes nothing. Owner unknown ⇒ the owner's read point HOLDS (19e's rule).
    - A rating ≤ 4 removes ONLY its own seed — never fanned out to similar titles (the 2026-08 audit rejected anti-seed neighbourhoods). Ratings ride the Trakt "use my history" switch and are deleted wherever the history is (switch off, disconnect, revoked grant, purge).
    - Every seed keeps one of the three wire labels (`WATCH_HISTORY`/`WATCHLIST`/`REQUEST`); a loved-pool seed is `WATCH_HISTORY`. NEVER add a `RecommendationSeed` value for these — the iOS app decodes the enum.
    - Co-watch OFF ⇒ the per-viewer pass reads no edge, the build DELETES any left, and the import reads and stores only identities LINKED to an account by the read side's own rule, `linkedIdentityBranches` (the FK, or an account's provider subject on a row an admin has not pinned — 34); an unlinked one costs no request. ON ⇒ every active identity is imported, since co-watching is built from everyone's viewing. ON ⇒ an edge needs ≥ 3 distinct people (an account counts once) who watched both, ≥ 2 people who did not, ≥ 5 people with history, and it never counts toward seed coverage (`conclusive` stays TMDB-only). Its picks wear the viewer's own "Because you watched X" line. Each person pairs at most their `COWATCH_MAX_TITLES_PER_PERSON` (500) newest popular titles; once that cap binds, the non-viewer floor is held on the UNCAPPED counts.
    - `ServerWatchedTitle`/`ServerWatchCursor` FK `MediaServerUser` with `onDelete: Restrict` (28) and are deleted with a de-registered instance (35). A NAMED server removed while its import is in flight writes nothing after the removal: each identity's commit locks the registry row and re-checks the slug (`stillRegisteredInTx`).
    - `tests/server-watch-history.test.mts`, `tests/recommendations.test.mts` (the `40c` block) and `tests/trakt-user.test.mts` pin it; 20 of 21 mutations fail a named test (the survivor removes a redundant abort check). The co-watch SQL's floors were run against a real Postgres 17.

41. **A `withAdvisoryLock` callback that can run for minutes MUST observe its AbortSignal.**

    Detail and rationale: [docs/guardrails/41.md](docs/guardrails/41.md).

    Rule index (every rule, with its reasoning, is in the detail file):
    - `withAdvisoryLock` aborts the signal and rejects at the timeout but HOLDS the lock until the work settles, at most `settleGraceMs` (default: `timeoutMs`) more — so a second copy can't start beside a slow one; the rules are unchanged.
    - RETURN, never throw, on abort.
    - The sync orchestrator is the same rule with a worse consequence, and its checks go at ARM and later PHASE boundaries, NEVER inside a `$transaction`.
    - The SSE lock-race retry is count-bounded too
42. **Every colour in UI code must survive BOTH themes and all six accents. NEVER write `text-white`, `bg-white`, a raw hex, or an `oklch(1 0 0 / …)` tint on a surface; NEVER re-add `cursor-pointer` to a `<button>`.**

    Detail and rationale: [docs/guardrails/42.md](docs/guardrails/42.md).

    Rule index (every rule, with its reasoning, is in the detail file):
    - The accent has two tokens: `--ds-accent` is a FILL (under `--ds-accent-fg`), `--ds-accent-text` is the accent as TEXT or an ICON on a surface.

## Working principles

Guardrails above are *what the code should look like*. These are *how to approach changes* — process rules adapted from a sibling project. They matter disproportionately in this codebase because Summonarr is an API-juggling aggregator: five upstream services (Plex, Jellyfin, Radarr, Sonarr, TMDB), multiple cache tables mirroring them, and a sync orchestrator that mutates shared state from several paths.

### Writing future rules in this file

1. **Absolute directives** — lead with `ALWAYS` or `NEVER`.
2. **Why first** — one to three bullets on the failure mode before the fix.
3. **Concrete commands or code** — no abstractions where a shell command will do.
4. **One point per block** — don't bundle unrelated examples.
5. **Bullets over paragraphs.**
6. **Attach to a topic; don't join the queue at the tail** — see numbering below.

Use ❌/✅ examples only when the antipattern is subtle. Do not add "warning signs" sections to obvious rules.

#### Numbering — a guardrail id is a permanent address

**NEVER renumber an existing guardrail.** ~710 comments across `src/`, `tests/` and `scripts/` cite rules by number (`guardrail 23`, `guardrail 6b`), and merged commit messages cite them too and can never be edited. Renumbering silently repoints every one of those at the wrong rule, and nothing would catch it. A retired rule leaves its number burned — never shift the ones below it to close the gap.

**Default to a letter suffix on the nearest related guardrail** (`13a` directly after `13`), not the next number at the bottom of the list. This is the collision fix, not a style preference:

- Everyone who appends at the tail claims the same next number, so two branches in flight both take it. That happened twice in one afternoon (36 and 37 were each claimed by two branches), and it costs a manual renumber every time.
- Git only warns when the inserts land close enough to conflict textually. Resolve a conflict by "keeping both", or land two rules git auto-merges, and the file ships two rules wearing one number — from then on every citation of it is ambiguous.
- Suffixing puts each new rule next to its topic, so concurrent branches edit *different regions* of the file and stop meeting at all. Two branches suffixing the SAME parent still conflict — correctly, because they wrote overlapping rules about one topic and someone should reconcile them.

Take the next sequential number only for a genuinely new top-level topic with no parent to attach to. Expect to lose the race for it; **on any collision renumber YOUR rule, never the one already on the integration branch** — its number may already be cited in code that landed with it.

`tests/guardrail-ids.test.mts` enforces this: ids unique, every in-file `guardrail N` citation resolves, and a suffixed rule sits directly after its parent. It does NOT require the numbers to be gapless or sorted — the citations are what matter, not tidiness.

**ALWAYS apply a new rule to the current work immediately after writing it.** A rule born from a mistake means the codebase likely contains other instances of the same mistake. Writing the rule does not fix them.

### Signature / response-shape changes require a full consumer audit

**Why**: TypeScript catches most signature breaks, but two paths commonly slip through: `fetch('/api/…').then(r => r.json())` returns `any` on the client, and Prisma `select`/`include` shapes reused across files are structurally inferred. Either can silently rot on a shape change.

**ALWAYS** before changing:
- An API route response shape (`NextResponse.json({…})`)
- A shared Prisma `select`/`include` object
- An exported function signature or return type
- A `src/lib/*` util's public surface (`arr.ts`, `plex.ts`, `jellyfin.ts`, `auth.ts`, `play-history.ts` — each an entry that re-exports its sibling modules — and `cron-auth.ts`)

run a full consumer grep:

```bash
rg "functionName|typeName" -t ts -t tsx
rg "fetch\(['\"]/api/<route>" -t ts -t tsx
```

**NEVER** assume `tsc` covers it. `fetch(...).then(r => r.json() as SomeType)` lies.

**ALWAYS** update the OpenAPI document ([src/lib/openapi/](src/lib/openapi/) — the route only serves `SPEC_JSON`) in the same change as the API shape it describes — its rules are under guardrail 25 ([docs/guardrails/25.md](docs/guardrails/25.md)).

### Authoritative data beats heuristics

**Why**: This app caches five upstream APIs (`TmdbCache`, `TmdbMediaCore`, `PlexLibraryItem`, `JellyfinLibraryItem`, `Radarr/Sonarr{Wanted,Available}Item`, `TVEpisodeCache`, `PlexTokenCache`). Pattern-matching against a cache row can disagree with a live API call. When they disagree, the live API is right.

**ALWAYS** structure validation as:
1. Gather heuristic evidence (cached row, UI badge, commit history).
2. Fetch authoritative data (`arrFetch`, a direct Plex/Jellyfin call, or `/api/admin/debug/arr-state`).
3. On conflict, **authoritative wins** — update or invalidate the cache, don't patch the heuristic to agree with the stale row.

### Query real API responses before diagnosing external-API bugs

**Why**: "Movie stays pending forever" can mean Radarr never grabbed it, the webhook was dropped, the `RadarrWantedItem` cache is stale, or `tvdb→tmdb` resolution is negative-cached. Symptoms are identical, fixes are not.

**ALWAYS** when a Plex/Jellyfin/Radarr/Sonarr/TMDB-facing bug lands:
1. Hit [GET /api/admin/debug/arr-state?tmdbId=<id>&type=movie|tv](src/app/api/admin/debug/) first — it dumps cache rows, live ARR check, `tvdb→tmdb` mapping, wanted-table counts, and the last `LIBRARY_SYNC` audit row. Built for exactly this.
2. If it's not an ARR problem, call the upstream API directly (`arrFetch`, or `curl` with the stored token) to see the raw response.
3. Only then design a fix.

**NEVER** plan a fix from a symptom description alone. The user sees a badge, which is downstream of the cache, which is downstream of the sync, which is downstream of the webhook, which is downstream of the upstream API. Any of those layers can be the actual source.

### Audit all mutation points for shared state

**Why**: Several fields are written from multiple paths and must stay consistent. Fixing one write site while missing the others produces inconsistencies that only manifest on specific code paths.

High-traffic shared state in this project:
- `MediaRequest.status` — written by `/api/sync/*`, `/api/webhooks/*`, `/api/requests/*`, and admin actions.
- `MediaRequest.notifiedAvailable` — atomic CAS in the sync orchestrator (guardrail 14).
- `PlexLibraryItem` / `JellyfinLibraryItem` — replaced wholesale by `full` sync, appended by `recentOnly` (guardrail 13).
- `Setting` table — shared config for Plex, Jellyfin, Radarr, Sonarr, and webhook secrets.
- `ActiveSession` — written by the 5s play-history poller ([src/app/api/sync/play-history/route.ts](src/app/api/sync/play-history/route.ts) over the `session-poll-*.ts` modules) and the Plex SSE handler ([src/lib/plex-events.ts](src/lib/plex-events.ts)), **not** by webhook handlers (there are no Plex/Jellyfin webhooks).

**ALWAYS** when touching logic that writes shared state:
1. Grep every assignment / `update` / `updateMany` / `upsert` / `createMany` / `deleteMany` on the field.
2. Trace from the first write through to the final read. Do all paths apply the same normalization?
3. If it's sync-related, verify both the `full` and `recentOnly` paths stay correct.

```bash
rg "mediaRequest\.(update|updateMany|upsert)|notifiedAvailable" -t ts
```

**NEVER** assume fixing one write site is sufficient.

### Communicate trade-offs when fixing problems

**Why**: A fix that reverts an earlier improvement needs to be an explicit, acknowledged decision — not a silent regression. This repo has several deliberate performance/correctness trades you should not undo by accident:

- Success logs intentionally silenced (`console.log` removed; silent-success convention).
- Plex + Jellyfin sync parallelized; shared `stillPending` snapshot; `recentOnly` for Jellyfin.
- `arrFetch` body cap raised to 50 MB.
- Activity calendar `$1` offset fix.

  (These four trades originally cited commit hashes that no longer resolve in the current squashed history — the behaviors above are all still present in source; verify against the code, not a hash.)

**ALWAYS** before implementing a fix that undoes prior work, state it plainly:
> "This resolves [problem X] but reverts [improvement Y]. Impact: [metric]. Alternatives: [if any]."

**NEVER** silently roll back a previous improvement.

### Scope control

**ALWAYS** limit changes to what the user asked for. Don't rename unrelated variables, refactor adjacent components, or reformat files you aren't touching. A bug fix is a bug fix. If you spot other issues, mention them — don't fix them.

### Lint + typecheck passing ≠ bug fixed

**Why**: `npm run lint` and `npx tsc --noEmit` validate your implementation of a diagnosis, not the diagnosis itself. They can both pass while the real bug persists — especially for async sync logic and external-API consumers where types are inferred from `fetch`.

**ALWAYS** when checks pass but the user still reports the bug:
1. Stop implementing more of the same fix.
2. Question the root-cause hypothesis.
3. Re-fetch real data (debug endpoint, live upstream API, direct DB query).
4. Assume the diagnosis is wrong, not the implementation.

### Definition of done

Before handing back to the user:

1. `npm run lint` passes.
2. `npm run typecheck` AND `npm run typecheck:classic` pass (native TS 7 + classic TS 6 — both compilers gate the tree; see Commands).
3. For UI/frontend changes, verify the feature in a browser against `npm run dev`, including the golden path and at least one edge case. If you can't test in a browser, say so explicitly — do not claim success.
4. For sync/webhook/cron changes, check `/api/admin/debug/arr-state` or the `LIBRARY_SYNC` audit row to confirm the pipeline ran end-to-end.
5. If a new convention emerged, update this file (guardrails or principles) in the same change.
6. No stray `console.log` success messages (guardrail 7).

The `npm test` suite covers only pure leaf modules (see the Commands section for the full list — auth/crypto/network-policy primitives plus assorted leaf logic). Run it, but do not claim broader "tests pass" than tests/ actually exercises — there is no coverage of sync/webhook/DB/UI behaviour.
