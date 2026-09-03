@AGENTS.md

# Summonarr

Self-hosted media request aggregator. Users browse TMDB (trending / popular / discover / upcoming), request movies and TV, vote, and file issues. Admins approve requests and auto-fulfill via Radarr/Sonarr. The app ingests Plex and Jellyfin libraries + play history so users see availability, active sessions, and watch activity in one place. There is no public README — this file is the canonical project brief.

## Stack

- **Next.js 16.3.2** (App Router). AGENTS.md is not a suggestion — **read [node_modules/next/dist/docs/](node_modules/next/dist/docs/) before touching framework code**.
- **TypeScript** strict, path alias `@/*` → `./src/*`
- **Prisma 7.8** + **PostgreSQL 17**, schema-first. No `prisma/migrations/` directory — changes are applied via `prisma db push`.
- **Custom session auth** — a `jose`-signed (HS256) session JWT, not NextAuth (the project migrated off it; there is no `next-auth` dependency and no `auth.config.ts`). Session lifecycle lives in [src/lib/session-jwt.ts](src/lib/session-jwt.ts) (sign/verify), [src/lib/session-refresh.ts](src/lib/session-refresh.ts) (`verifyAndRefreshSession`: DB revocation, `sessionsRevokedAt`/`passwordChangedAt` cutoffs, role rotation, the sign-in deadline — guardrail 6c), [src/lib/session-cookie.ts](src/lib/session-cookie.ts), and [src/lib/auth.ts](src/lib/auth.ts) (`auth()` — JWT-only read). A custom `AuthSession` table backs per-device tracking + revocation. Providers: local credentials, Plex OAuth, Jellyfin (standard + QuickConnect), OIDC (`openid-client`).
- **Tailwind v4** — **no `tailwind.config.js`**. Theme lives inline in [src/app/globals.css](src/app/globals.css) under `@theme inline` with oklch variables and `.dark` class-based dark mode.
- **UI**: [src/components/ui/](src/components/ui/) — `@base-ui/react` (Radix-style) primitives scaffolded via the `shadcn` CLI, composed with the in-repo `@/lib/cva` and `@/lib/tw-merge` reimplementations (the `class-variance-authority` and `tailwind-merge` npm packages are **not** installed — these are hand-written equivalents; the merger's group table is CI-audited against the installed Tailwind, see guardrail 39).
- **Client state**: plain `useState` + URL `searchParams`. No Zustand, Jotai, Redux, or TanStack Query.
- **Data fetching**: REST API routes + `fetch` on the client, or server components calling Prisma directly. No tRPC. No server actions.
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

Typechecking is **dual-compiler**: `npm run typecheck` runs the native TS 7 compiler (the `tsgo` dev-dep alias `npm:typescript@7` — also what `npx tsc` resolves to via the bin link), and `npm run typecheck:classic` runs the classic TS 6 that `next build` and typescript-eslint load via `require('typescript')`. Run BOTH before claiming types pass — the root `typescript` package MUST stay on 6 until Next and typescript-eslint support TS 7's JS API (they probe `typescript/lib/typescript.js` / `ts.Extension`, both gone in 7 — see the ignore rule in [.github/dependabot.yml](.github/dependabot.yml) and Dependabot PRs #165/#173). CI runs both checks. There **is** a substantial unit suite under [tests/](tests/) using Node's built-in runner (`node:test` — no vitest/jest dependency; run with `npm test`). It covers the pure/in-memory surfaces of most of `src/lib`: auth primitives (session JWT, password hashing, bearer parsing, UA fingerprint, request token, session cookie, sign-in response, OIDC/flow-state cookies), sign-in orchestration (`auth.ts` credentials/Plex/Jellyfin/OIDC flows, first-admin bootstrap, revocation ledger) plus the `withAuth`/`withAdmin`/`withIssueAdmin` wrappers and `verifyAndRefreshSession` (the guardrail-6c deadline rule, `dbCheckedAt` fast path, cutoffs), crypto (token-crypto, backup-crypto streams, push-e2e ECIES, web-push VAPID), network policy (SSRF rules, safe-fetch pre-network checks, IP allowlist, local-only gate, safe hrefs, body-size caps, rate limiting), the upstream API clients against scripted `fetch` + DNS stubs (`plex.ts`, `jellyfin.ts`, the `tmdb.ts` list/details layer, OMDB/MDBList/Trakt incl. quota lockouts, TRaSH-guides sync, ip-lookup, arr-stats, library-scan), the availability/attach pipeline (plex/jellyfin/arr availability, attach-all composition, request/omdb availability), the TMDB cache layer (tmdb-cache, tmdb-core-sync, library-iterator, bad-matches, poster-cache, the three prewarm crons), play-history's pure helpers + `recordCompletedSession` + the `plex-events` SSE handler (the guardrail 19/20/21 pins live here), the notification fan-out (request-notifications hub, discord-notify, email orchestration, web+APNs push, in-app), backup-import restores (real encrypted fixtures, allowlist/caps/rollback), small prisma-backed utils (audit — the guardrail 26 swallow-vs-rethrow split, account-lifecycle — the guardrail 33 deactivate-vs-purge write sets, discord-merge, plex-config, maintenance, session-server, internal-trigger, plex-membership, plex-user-backfill, request-meta), the cva/tw-merge/cn UI reimplementations, concurrency helpers, SMTP message building (fake sockets), and assorted leaf logic — plus registry/manifest drift pins (backup-schema vs schema.prisma, audit actions, feature flags, sensitive Setting keys). **The suite also reaches the route/proxy layer** by invoking handlers directly (not over HTTP): [src/proxy.ts](src/proxy.ts)'s full request-gate chain (`tests/proxy.test.mts` — local-only Host gate, the 426 version gate, CSRF Origin check, DB-checked session validation, the `/api/admin` role backstop, UA-fingerprint binding, all with a `dbReads` counter pinning that early rejections happen pre-DB), the Radarr/Sonarr webhook handlers (`tests/webhook-routes.test.mts` — both auth transports + secret-as-discriminator instance resolution, guardrails 2/32), the votes + requests routes (`tests/votes-route.test.mts`/`tests/requests-route.test.mts` — the guardrail-23 tx-vs-gate structure, P2002/P2034 mapping, instance auto-routing), the per-source sync routes (`tests/sync-routes.test.mts` — the guardrail-13 full-vs-recentOnly delete pins), the public compat/me routes (`tests/public-routes.test.mts` — guardrail 25 integers-only + DB-free), the admin mutation routes (`tests/admin-routes.test.mts` — the guardrail-26 "destructive op still succeeds when the audit write throws" pin across user-delete/role-change/play-history-delete/cache-clear/Plex+Jellyfin terminate, plus guardrails 27/28), the `/api/sync` orchestrator (`tests/sync-orchestrator-route.test.mts` — the guardrail-14 now-available CAS fires exactly once for an item in both libraries, the guardrail-15 single `stillPending` snapshot, the guardrail-13 body-ignored full-replace, and `Promise.allSettled` source isolation; uses a `pg` `Client.prototype` patch for the top-level raw advisory lock), the play-history **poller** route (`tests/play-history-route.test.mts` — the guardrail-20 frozen-ghost-stalls-but-moving-stream-does-not + backward-seek `!==` pin and the guardrail-21 boot re-anchor ordering, the poller-writer counterparts to the `plex-events` SSE pins), the settings route (`tests/settings-route.test.mts` — the guardrail-7a "route stores plaintext, never pre-encrypts `Setting.value`" pin naming the `bc81802` bug, GET secret-masking, connection-test rollback), `tests/check-schema-route.test.mts` (the dual-auth matrix — note a bare `Bearer <CRON_SECRET>` is rejected 401 by `withAdmin`'s bearer-first JWT resolution before the inline `isCronAuthorized` runs, so that inline check only hardens the admin-session path with a same-origin gate), the push routes (`tests/push-routes.test.mts` — the guardrail-7a `encryptToken` single-pass round-trip at `push/subscribe`+`push/apns`, validated to fail on both plaintext and a hand-built `enc:v1:<enc:v1:…>` double-wrap), the auth routes (`tests/auth-routes.test.mts` — register never signs anyone in even for a native `X-Summonarr-Client` caller (guardrail 6b) + the guardrail-30 anonymous body-cap, sign-out bearer-first + no sliding refresh, machine-session cookie-only JWT), issues + sessions (`tests/issues-routes.test.mts`/`tests/sessions-routes.test.mts` — guardrail 26 issue-PATCH audit-after-commit, guardrail 32 instance-scoped `IssueGrab`, guardrail 27 revoke ledger-after-write probed inside the tx, revoke step-up), profile (`tests/profile-routes.test.mts` — password step-up + `passwordChangedAt`/`sessionsRevokedAt` cutoff + session invalidation, self-delete step-up, notification-pref write shapes), and the observability endpoints (`tests/debug-routes.test.mts` — ratings-state's opt-in `&live=1` probe (zero fetches otherwise) + read-only-ness). You may claim "unit tests pass" **only** for that surface; it does NOT cover live DB behaviour end-to-end — DB-bound code paths are exercised only against in-memory prisma stubs, and raw-SQL aggregates (the play-history stats/calendar queries) are not exercised at all. Route handlers that call `cookies()`/`headers()`/`after()` throw outside a Next request scope, so their tests wrap each invocation in a synthetic `workAsyncStorage`/`workUnitAsyncStorage` scope (with a recording `afterContext` to capture `after()` tasks) — the pattern originates in `tests/maintenance.test.mts`; the DB-restore route's success path (real encrypted blob + PBKDF2 + destructive TRUNCATE) stays out of scope, so only its pre-import gating is pinned. New tests colocate in `tests/*.test.mts` and import source with an explicit `.ts` extension (`allowImportingTsExtensions` is enabled). The runner registers [tests/_loader.mjs](tests/_loader.mjs) via `--import` (see the npm script): it resolves the `@/*` alias, extensionless relative imports, a `server-only`/`client-only` stub, and rewrites `next/server|headers|navigation` to their real `.js` files — so nearly all of `src/lib` *loads* in tests (only `.tsx`-importing modules like `nav-items.ts` don't). Two constraints remain: source must use **erasable TS syntax only** (no constructor parameter properties — Node strip-only mode rejects them; `backup-crypto.ts`, `arr.ts`, `play-history.ts` were desugared for this), and tests must never hit a real DB or the network (stub `prisma` models in-memory — see `tests/jellyfin-config.test.mts` / `tests/poster-cache.test.mts` for the two established patterns — and mock `globalThis.fetch`/sockets). CI also runs a headless E2E route crawl ([.github/workflows/e2e.yml](.github/workflows/e2e.yml) → [scripts/e2e-crawl.mts](scripts/e2e-crawl.mts)): it builds the app against a throwaway Postgres, seeds an admin via [scripts/e2e-seed.mts](scripts/e2e-seed.mts), signs in, and fails on any uncaught client error (React #418 hydration mismatches in particular — guardrail 16). It cannot run locally without the full stack; it has no Plex/Jellyfin/ARR/TMDB backends, so it gates hydration/runtime correctness only, not data-dependent behaviour.

## Directory map

- [src/app/(app)/](src/app/(app)/) — user-facing pages: home, movies, tv, upcoming, popular, top, votes, requests, issues, donate, profile, settings, plus an `admin/` subtree (activity, users, library, backup, audit-log, stats, issues).
- [src/app/api/](src/app/api/) — REST handlers grouped by domain: `sync/`, `webhooks/`, `auth/`, `admin/`, `requests/`, `issues/`, `votes/`, `ratings/`, `play-history/`, `profile/`, `search/`, `sessions/`, `push/`, `discord/`, `cron/`, `health/`.
- [src/lib/](src/lib/) — integrations and utilities: `plex.ts`, `jellyfin.ts`, `jellyfin-availability.ts`, `arr.ts`, `cron-auth.ts`, `play-history.ts`, `tmdb-types.ts`, `prisma.ts`.
- [src/components/](src/components/) — feature components; primitives under `ui/`.
- [prisma/schema.prisma](prisma/schema.prisma) — every model (User, Account, AuthSession, MediaRequest, Plex/JellyfinLibraryItem, Radarr/Sonarr{Wanted,Available}Item, TVEpisodeCache, TmdbCache, TmdbMediaCore, Issue, IssueMessage, IssueGrab, PlayHistory, ActiveSession, DeletionVote, PushSubscription, Setting, MediaServerUser, …).
- [src/generated/prisma/](src/generated/prisma/) — generated client output. **Never edit by hand.**
- There is **no** `middleware.ts` — Next 16 renamed it to `proxy.ts`. See [src/proxy.ts](src/proxy.ts): per request it runs the CSRF origin check on mutating `/api/*`, validates+refreshes the session via `verifyAndRefreshSession` (DB-checked), gates non-public paths (login redirect + admin/issue-admin role checks + UA-fingerprint), and stamps the CSP nonce. There is no NextAuth `authorized()` callback — gating is inline in `proxy()`.

## Core architecture

**Sync orchestrator** — [src/app/api/sync/route.ts](src/app/api/sync/route.ts)
- External-cron entry point, Bearer-authed via `CRON_SECRET` (or admin session).
- Runs the download-policy sync + the Plex and Jellyfin library fetch+write arms *concurrently* via `Promise.allSettled` — and each of those two arms is itself a fan-out over every configured server instance (`getSyncableMediaInstances`, guardrail 35). The Radarr and Sonarr wanted/available refreshes run earlier and are **sequential to each other** (HD+4K fetches parallelize *within* each); there is no separate TMDB "job" here beyond an expired-`TmdbCache` purge near the end.
- One shared `stillPending` snapshot is reused across both sources' marking passes. The "now available" notification fire-exactly-once guarantee is an atomic claim (`claimAvailableNotificationWinners`, an `UPDATE … RETURNING` compare-and-swap on `notifiedAvailable`) — not a plain update — so an item appearing in both libraries in the same run notifies once.
- Parallel Plex+Jellyfin sync, shared `stillPending` snapshot, `recentOnly` for Jellyfin, and batch tx timeouts landed together (the original commit hash cited here, `3dcbd79`, is not reachable in the current squashed history — see the audit note).

**Sync modes**
- **Full sync** — atomic `deleteMany` + repopulate inside one `$transaction`. The orchestrator `/api/sync` route does **not** read the body — it always does a full library replace. Multi-server nuance (guardrail 35): every delete is `serverInstance`-scoped, and only the instances whose fetch *succeeded* are replaced — a failed instance's rows are deliberately left intact rather than wiped. The `{ "full": true }` body flag is parsed only by the per-source routes `/api/sync/plex` and `/api/sync/jellyfin` (the admin "Resync" button), where `recentOnly = rawBody.full !== true`.
- **recentOnly** (default for Jellyfin) — incremental insert-only, bounded by a 2-hour `MinDateLastSaved` window (`RECENT_WINDOW_MS`). Intentionally wider than `SYNC_INTERVAL=3600s` so one missed run is survivable.

**Batch writes** — [src/lib/cron-auth.ts](src/lib/cron-auth.ts)
- `batchCreateMany(tx, rows)` chunks inserts into `CREATE_MANY_BATCH = 5_000`.
- `BATCH_TX_TIMEOUT = 30_000` — always pass this to `prisma.$transaction(..., { timeout: BATCH_TX_TIMEOUT })` for library-sized writes.

**`isCronAuthorized`** — same file. Accepts an admin session *or* `Authorization: Bearer ${CRON_SECRET}`. Every sync/cron route funnels through this — touch carefully.

**arrFetch** — [src/lib/arr.ts](src/lib/arr.ts)
- Shared Radarr/Sonarr HTTP client. 30s timeout, **50 MB** response cap (`ARR_FETCH_MAX_BYTES`), injects `X-Api-Key`, throws `ArrResponseError` on non-2xx, routes through `safeFetchAdminConfigured`.
- Body cap was raised from 10 MB because libraries with >3k movies were being silently truncated. Do not lower it.

**safe-fetch helpers** — [src/lib/safe-fetch.ts](src/lib/safe-fetch.ts)
- `safeFetch(url)` — full SSRF policy (resolve+pin, blocks RFC1918/loopback/link-local/CGNAT/multicast). For user-supplied URLs.
- `safeFetchTrusted(url, { allowedHosts })` — required hostname allowlist; still runs the DNS-based SSRF check (resolve + per-address public-IP check, `allowPrivate=false`, so a DNS rebind to a private address is blocked). For fixed third-party APIs (TMDB, plex.tv, discord.com, ipinfo.io, api.trakt.tv, api.github.com, raw.githubusercontent.com, www.omdbapi.com, api.mdblist.com, api.resend.com).
- `safeFetchAdminConfigured(url)` — runs SSRF policy with `allowPrivate=true` (RFC1918/ULA/loopback OK; link-local + 0.0.0.0 still blocked). For URLs persisted in `Setting` (Radarr/Sonarr/Jellyfin/Plex server).

**Webhook auth** — [src/app/api/webhooks/](src/app/api/webhooks/) (**sonarr, radarr only**)
- There is **no Plex or Jellyfin webhook handler** — those routes were removed. Plex real-time activity comes from the SSE stream ([src/lib/plex-events.ts](src/lib/plex-events.ts)); Jellyfin activity from the 5s play-history poller. Only `radarr/route.ts` and `sonarr/route.ts` exist.
- SHA-256 + `timingSafeEqual` against the stored webhook secret (`radarrWebhookSecret` / `sonarrWebhookSecret` + 4K variants, with a legacy shared `webhookSecret` fallback).
- Accepts either `Authorization: Bearer …` **or** a `?token=…` query param. The query-string fallback is load-bearing — see guardrails.
- No HMAC signature validation; none of these services send one.

**Play history** — [src/lib/play-history.ts](src/lib/play-history.ts)
- `recordCompletedSession()` ingests when an `ActiveSession` completes and writes a `PlayHistory` row with full playback metrics (duration, pause, codec, resolution, bitrate, device, IP, etc).
- `getActivityCalendarUncached()` (~line 1892) backs the GitHub-style 365-day heatmap in [src/components/admin/activity-calendar.tsx](src/components/admin/activity-calendar.tsx). A `$1` placeholder offset bug in its filtered-query path was fixed — the dynamic SQL builder starts parameters at `$1`, not `$2`.

**Observability** — admin-only `GET /api/admin/debug/arr-state?tmdbId=<id>&type=movie|tv` dumps the whole pipeline: cache rows, `attachArrPending` result, live Radarr/Sonarr check, tvdb→tmdb mapping, total wanted-table counts, and the most recent `LIBRARY_SYNC` audit row. Use this before guessing when a badge is missing. The ratings counterpart is `GET /api/admin/debug/ratings-state?tmdbId=<id>&type=movie|tv[&live=1]`: provider-configured flags, MDBList/OMDB quota-lockout state, raw ratings cache rows (stale/sentinel), the details-cache rating fields (absent = never fetched, null = authoritative none), plus an opt-in live probe through `fetchUnifiedRatings`. Use it before guessing when a rating badge is missing. The play-history counterpart is `GET /api/admin/debug/history-link?userId=<id>|&email=<addr>`: the account's three identity columns, every candidate `MediaServerUser` row with per-row `matchesFk` / `matchesSubject` / `visibleToUser` verdicts, the resolved id list, and an `orphanedWithHistory` list of server identities holding history the account cannot see. Use it before guessing when someone's watch history is empty — the two matchers in `resolveLinkedMediaServerUserIds` ([my-watch-history.ts](src/lib/my-watch-history.ts)) are the only thing that decides, and a local-credentials/OIDC account has no provider subject at all so the FK is its ONLY route to its own history. One more deliberately headless (curl-only) admin endpoint lives beside these: `POST /api/admin/play-history/backfill-playtime` — a one-shot, idempotent clamp of pre-`playtimeMs` `PlayHistory.playDuration` values (dry-run by default; `?execute=true` + a body echoing the dry-run's candidate count applies). Like the `debug/*` routes it has no UI button on purpose; all four are documented in the OpenAPI spec (`/admin/api-docs`).

**Logging** — custom `console.error`/`console.warn` wrapper. Namespaced with `[scope]` prefixes. `console.log` success/progress messages were intentionally removed. Silent success is the convention.

**Errors** — API routes return `NextResponse.json({ error }, { status })`, no try/catch wrapper. Shared error classes: `SafeFetchError`, `ArrResponseError`, `BackupCryptoError`. React boundaries at [src/app/(app)/error.tsx](src/app/(app)/error.tsx) and [src/app/global-error.tsx](src/app/global-error.tsx).

## Environment

Required: `DATABASE_URL`, `NEXTAUTH_SECRET` (≥32 chars), `TOKEN_ENCRYPTION_KEY` (**exactly 64 hex chars / 32 bytes** — the AES-256-GCM key for all encrypted `Setting.value` / `Account` token fields; checked **first** at boot via `assertTokenEncryptionKey()` and `process.exit(1)` on failure in *every* environment, not just production), `AUTH_URL`, `CRON_SECRET` (≥32 chars), `TRUST_PROXY` (an internet-facing instance must sit behind a trusted reverse proxy with this set to exactly `"true"`; it is also the sole gate on reading `X-Forwarded-For`/`X-Real-IP`). **In production, a blank/non-`"true"` value means LOCAL-ONLY mode and now FAILS CLOSED** — the Host guard it relies on is client-supplied and spoofable, so boot is refused unless the operator explicitly sets `SUMMONARR_ALLOW_LOCAL_ONLY=true`; a *public* `AUTH_URL` is refused either way and the opt-in cannot unlock it. Development never fails. The whole rule set is one pure function, `evaluateLocalOnlyStartup` ([src/lib/local-only.ts](src/lib/local-only.ts)), called from [instrumentation.ts](src/instrumentation.ts) — put changes there, not inline in the boot sequence. This supersedes the former "NEVER exit on a blank `TRUST_PROXY`" rule: the default docker deployment still ships it blank, so `.env.example` and [docker-container/README.md](docker-container/README.md) ship the opt-in alongside it and the Upgrading section calls it out. `TMDB_READ_TOKEN` is functionally required (core browse/search) but is **warn-only** at boot — its absence logs a warning and the app still starts.
Optional: `OIDC_{ISSUER,CLIENT_ID,CLIENT_SECRET,DISPLAY_NAME}`, `SUMMONARR_ALLOW_OAUTH_FIRST_ADMIN`, `SUMMONARR_ALLOW_LOCAL_ONLY` (see `TRUST_PROXY` above — required to run local-only in production), `BACKUP_DB_PASSWORD` (≥12 chars), `BASE_PATH`, `AUTH_TRUSTED_ORIGIN`, `TRUSTED_PROXY_HOPS` (default 1), `DELAYED_JOBS_MAX_{PENDING,QUEUE,CONCURRENCY}`, and the cron interval knobs (`SYNC_INTERVAL`, `UPCOMING_SYNC_INTERVAL`, `RATINGS_SYNC_INTERVAL`, `PLAY_HISTORY_SYNC_INTERVAL`, plus `LIST_CACHE_SYNC_INTERVAL`, `WARM_ACTIVITY_INTERVAL`, `WARM_MDBLIST_INTERVAL`, `WARM_OMDB_INTERVAL`, `WARM_LIBRARY_INTERVAL`, `SCRUB_AUDIT_PII_INTERVAL`, `TRASH_SYNC_INTERVAL`, `PURGE_SESSIONS_INTERVAL`), `SSE_MAX_LISTENERS` (default 500; bounds **both** the emitter listener cap and the concurrent SSE connection cap in `/api/events` — intentionally one knob, see [src/lib/sse-emitter.ts](src/lib/sse-emitter.ts)).

Jellyfin is **not** an env var — its server URL + API key are stored as the `jellyfinUrl` / `jellyfinApiKey` Settings, configured in Admin → Settings → Media. Login (standard + QuickConnect), library sync, play-history, fix-match, and server-user admin all read the URL via `getConfiguredJellyfinUrl()` ([src/lib/jellyfin-config.ts](src/lib/jellyfin-config.ts)). There is no `JELLYFIN_URL` fallback.

## Deployment

Multi-stage Docker (`node:26.3.0-alpine3.23`, five stages: deps → prisma-gen → builder → migrate-deps → runner) → standalone Next build, non-root `nextjs` user (UID 1001). Postgres 17-alpine sidecar with `postgres-data` volume. Internal port 3000 → host 3001. The image creates `/data` (app) and `/app/.next/cache` dirs, but neither compose file mounts them as volumes — only `postgres-data` is persisted. There are **no** external `sync-cron` / `upcoming-cron` compose services: the app container runs its **own internal cron loop** (`docker-entrypoint.sh` `_cron_loop` + `_play_history_loop`), POSTing to `http://localhost:3000/api/...` with `Bearer ${CRON_SECRET}` so the secret never leaves the container. **Image-size discipline**: the migrate-deps stage prunes the Prisma CLI's dependency tree via [scripts/prune-migrate-deps.mjs](scripts/prune-migrate-deps.mjs) (~250 MB → ~66 MB — studio/dev tooling, mysql2/postgres drivers, typescript, react, etc. are never loaded by `db push`), then a build-time smoke test runs a real `db push` against an unreachable DB and requires the P1001 error — proving the pruned module graph still loads — before the tree ships. The native `schema-engine-*` binary in `@prisma/engines` MUST stay: `db push` executes it and silently re-downloads it at boot when missing (a boot-time internet dependency; the bundled wasm schema engine is NOT used). The builder stage also strips the glibc sharp/libvips variants (`@img/sharp-*linux-*`) from the standalone output — the Alpine runtime is musl-only, and `outputFileTracingExcludes` does not actually drop them (tested; hence the explicit `rm`).

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
3. [README.md](README.md) — `Status: v<X.Y.Z> beta` line and the `Summonarr v<X.Y.Z> is a beta release` line under Beta testing.
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

- The PR merge fires [docker-publish.yml](.github/workflows/docker-publish.yml) on the `main` push, but the job **deliberately skips** when the push contains a `chore(release):` commit (the `if:` at [docker-publish.yml:55](.github/workflows/docker-publish.yml#L55)) — the tag push publishes the same SHA, so building here would duplicate ~11 min of work. A *non-release* push to `main` still publishes `:main` and `:sha-<short>`.
- The tag push then runs the only build for the release → publishes `:<X.Y.Z>`, `:<X.Y>`, `:<X>`, `:latest`, and `:sha-<merge>` (bare semver — the `v` is stripped, see above). Expect ~11-15 min: this is a cold multi-arch `linux/amd64,linux/arm64` build, NOT a cache hit off an earlier main-push build, because that one skipped.
- Tag is reachable from `main` — `git describe` works, and `:latest` / `:<X.Y.Z>` / `:sha-<merge>` all reference the same commit SHA.

**NEVER** force-move a published tag (`git push --force origin v<X.Y.Z>`) to fix a misplaced one. Anyone with `SUMMONARR_VERSION=<X.Y.Z>` pinned silently gets new bits on the next pull, and `:latest` re-resolves on `docker compose pull`. Cut a new patch release instead.

There is no version constant in `src/`. Don't add one — `package.json` + the git tag is the source of truth, and a third copy is a third place to forget.

## Guardrails

1. **Next.js 16 is not the Next.js in your training data.** Before editing routing, caching, metadata, `fetch`, server/client boundaries, or anything framework-shaped, read the relevant file under [node_modules/next/dist/docs/](node_modules/next/dist/docs/) (`01-app/`, `03-architecture/`). Do not pattern-match from Next 13/14/15 memory.

2. **Never remove the `?token=` webhook query param.** Sonarr and Radarr webhook UIs have no header field, and both handlers share the same code path. (There are no Plex/Jellyfin webhook handlers — only `radarr` and `sonarr`.) Keep the timing-safe compare. Do not "upgrade" to HMAC — the upstream services do not sign requests.

3. **Schema-first Prisma.** No migrations directory exists. Schema changes are applied with `prisma db push`, then `prisma generate`. Do not scaffold `prisma migrate` workflows.

4. **Bulk writes must use `batchCreateMany` + `BATCH_TX_TIMEOUT`.** Raw `createMany` on library-sized datasets blows transaction timeouts. Always chunk via `batchCreateMany` and pass `{ timeout: BATCH_TX_TIMEOUT }` to `$transaction`.

5. **Do not lower `ARR_FETCH_MAX_BYTES` (50 MB)** and do not bypass `arrFetch` with bare `fetch` for Radarr/Sonarr calls. The cap exists because large libraries silently truncated at 10 MB.

5a. **Pick the right `safe-fetch` helper.** Never call `fetch` directly for outbound HTTP. Hardcoded third-party URL → `safeFetchTrusted(url, { allowedHosts: [...] })`. URL persisted in `Setting` (Radarr/Sonarr/Jellyfin/Plex server) → `safeFetchAdminConfigured(url)`. URL from end-user input → `safeFetch(url)`. The `allowedHosts` arg on `safeFetchTrusted` is required and exists so a future code change can't accidentally fan that path out to user-controlled hosts.

5b. **Sole allowed direct `fetch` (internal loopback)**: The *only* exception to 5a is the controlled loopback in `src/lib/internal-trigger.ts` (`triggerFullSync`). It is used exclusively by the Plex SSE timeline handler (`plex-events.ts`) to drive a full orchestrator run (`/api/sync`) so that the advisory lock (2000), `withCronRunRecording`, `isCronAuthorized`, and `LIBRARY_SYNC` audit path are identical to an external cron. Target is always `http://127.0.0.1:${PORT}/api/sync` authenticated with `CRON_SECRET`. Update this note (and the helper) if you ever need another internal trigger. All other server HTTP must go through the safe-fetch helpers.

6. **Route all cron/sync handlers through `isCronAuthorized` (or its actor-returning form `getCronActor`).** Do not re-implement `CRON_SECRET` checks inline. `getCronActor` ([cron-auth.ts](src/lib/cron-auth.ts)) is the SAME chokepoint — `isCronAuthorized` is just `getCronActor(...) !== null` — and returns who is driving the run (`{ trigger: "admin", userId, userName }` or `CRON_SYSTEM_ACTOR`) so a route needing audit attribution reads the session ONCE instead of gating with `isCronAuthorized` and then re-reading it. `scripts/audit-routes.mts` accepts either name as the cron guard.

6a. **User-session API routes must wrap their handlers with `withAuth`/`withAdmin`/`withIssueAdmin` from [src/lib/api-auth.ts](src/lib/api-auth.ts).** The wrapper runs the auth check before the handler body and returns 401/403 itself, so the guard can never be forgotten or mis-returned (the failure mode that the older inline `requireAuth(...) + if (session instanceof NextResponse) return session;` pattern allowed). Do not re-implement `auth() + isTokenExpired() + role` boilerplate inline. Callsite:
    ```ts
    export const GET = withAuth(async (req, ctx, session) => { ... });        // any authenticated user
    export const POST = withAdmin(async (req, ctx, session) => { ... });      // ADMIN only
    export const PATCH = withIssueAdmin(async (                               // ADMIN or ISSUE_ADMIN
      req,
      { params }: { params: Promise<{ id: string }> },
      session,
    ) => { ... });
    ```
    The handler only runs for an authorized session; `session` is always valid inside it. Keep the dynamic-route `ctx` param's `{ params: Promise<{...}> }` annotation — Next 16's build-time route-type checker needs it. Name unused params `_req`/`_ctx`/`_session`. Semantics: 401 for missing/expired session, 403 only for wrong role. `requireAuth` still exists and is what the wrappers call internally; call it directly **only** when the route legitimately can't use a wrapper — dual-auth routes that also accept a cron token (e.g. [check-schema](src/app/api/admin/check-schema/route.ts) wraps with `withAdmin` and keeps an inline `isCronAuthorized` check) and routes returning plain-text/binary/streaming responses (SSE, thumbnails: [/api/events](src/app/api/events/route.ts), [fix-match/thumb](src/app/api/admin/fix-match/thumb/route.ts), [play-history/export](src/app/api/play-history/export/route.ts)). Cron/sync routes use `isCronAuthorized`, not this. Two enforcement layers back this up: `npm run audit:routes` ([scripts/audit-routes.mts](scripts/audit-routes.mts)) fails CI if any route ships with no recognized guard (its `ROUTE_EXCEPTIONS` list documents every legitimate inline-auth/public route), and the proxy ([src/proxy.ts](src/proxy.ts), the inline admin backstop) returns a JSON 403 for any role with **no** admin access at all (`role !== "ADMIN" && role !== "ISSUE_ADMIN"`) hitting `/api/admin/*` as a defense-in-depth backstop — the per-route wrapper remains the source of truth for the exact ADMIN-vs-ISSUE_ADMIN decision, so the backstop can never wrongly deny a privileged caller.

6b. **Session auth is dual-transport: HttpOnly cookie (web) OR `Authorization: Bearer <session-jwt>` (native/mobile clients).** Added for the iOS app (Phase 0). The bearer token is the *same* session JWT the cookie carries — there is no separate token type.

    Why the rules below exist:
    - A native app has no cookie jar, no web `Origin`, and an arbitrary `User-Agent`. The browser-shaped gating (CSRF Origin check, UA-fingerprint binding, 302→HTML login) rejects it unless these paths know about bearer auth.
    - Bearer and the `X-Summonarr-Client` tag are *custom* headers a cross-origin page cannot attach to a credentialed request (CORS preflight blocks them), so they are sound CSRF-skip / fingerprint-skip signals — a cookie-riding forgery can carry neither.

    Rules:
    - **Every session reader resolves bearer-FIRST, then cookie.** The helper is `parseBearerToken` ([src/lib/mobile-auth.ts](src/lib/mobile-auth.ts)). Current readers: [src/proxy.ts](src/proxy.ts), `authenticateRequest` + `requireAuth` ([src/lib/api-auth.ts](src/lib/api-auth.ts)), [/api/auth/me](src/app/api/auth/me/route.ts), [/api/auth/sign-out](src/app/api/auth/sign-out/route.ts). If you add a new path that reads the session cookie directly (`parseSessionCookie` / `cookies().get(getSessionCookieName())`), add the bearer fallback too or native clients silently 401 on that route only. Bearer-first (not cookie-first) is load-bearing: it stops a forged cookie from riding a request a bearer made CSRF-exempt.
    - **CSRF Origin check and UA-fingerprint check skip when the request is bearer/native.** Don't "tighten" the proxy CSRF block or the `matchesStoredFingerprint` callsites back to unconditional — you'll lock out the app. Bearer sessions deliberately drop UA-binding (the JWT lives in the Keychain, not an ambiently-replayed cookie); the remaining defenses (JWT signature, DB revocation, `sessionsRevokedAt`/`passwordChangedAt` cutoffs, sessionId rotation, expiry) still apply.
    - **The session JWT reaches a native client ONLY via the sign-in response body, ONLY when the client sends `X-Summonarr-Client`.** Go through `buildSignInResponse` ([src/lib/sign-in-response.ts](src/lib/sign-in-response.ts)) — never return `result.token` in a body unconditionally (that would expose the JWT to web JS and defeat HttpOnly).
    - **OIDC has a SECOND, native-only path, and the two must not be crossed.** The web flow is unchanged: `/api/auth/oidc/start` 302s and sets the HttpOnly state cookie, and `/api/auth/oidc/callback` exchanges the code and mints the session cookie itself. Native clients cannot use it — `/start` is called by the app's own HTTP client while the IdP redirect lands in a separate web-auth view with its own cookie jar, so the callback sees no flow cookie. For a caller sending `X-Summonarr-Client`, `/start` instead returns `{ authorizeUrl, flowState, callbackScheme }` as JSON (mirroring `/api/auth/plex/start`), the callback bounces `(code, state)` to `summonarr://oidc-callback`, and the app finishes at `POST /api/auth/sign-in/oidc`. Load-bearing details: the native flow is detected by a `nat.` PREFIX on the OIDC `state` (`isNativeOidcState`), because `state` is the only value that round-trips without the cookie — it is ROUTING information, never an authorization; the code bounced through the custom scheme is safe precisely because the PKCE `codeVerifier` and expected nonce live only inside the signed `flowState` the app holds, so an intercepted code cannot be redeemed; the callback's native branch must NEVER exchange or set a session cookie; `/api/auth/sign-in/oidc` REFUSES a flow state lacking the native marker, so a stolen web flow cookie can't be replayed through the native path to trade a code for a bearer token; and the custom-scheme target is a hardcoded constant (`NATIVE_OIDC_CALLBACK_URL`) — accepting a client-supplied one would turn the callback into an open redirect that leaks the code.
    - **No refresh for bearer clients** — they can't read `Set-Cookie`, so they keep presenting the token they were handed at sign-in. That token never expires by time: a native sign-in's deadline is the never-reached sentinel (guardrail 6c), so there is nothing to refresh and no Phase-3 refresh-token grant is needed for longevity. Don't append `Set-Cookie` on a bearer request (guarded by `!bearerToken` / `!result.fromBearer`). The `X-Summonarr-Client` header ALONE selects the never-expiring session; `rememberMe` and a mobile `User-Agent` only affect the device label (send them anyway so the device list reads right).
    - **That forbids handing the CLIENT a new token; it does NOT forbid the server-internal forwarded-header rewrite, which is REQUIRED for both transports.** Every request is session-verified twice (proxy, then `authenticateRequest`/`authActive`), and both read the credential off the request `proxy.ts` forwards. So when `verifyAndRefreshSession` re-signs, `proxy.ts` must rewrite the forwarded credential with the new token — `cookie` via `replaceSessionCookie` for browsers, `authorization` as `Bearer <token>` for bearer — BEFORE constructing `NextResponse.next({ request: { headers } })` (Next snapshots those into `x-middleware-request-*` at construction; mutating after is a no-op). `dbCheckedAt` is stamped ONLY by that re-sign and is never present at mint (`initializeTokenOnSignIn`), so a transport left out of the rewrite can never carry the claim, can never take the fast path, and pays the full DB-checked verify on BOTH passes — 6 session queries per request instead of 3. It also means a sessionId rotation (privilege change) kills the second pass, since the credential the client sent is already dead. Gating the rewrite on `!bearerToken` was exactly that bug. The client still receives nothing: no `Set-Cookie`, no token in a body, and it keeps presenting its original token.

6c. **A session lives until its sign-in deadline — nothing shortens it, nothing caps it, and a native session has no deadline at all.** `verifyAndRefreshSession` rejects a token past the `expiresAt` claim and otherwise re-signs with `exp` AT that claim; `initializeTokenOnSignIn` sets the claim to the admin-configured desktop/mobile/remember-me duration for browsers and to `NEVER_EXPIRES_AT_SEC` ([session-lifetime.ts](src/lib/session-lifetime.ts)) for a caller presenting `X-Summonarr-Client`.

    Why:
    - Both of the things this rule forbids used to exist, and together they made the settings form a lie. A 1-hour non-ADMIN *inactivity slide* re-signed every cookie with `Max-Age ≤ 3600`, so "Remember me: 30 days" ended after any hour-long gap — every user signed in again most days and blamed whatever had happened last (a deploy). A 7-day *ADMIN ceiling* (iat-based on the fast path, `AuthSession.createdAt`-based on the slow path) signed the operator out weekly, which lined up exactly with the weekly Dependabot cadence and read as "bumping deps logs everyone out".
    - A bearer client has no refresh channel (guardrail 6b), so any finite TTL is a forced re-login at that TTL. The old fixed 1-year native TTL was the same bug on a longer fuse; now a native session ends only through revocation — sign-out, per-device revoke, revoke-all, a password change, account deactivation — all of which the DB-checked verify already honours on the next request, independent of any deadline. The deadline was never the security boundary; revocation is.

    Rules:
    - **Never reintroduce an inactivity window or a role-based ceiling** in `verifyAndRefreshSession`. If a shorter admin session is wanted, it belongs in the *configured durations* (Admin → Settings → Session), which already cap at 90 days. `tests/session-refresh.test.mts` pins both: an 8-day-old ADMIN session (old iat AND old `createdAt`) survives both paths, and an idle remember-me session survives a 29-day gap and dies one second past its deadline. They were mutation-tested — each reintroduction fails a named test.
    - **"Never expires" is a sentinel deadline, NOT an absent claim.** `exp`, the `expiresAt` claim, the non-null `AuthSession.expiresAt` column and the `/api/sessions` wire contract all expect a number/date — and the iOS app decodes each device's `expiresAt` as a **non-optional string**, so a `null` there breaks the Sessions screen of every shipped build. Test for it with `isIndefiniteDeadline`, never `expiresAt == null`.
    - **The only housekeeping allowed to delete an `AuthSession` row is the `expiresAt < now` sweep** in [purge-auth-sessions](src/app/api/cron/purge-auth-sessions/route.ts). A "sessions older than N days" / "idle for N days" sweep on `createdAt`/`lastSeenAt` would sign every iOS user out on its first run; `tests/cron-routes.test.mts` pins the predicate's shape.
    - The native selection keys on the `X-Summonarr-Client` header alone (a custom header a cross-origin page cannot attach — guardrail 6b), never on `rememberMe` or a UA-derived device class: a spoofed mobile UA must not mint a never-expiring *cookie*.

7. **No success logs.** `console.error` and `console.warn` only, namespaced with a `[scope]` prefix. Silent success is the convention. Do not add `console.log` for happy-path events.

7a. **NEVER call `encryptToken` at the call site for `Setting.value` or `Account.{access_token,refresh_token,id_token}`.** The Prisma extension in [src/lib/prisma.ts](src/lib/prisma.ts) handles encryption on every write to those fields and decryption on every read. Pre-encrypting at the route, sign-in/OIDC, or library layer produces double-encrypted rows of the form `enc:v1:<enc:v1:…>` — on read the extension decrypts once and hands callers the inner ciphertext, which then gets sent as an API key/token to upstream services and fails auth. This bug shipped in `bc81802` (a route-level pre-encryption in `/api/settings` and an `encryptingAdapter` wrapper in `auth.ts`); both were removed afterward. The remaining legitimate `encryptToken` callers are: `PushSubscription` writes ([src/app/api/push/subscribe/route.ts](src/app/api/push/subscribe/route.ts), the extension does not cover that table) and the one-shot migration scripts under [scripts/](scripts/). Do not add a third.

7b. **A warning that restates an UNCHANGED condition on every pass goes through `warnOnChange` ([log-dedup.ts](src/lib/log-dedup.ts)). Rate questions are answered by the cron run history — NEVER by counting log lines.**

    Why:
    - `[jellyfin] 90 TMDB id(s) matched more than one Movie` and `[sync] N conflated ratingKey(s)` describe the LIBRARY, not an event. The orchestrator re-derived and re-emitted them verbatim on every run, so their volume tracked the caller's polling rate rather than the condition. At the intended hourly cadence that is ~24 lines a day; when an SSE trigger loop drove the orchestrator to roughly once a minute it became ~1,400 a day. The repetition did not report the anomaly — it *was* the flood that hid it.
    - The ledger could not answer it either. `recordCronRun` kept only the newest run per target, so `cron:lastRun:sync:full` read identically whether the job ran once or four hundred times — on the very panel `[internal-trigger]` tells operators to go check.

    Rules:
    - Repeat-suppress with `warnOnChange(key, signature, message)`. Derive the signature from **everything the message states** (the dropped ratingKey LIST, not just its length) or a changed message is silently swallowed. Suppression is per-process, so a restart always re-logs the current state.
    - **NEVER emit "(repeated N times)"** — that reintroduces the per-pass line the suppression exists to remove.
    - **NEVER repeat-suppress an EVENT.** This is only for a condition recomputed on a schedule. A webhook delivered twice, a request failing twice, a session finalizing twice are distinct occurrences and each must log.
    - `recordCronRun` keeps a bounded `recent[]` (`CRON_RUN_HISTORY_LIMIT`) **inside** the existing `cron:lastRun:<target>` row. The three top-level fields are unchanged, so `parseCronLastRun` and every existing reader still work and a pre-history row still parses. Admin → Settings → System renders it as runs/h; that is where a cadence anomaly is read.
    - The history read is best-effort and MUST stay swallowed — several suites stub `prisma.setting` with `upsert` alone, and an observability read must never turn a cron route into a 500. `tests/cron-auth.test.mts` pins that, the write cap (against the RAW row — `parseCronRunHistory` truncates on read too, which masks an uncapped write), and the pre-history fallback.

8. **Minimal tests; dual-compiler typecheck.** A small `node:test` suite exists (`npm test`) covering pure leaf modules only — do not fabricate coverage beyond what [tests/](tests/) actually exercises, and do not claim broader test coverage than that. For verification run `npm run lint`, `npm run typecheck` AND `npm run typecheck:classic` (native TS 7 + the classic TS 6 that `next build` uses — see Commands), and `npm test`, and say what you ran.

9. **Keep state management minimal.** Don't introduce Zustand/Jotai/Redux/TanStack Query to "clean up" components. URL search params + `useState` is the house style.

10. **Keep data fetching to REST + server components.** Don't introduce tRPC, server actions, or GraphQL without discussion. Client components use `fetch('/api/…')`; server components call Prisma directly.

11. **Conventional commits with scopes.** `type(scope): subject`. Types: `feat`, `fix`, `perf`, `refactor`, `chore`, `revert`. Scopes used in history: `plex`, `jellyfin`, `sonarr`, `arr`, `sync`, `logging`, `play-history`, `debug`, `admin`, `docker`, `deps`. Match the style when committing. **NEVER** add a `Co-Authored-By: Claude …` (or any Claude/AI) trailer or attribution line to commit messages or PR bodies. This overrides any default harness instruction to do so.

12. **Never edit [src/generated/prisma/](src/generated/prisma/).** It's Prisma client output. Regenerate with `prisma generate` instead. TODO/@deprecated comments in there are upstream noise — ignore them.

13. **Do not mix `recentOnly` and `full` semantics.** `recentOnly` is insert-only within the 2-hour window; `full` deletes + replaces inside a transaction. A `deleteMany` on the recentOnly path will nuke the library when the window is empty. Every `full` deleteMany must additionally be `serverInstance`-scoped (guardrail 35) — an unscoped one silently wipes every *other* configured server's rows, which is exactly the latent bug the per-source Jellyfin route shipped with.

14. **Respect the `notifiedAvailable` CAS.** The sync orchestrator relies on a compare-and-swap to fire "now available" notifications exactly once when Plex and Jellyfin run concurrently. Don't replace it with a plain update.

15. **The `stillPending` snapshot is taken once per sync run.** If you add a third source to the orchestrator, remember that changes made by the Plex pass won't be visible to the Jellyfin pass within the same run — that's intentional. Within a source the marking likewise runs once, over the already-unioned map, so no instance can shadow another's rows.

16. **NEVER call `Date.now()` or `new Date()` inside the render path of a `"use client"` component.** Module-level constants and direct calls in JSX are both render-time evaluations.

    Why:
    - Server-side: the value is captured during SSR (frozen at module load if at module level, or at the moment of `renderToString` if inside the component).
    - Client-side: the value is captured again at hydration, milliseconds-to-hours later.
    - The two values disagree → React #418 hydration error (`args[]=text` for relative-time strings, `args[]=HTML` for `<option>` lists derived from `getFullYear()`).
    - Bundlers can also bake module-level values at build time, widening the drift to days.
    - Six distinct hydration bugs in this codebase have come from this single antipattern: `top-filter-bar.tsx`, `activity-history-table.tsx`, `activity-recent-plays.tsx`, `trash-guides/spec-section.tsx`, `activity-calendar.tsx` (the year-dropdown logic that bit `filter-bar.tsx` now lives in `top-filter-bar.tsx`; the trash-guides client was split under `src/components/admin/trash-guides/`).

    Fix shape — pick one:

    a. **Pass the reference time as a prop from a server component** (preferred when the consumer is itself a server component or sits one level below):
    ```ts
    // server page.tsx
    <ActivityCalendar data={data} today={new Date().toISOString()} />
    <FilterBar maxYear={new Date().getUTCFullYear() + 1} />
    ```

    b. **Gate on `useHasMounted` from `@/hooks/use-has-mounted`** (when the value is purely cosmetic — relative-time labels in tables, "X ago" timestamps):
    ```tsx
    const mounted = useHasMounted();
    return <td>{mounted ? formatRelativeTime(row.startedAt) : ""}</td>;
    ```

    Examples already in the codebase: `cron-job-table.tsx`, `audit-log-table.tsx`, `activity-now-playing.tsx`. Match the pattern when adding a new component.

    ❌ Wrong:
    ```ts
    const currentYear = new Date().getFullYear(); // module-level: bake-or-drift
    function Row({ ts }) { return <span>{formatAgo(Date.now() - ts)}</span>; }
    ```

    ✅ Right:
    ```ts
    function Row({ ts, mounted }: { ts: number; mounted: boolean }) {
      return <span>{mounted ? formatAgo(Date.now() - ts) : ""}</span>;
    }
    ```

16a. **The `nonce` mismatch on the root layout's theme script is NOT a guardrail-16 bug — do not go hunting for render-time nondeterminism, and do not remove its `suppressHydrationWarning`.**

    Why:
    - Under a **header-delivered** CSP (which [src/proxy.ts](src/proxy.ts) sets on every request) the browser moves the nonce into an internal slot and blanks the content attribute — HTML spec, "nonce attributes", so a CSS attribute selector can't exfiltrate it. Verified live: `getAttribute("nonce")` → `""` while `.nonce` → the real value, and the served HTML carries the real value.
    - React's **DEV-only** hydration attribute check reads props back with `getAttribute` (`diffHydratedProperties` → `hydrateAttribute` in react-dom), so it compares that `""` against the real nonce from the RSC payload and logs *"A tree hydrated but some attributes of the server rendered HTML didn't match the client properties"* on every page.
    - **Read the diff direction correctly**: React's `describePropertiesDiff` prints `+` for the CLIENT props and `-` for the value it read back from the DOM (which it labels "server"). `+ nonce="<real>"` / `- nonce=""` therefore means the server HTML was **right** and the DOM readback was blanked — not "the client lost the nonce". Misreading this sends you looking for a nonexistent threading bug in `headers()`.
    - It is a `console.error` only: React never patches up or re-renders attribute mismatches, so there is **no #418, no recoverable error, no client re-render**. `diffHydratedProperties`/`hydrateAttribute`/`serverDifferences` are absent from the production react-dom build entirely, so it never fired outside `next dev`.

    Rules:
    - The nonce cannot be dropped from that tag — `strict-dynamic` blocks un-nonced inline scripts, and the anti-FOUC script would be CSP-killed. `suppressHydrationWarning` on the `<script>` is the fix; the one on `<html>` does **not** cascade to it.
    - The CI crawl ([scripts/e2e-crawl.mts](scripts/e2e-crawl.mts)) never saw this: it builds and runs `npm run start`, i.e. **production**, where the diff path does not exist. There is no ignore-filter to narrow. Its `/#418/` match is on `pageerror` — real hydration *errors*, a different class.
    - Corollary gap, accepted: because CI runs production, dev-only attribute-mismatch **warnings** are invisible to it. A genuine one (a `Date.now()`-derived attribute) would only surface in a local `next dev` console — which is exactly why that console must stay free of known-benign noise.

17. **Do not "fix" the intentional fire-and-forget `tmdbId` backfill in [src/app/(app)/admin/activity/page.tsx](src/app/(app)/admin/activity/page.tsx).**

    Why:
    - The `void Promise.all(... activeSession.update ...)` block is a cache warm, not part of the response. Awaiting it would add DB round-trips to every Activity page render for no user benefit.
    - It is safe **only because** Summonarr runs as a single long-lived Node server (see Deployment) — the unawaited promise survives past render. On serverless/edge it would be dropped; this app is never deployed that way.
    - Errors are swallowed by design: the next sync re-resolves the `tmdbId`, so a failed backfill is self-healing.

    A reviewer pattern-matching "unawaited promise in a server component" will want to await it or move it into the sync path. Both are wrong here. Leave it; the inline comment explains the same.

18. **Regenerate `THIRD_PARTY_LICENSES.txt` whenever production dependencies change.**

    Why:
    - The project is AGPL-3.0-only (`package.json` `license` field + [LICENSE](LICENSE)). The permissive deps (MIT/BSD/ISC/Apache-2.0) require their attribution notices to travel with any distribution, and `sharp`'s prebuilt libvips binaries are LGPL-3.0 and ship **no license file at all**.
    - The Docker image is built from Next.js standalone output, which traces only runtime JS and strips `node_modules` LICENSE/NOTICE files. [Dockerfile](Dockerfile) explicitly `COPY`s [LICENSE](LICENSE) + `THIRD_PARTY_LICENSES.txt` into the runner so the shipped artifact carries them.
    - `THIRD_PARTY_LICENSES.txt` is generated from `package-lock.json` (not `npm ls` — its deduped tree hid the libvips subtree under `sharp`) by [scripts/generate-licenses.mts](scripts/generate-licenses.mts). It bundles canonical Apache-2.0 + LGPL-3.0 + GPL-3.0 text from [licenses/](licenses/) for deps that ship none.
    - **The output must be byte-identical on every OS.** Platform-gated optional binaries (lockfile entries with `os`/`cpu`/`libc`, e.g. `@img/sharp-*`) are installed by `npm ci` only for the host platform, so reading their on-disk LICENSE makes a macOS-generated file fail the Linux-CI `--check` (and vice versa — this is exactly how the check shipped broken in `dc965a1`). The generator therefore **never reads disk for gated packages** — it emits canonical text keyed off the lockfile `license` (SPDX `AND`/`OR` compounds decomposed via `canonicalFor`). Do not "optimize" this back to `readLicenseText` for gated packages, and do not key canonical lookup off the raw `CANONICAL[license]` map (it misses compounds).

    ```bash
    npm run licenses:generate          # after any prod dep add/remove/bump
    node scripts/generate-licenses.mts --check   # what CI enforces (blocking)
    ```

    CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs the `--check` and fails the PR if the committed file is stale. Do not delete `node_modules` LICENSE files in any Dockerfile slimming step, and do not lower this to a non-blocking CI step — a stale notices file is a license violation in the shipped image, not a lint nit.

    **When checking `--check` by hand, do NOT pipe it.** `node scripts/generate-licenses.mts --check | tail -5` reports `tail`'s exit code, not the script's — a stale file reads as a pass. Run it bare, or `… >/dev/null && echo PASS || echo FAIL`.

18a. **High/critical vulnerabilities BLOCK the release, and the only way past is a dated, owned exception.**

    Why:
    - Every scanner in this repo was observability-only: Trivy ran `exit-code: '0'` in all three places, `audit:deps` was `continue-on-error: true`, `npm audit` wasn't in CI at all, and `dependency-review` only inspects a PR's dependency *diff* — so it is blind to a vulnerable dependency already in the lockfile. Nothing could fail a release. A HIGH in a production dependency (`fast-uri`, GHSA-7p8r-x3mc-p8w7) sat in the tree as a direct result.
    - `ci.yml` also runs on `pull_request` only, while `docker-publish.yml` runs on tag pushes. A tag placed on any commit published `:latest` with no security check on that tree.

    Rules:
    - **The gate is the `security-gate` job in [docker-publish.yml](.github/workflows/docker-publish.yml)**, and `build-and-push` `needs:` it. It runs on every trigger this workflow has, which is what closes the tag hole. Do not remove the `needs:` edge — that silently un-gates publishing while leaving a green-looking job in the graph.
    - **PR-time advisory checks stay non-blocking on purpose.** An advisory filed overnight against a transitive package must not fail an unrelated PR. Blocking belongs at the release, where the risk becomes someone else's. Don't "fix" the `continue-on-error: true` on `audit:deps`.
    - **Exceptions live in [.github/security-exceptions.json](.github/security-exceptions.json)** and require `id` (GHSA), `package`, `owner`, `expires` (ISO date), `reason`. An **expired entry is a hard failure**, not a silent pass — expiry that degrades to "allow" makes every entry permanent by neglect. A package-name match alone never suppresses: the advisory **id** must match too, or accepting one advisory would blanket-accept the next one filed against that package.
    - `npm run security:exceptions` validates the file alone — no network, no advisory feed — so it is blocking in CI and can only fail on this repo's own file.

    ```bash
    npm run security:gate         # what blocks the release (high+, allowlist-aware)
    npm run security:exceptions   # validate the exception file (blocking in CI)
    ```

    - Trivy's scheduled runs are blocking; its push/PR runs are not. A weekly job that can never go red is not an alert.
    - **The image is scanned BEFORE it is published.** `security-gate` builds the runner image single-arch (`platforms: linux/amd64`, `load: true`) and Trivy-scans the loaded image with `exit-code: 1`. Single-arch is not a shortcut — `load: true` exports to the local docker daemon so Trivy can read it, and **a multi-arch manifest cannot be loaded**, which is why this was previously only possible post-publish. `provenance: false` is REQUIRED alongside `load: true` (BuildKit cannot export attestations to the docker exporter and the build fails). The build shares the GHA cache with the publish job and with ci.yml's `docker-build`, so it is normally a cache hit and it primes the amd64 half of the multi-arch release build.
    - The post-publish scan stays `exit-code: 1` for the two things the pre-push gate structurally cannot cover: the **exact published digest** and the **arm64** half of the manifest (not loadable). Divergence between the two is the signal. **The arm64 half is covered ONLY by the explicit `TRIVY_PLATFORM: linux/arm64` scan step, never implicitly by scanning the index digest** — Trivy resolves a multi-arch index to the scanning host's platform (amd64 on `ubuntu-latest`) unless `--platform` is set, so a lone digest scan re-reads the amd64 layers the gate already checked and the arm64 image goes unscanned. Both post-publish scans pin their platform via `TRIVY_PLATFORM` (trivy-action forwards `TRIVY_*` env vars) and upload under distinct SARIF categories (`trivy-publish` / `trivy-publish-arm64`). Don't collapse them back into one step.
    - **Dry-run the gate before you need it.** `workflow_dispatch` takes a `gate_only` boolean that runs `security-gate` and skips publishing entirely, so a surprise high/critical surfaces when someone chooses to look rather than when it blocks a release mid-flight:

    ```bash
    gh workflow run docker-publish.yml -f gate_only=true
    ```

19. **The live 5s poller is the SOLE writer for Jellyfin play history. There is no backfill cron.**

    Why:
    - The live poller's finalize (`sourceSessionId = ${sessionKey}:${startedAt}`, via [recordCompletedSession](src/lib/play-history.ts)) captures every Jellyfin watch while the app is up, with full metadata (codec/transcode/resolution/bitrate/device/IP/markers).
    - The old `sync-jellyfin-history` cron (PlaybackReporting `jf-pr:` + IsPlayed `jf-hist:` imports) was removed — it only ever added pre-install and downtime history, which the project decided it no longer needs. With it gone, all Jellyfin rows share the live namespace, so the `@@unique([source, sourceSessionId])` constraint + `createMany({skipDuplicates})` in `recordCompletedSession` is the whole dedup story — no cross-namespace `liveCovers` guard is needed anymore.

    Rules:
    - **NEVER** make the live poller skip Jellyfin finalize — it's the only writer now; skipping it loses the watch entirely.
    - If you ever re-introduce a Jellyfin backfill that writes a different `sourceSessionId` namespace, you MUST re-add a cross-path guard (the deleted route used a `±10min` `(mediaServerUserId, sourceItemId)` window) so the same watch can't land twice and inflate play counts/watch hours on admin/activity.
    - The `getJellyfinSessions` lib helper feeds the live poller — don't confuse it with the removed `getJellyfinPlaybackReporting`/`getJellyfinUserPlayHistory`/`getJellyfinItemRuntimes` backfill helpers (also deleted).
    - "The poller" is now a loop over every configured Jellyfin server (guardrail 35) and `PlayHistory.serverInstance` records which one a watch came from — so "sole writer" means the poller *as a whole*, not one connection. Don't assume a single Jellyfin anywhere on this path.

19a. **NEVER reconcile a `bitrate` column by MAGNITUDE. Normalize on `source` via [bitrate.ts](src/lib/bitrate.ts).**

    Why:
    - `PlayHistory.bitrate` / `ActiveSession.bitrate` store what the upstream sent, verbatim — there is no write-time normalization. The unit is a property of the row's `source`: **Plex is kbps** (`Media.bitrate`; a 20 Mbps file reads `20000`), **Jellyfin is bps** (`TranscodingInfo.Bitrate` / `MediaStream.BitRate`; the same file reads `20000000`).
    - The two ranges genuinely OVERLAP, so a `bitrate > N` threshold is wrong at one end no matter which N you pick — and **both** wrong answers have already shipped:
      - `> 100_000` erased Plex UHD: a 128 Mbps remux (`128000` kbps) is above the cutoff, so it was divided by 1000 and read as 0.128 Mbps — the heaviest sessions vanished from the panel meant to surface them.
      - `> 1_000_000` inflated Jellyfin 1000×: anything under 1 Mbps (music, and Jellyfin's stock sub-1-Mbps mobile transcode rungs) stayed unscaled and was read as kbps. A 2-hour 720 kbps phone stream reported **648 GB** against a true 0.65 GB.
    - "It's rare, and it contributes little bandwidth" is NOT a valid reason to accept a gap — that reasoning shipped the second bug. The error *multiplies* the row's contribution by 1000, so the **lightest** sessions become the heaviest line items. One phone stream can outweigh a real month.

    Rules:
    - One definition: `BITRATE_KBPS_SQL` (raw-SQL sites) and `bitrateToKbps(raw, source)` (TS/client). Never a private copy — the copies drift. The fix that raised the SQL threshold updated all nine SQL sites and missed **four** UI helpers, which sat on the old cutoff for releases while the SQL and the UI on the same page disagreed about the same session.
    - `source` is a **required** parameter on every formatter, never optional — an optional one silently defaults Jellyfin rows to the Plex reading and renders them 1000× high.
    - An unrecognized `source` is read as kbps. Guessing wrong that way under-reports; guessing wrong the other way multiplies by 1000.
    - `tests/bitrate.test.mts` pins both failure directions plus a repo-wide structural scan for the magnitude antipattern (it caught two undiscovered copies the moment it was written). Adding a media server means editing `BPS_SOURCES`, not a call site.

    **Bandwidth stats use `DELIVERED_KBPS_SQL`, not the raw column** — they answer "how many bytes left the server", and three of the four (server × play-method) cases already measure that: Plex DirectPlay and Jellyfin DirectPlay push the source as-is, and a Jellyfin transcode reports its true output via `TranscodingInfo.Bitrate`. The fourth, a **Plex transcode**, cannot be read at all — `TranscodeSession` carries width/height/codec/container/size/speed and **no bitrate field**. So `Session.bandwidth` (the Streaming Brain's *reserved* estimate, explicitly "not the used bandwidth" per Tautulli) is used for that case alone, wrapped in `LEAST(bandwidth, bitrate)`. The clamp is the load-bearing part: delivered can never exceed the source when transcoding, so a garbage reading (10500 Mbps has been seen in the wild) degrades to *exactly* the un-clamped number — the expression can never be worse than measuring at source, only closer. Never drop the clamp, never extend the estimate to DirectPlay (there source *is* delivered, exactly), and keep both `> 0` guards — Postgres `LEAST` ignores NULLs, so `LEAST(bandwidth, NULL)` returns `bandwidth` and would count a row the raw column calls unknown.

    **Jellyfin DirectPlay bitrate is the SOURCE TOTAL, via `sourceBitrateBps`** ([jellyfin.ts](src/lib/jellyfin.ts)) — `MediaSources[].Bitrate` (the container total, selected by `PlayState.MediaSourceId`), falling back to video + audio stream sum. The old fallback was `videoStream.BitRate`, the video track alone, which dropped the audio from every direct-played session — 128 kbps for stereo AAC, up to ~4.5 Mbps for TrueHD/DTS-HD MA. Do not "simplify" back to a single stream; the sum is already a floor for multi-audio-track files and can only under-report.

20. **The Plex stall anchor (`progressUpdatedAt`) must track playhead MOVEMENT, not strict forward advance — in BOTH writers (SSE and the 5s poller).**

    Why:
    - The poller's stall detector ([sync/play-history/route.ts](src/app/api/sync/play-history/route.ts)) finalizes a *still-playing* Plex session when `now - progressUpdatedAt >= PLEX_STALL_THRESHOLD_MS` (60s). It's the "playhead last moved" anchor.
    - Two paths write `progressMs`: the 5s poller (a lagging `/status/sessions` snapshot) and the SSE `playing` handler `applyLiveStateUpdate` ([plex-events.ts](src/lib/plex-events.ts), real-time). SSE pushes `progressMs` *ahead* of the poller's snapshot.
    - A **strict greater-than** liveness check (`s.viewOffset > existing.progressMs`) reads false on a healthy stream whenever SSE wrote `progressMs` last — the poller's older snapshot is `<=` the SSE value. That false reading both (a) suppresses the `progressUpdatedAt` refresh and (b) satisfies the `!moved` term in the stall condition, so the anchor ages past 60s and the poller **stall-finalizes a live stream** — then the 1h `recentlyFinalizedPlexSessions` ledger blocks the now-playing card from returning. This shipped as a regression with the SSE feature; patching only the SSE writer (commit `af1442b`) was insufficient because it held only while SSE emitted frequent advancing events.
    - A **genuine ghost** (client quit, Plex keeps reporting it) has a *frozen* `viewOffset`, so an inequality check (`!==`) is false there and the stall still fires at 60s. Ghosts emit no SSE events, so refreshing the anchor on movement in the SSE writer can never keep one alive.

    Rule: refresh `progressUpdatedAt` whenever the playhead **moved** (`s.viewOffset !== existing.progressMs` / `BigInt(viewOffset) !== prior.progressMs`), forward *or* backward — not only on a strict forward advance. The poller does this via `playheadMoved`; SSE does this on `transitionedToPlaying || playheadMoved`. Don't regress either to `>` or to transition-only.

21. **`ActiveSession.lastSeenAt` must be re-anchored to "now" once at boot, before any absence-finalize runs.**

    Why:
    - `lastSeenAt` is the "we last saw this session live" anchor for all three finalize paths: the SSE bootstrap reconcile ([plex-events.ts](src/lib/plex-events.ts) `bootstrapReconcile`), the 5s poller's stale sweep ([sync/play-history/route.ts](src/app/api/sync/play-history/route.ts)), and `cleanupStaleSessions`.
    - A restart (Docker upgrade, host reboot) takes the poller and SSE down for the whole outage, so every row's `lastSeenAt` is stale by the downtime and the `>= SESSION_ABSENCE_GRACE_MS` (60s) grace becomes trivially true the instant the process comes back.
    - On the first boot snapshot a session can be briefly absent from `/status/sessions` — Plex still spinning up, an incomplete session list, or a Plex-side `sessionKey` reset. With the grace defeated, that single transient absence **finalizes AND ledger-locks a session that's still playing**, and the now-playing card never returns (matches the reported "restart marked my stream stopped and never picked it back up").

    Rule: call `reanchorActiveSessionsOnBoot()` ([play-history.ts](src/lib/play-history.ts)) — an in-memory once-guarded `updateMany` that sets `lastSeenAt = now` for every row — at the top of BOTH `bootstrapReconcile` and the poller's `syncPlayHistory`, before either reads rows for its stale sweep. Whichever runs first wins; it covers Plex and Jellyfin in one write. A genuinely-ended session is still finalized ~60s after boot once confirmed absent across real post-boot observations. Don't move the finalize ahead of the re-anchor, and don't measure the grace off a pre-restart timestamp.

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

24. **The native-client version gate (426) fails SOFT and is NEVER an authz input.**

    Why:
    - The 426 force-upgrade gate in [proxy.ts](src/proxy.ts) exists to stop an *honest, stale* native build from running known-bad client code. It is NOT a security control — a hostile client spoofs any `build=`. Auth, DB revocation, `passwordChangedAt`/`sessionsRevokedAt` cutoffs, and TLS are the real boundaries; none look at the version.
    - A too-aggressive gate bricks users: blocking an unknown/legacy/unparseable client, or blocking reads, leaves the app unable to even fetch the data it needs to render a graceful "update" screen.

    Rules:
    - **Version never gates authorization, the CSRF Origin check, or the UA-fingerprint check.** Those skips key off bearer / `X-Summonarr-Client` *presence* (CORS-sound — guardrail 6b), never off the parsed version. Do not add an "if old client, relax X" path.
    - **Only a positively-identified stale build is gated.** `isClientBelowMinimum` ([src/lib/api-version.ts](src/lib/api-version.ts)) returns true ONLY when the platform is known AND `build` parsed AND `build < MIN_CLIENT[platform]`. A missing/unparseable build (e.g. a legacy bare `ios` header) ⇒ false ⇒ never blocked. Keep `parseNativeClient` tolerant.
    - **Only MUTATING `/api/*` requests get 426.** Reads are never blocked. Do not widen the gate to GETs.
    - **Ships dormant; arm deliberately.** `MIN_CLIENT.ios` starts at `1` (no install is below the first App Store build). To force-upgrade builds below `N`, raise `MIN_CLIENT.ios = N` and redeploy the server — no app release is needed to fire the gate (the gate UI already ships in the client). NEVER set it above the lowest build still in the wild, or you brick current installs.

25. **API contract version is a protocol constant; `/api/config/compat` stays public + coarse; the upgrade URL is client-hardcoded.**

    Why:
    - `API_VERSION` ([src/lib/api-version.ts](src/lib/api-version.ts)) is a *capability-negotiation* integer, NOT the marketing version. It is the deliberate exception to the Releasing section's "no version constant in `src/`" rule (which forbids a third copy of the *marketing* version). Bump it only on a breaking wire-contract change; never auto-derive it from `package.json`.
    - The compat descriptor is a pre-auth surface any internet scanner can hit; a precise version string there is a CVE-targeting aid (defense-in-depth — the login page already leaks hints, so it's not treated as a secret).
    - A server-supplied "update here" link would let a malicious/compromised server redirect the upgrade flow to a phishing or sideload URL.

    Rules:
    - **`GET /api/config/compat` returns integers only** (`apiVersion` / `minApiVersion` / `minClient`) — no marketing version, no secrets, no server URL, no DB read. It is intentionally public: listed in `isPublicPath` ([proxy.ts](src/proxy.ts)) AND as a documented `ROUTE_EXCEPTIONS` entry in [scripts/audit-routes.mts](scripts/audit-routes.mts). Native clients probe it BEFORE sign-in; fail-soft — a 404 (legacy server) or any reachable response ⇒ proceed.
    - **`X-Summonarr-Api` is stamped on responses** in `proxy.ts` so clients can learn the contract passively. Keep it a coarse integer.
    - **The force-upgrade CTA URL is hardcoded in the client** (iOS `AppInfo.appStoreURL`), NEVER taken from a server response. The server may send a message string, never a link the client opens.
    - **Floors are for breaking changes; feature-gate for graceful degradation.** `MIN_API_VERSION`, the client's `requiredServerApiVersion`, and `MIN_CLIENT` are HARD floors — the accepted version *range* is `[floor, ∞)`, not an exact pin. Raise a floor ONLY when a peer genuinely cannot function. To keep supporting an older peer that merely *lacks* a newer feature, leave the floor and gate that feature on the reported `apiVersion` (the iOS client reads `X-Summonarr-Api` → `SessionStore.serverSupports(N)`). Bumping a floor per feature collapses the range into a hard cutoff — the opposite of "support a prior version for a while."

26. **NEVER `logAuditOrFail` after a mutation that has already committed.** Use `logAudit` (the swallowing variant) post-commit.

    Why:
    - `logAuditOrFail` ([src/lib/audit.ts](src/lib/audit.ts)) re-throws on a failed audit write — it exists for use *inside* a `$transaction`, where a failed audit should roll the whole thing back.
    - Called *after* a `prisma.x.delete`/`update`/raw mutation has already committed (no enclosing tx), a transient audit-write failure returns **500 on a successful destructive operation**. The retry then 404s (row already gone) with no audit trail, or re-applies and double-audits (role-change).
    - This was the failure mode in six routes (user delete + role-change, play-history delete, DB restore, Plex + Jellyfin terminate, cache clear) — all switched to `void logAudit(...)`.

    Rule: `logAuditOrFail` is legitimate **only** as the last op inside a `$transaction` (so its throw rolls back the mutation it audits). Anywhere the mutation is already durable, use `logAudit` — its contract is "a failed audit write must never break the triggering request."

27. **In-memory ledgers / "force-revalidate" marks go AFTER the DB write they guard, not before.**

    Why:
    - Several finalize/revocation paths keep an in-process set (`recentlyFinalizedPlexSessions`, `markSessionForceRevoked`) alongside a DB write (`recordCompletedSession`, AuthSession delete). The in-memory mark is the single-replica fast path; the DB row is the source of truth.
    - Marking *before* the write means a failed/rolled-back write leaves the ledger asserting a state the DB doesn't reflect: a session ledger-locked with no `PlayHistory` row (the now-playing card never returns for ~1h), or a "revoked" mark on a row that's still live (resurrects on restart).
    - `revokeAllUserSessions` already does it right (mark after the tx); `revokeSessionById` was fixed to match.

    Rule: write the DB row first; only on success update the in-memory ledger. If the write throws, let it propagate so the caller learns the operation failed instead of trusting a phantom mark.

28. **NEVER hard-delete a `MediaServerUser`. Soft-delete (`active = false`) instead.**

    Why:
    - `PlayHistory` and `ActiveSession` FK `MediaServerUser`. The FK used to be `onDelete: Cascade`, so deleting a server-user *permanently and unrecoverably* destroyed their entire watch history — and the live poller is the only Jellyfin-history writer (guardrail 19), so it cannot be rebuilt. Play history is server/usage data that must outlive a user's removal; it is not part of the user's account.
    - A degraded Jellyfin `/Users` fetch (a `200` with a truncated list) once made the hourly download-policy prune delete every absent user and cascade-erase their history.

    Rules:
    - The FK is now `onDelete: Restrict` on both `PlayHistory` and `ActiveSession` — any hard-delete of a `MediaServerUser` that still has history/sessions THROWS, surfacing the landmine instead of silently erasing data. Do not revert it to `Cascade`.
    - The Jellyfin prune in [download-policy.ts](src/lib/download-policy.ts) sets `active = false` (soft-delete) for departed users; the next sync re-activates a returning one. Do not reintroduce `deleteMany` on `MediaServerUser`.
    - Active-management surfaces (the diagnose count, the REST server-users list) filter `active: true`; history/stats surfaces (the play-history user filter, the activity/stats aggregates) intentionally do NOT — a departed user's history stays visible and attributed. The admin server-users **page** is the deliberate middle case: it lists active rows PLUS departed ones that still hold play history, because those are exactly the rows whose attribution may need fixing by hand. `PATCH /api/admin/server-users/[id]` mirrors that split — the `{ userId }` link branch accepts a departed row, the `{ downloadsEnabled }` branch still 404s it (there is no server-side account left to push a policy to).
    - **De-registering a media-server instance is NOT a licence to hard-delete its rows.** The removal cleanup in `/api/admin/media-instances` (guardrail 35) deletes that slug's library items and `ActiveSession` rows, but `MediaServerUser` is soft-deleted (`active = false`) and `PlayHistory` is left completely untouched — the same rule, at a new temptation site.

29. **Page/layout authorization is DB-checked (`authActive()` / `readActiveSummonarrSession()`), NEVER the proxy alone and NEVER JWT-only `auth()`.**

    Why:
    - `proxy.ts`'s matcher carries a `missing: [next-router-prefetch, purpose=prefetch]` clause, so the proxy (login redirect, DB session check, admin/role gating) does **not** run on prefetch requests. A forged `GET /page` with header `next-router-prefetch: 1` skips all of it. Next's own docs say the same — *"Always verify authentication and authorization inside each Server Function rather than relying on Proxy alone"* ([proxy.md](node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md)) — and prescribe a check close to the data ([data-security.md](node_modules/next/dist/docs/01-app/02-guides/data-security.md)).
    - `auth()` ([src/lib/auth.ts](src/lib/auth.ts)) verifies only the JWT signature + expiry. It does NOT see a revoked `AuthSession`, a `sessionsRevokedAt`/`passwordChangedAt` cutoff, or a role demotion. On the prefetch path (proxy skipped) it would be the *only* check, so a demoted-but-unexpired admin token could read admin pages.

    Rules:
    - Every `(app)` page is login-gated by the DB-checked root [(app)/layout.tsx](src/app/(app)/layout.tsx) (`authActive()` → `redirect("/login")`). Keep that gate — it's the prefetch-safe backstop for the whole subtree. The redirect MUST stay before/outside the layout's `try/catch` or the `NEXT_REDIRECT` throw gets swallowed.
    - A page/layout that makes a **role-based** redirect (`role !== "ADMIN"`, etc.) MUST read the session with `authActive()` (drop-in for `auth()`, identical `SummonarrSession` shape) or `readActiveSummonarrSession()` (the [admin layout](src/app/(app)/admin/layout.tsx) pattern) — never JWT-only `auth()`.
    - `auth()` is fine for **personalization** reads (badge visibility, "my vote", "show admin shortcut") — a few seconds of staleness there is cosmetic, not an authz decision. Don't pay the DB round-trip on every discovery-page render for those.
    - API routes are already DB-checked via `withAuth`/`withAdmin` (guardrail 6a). This rule is about server-component pages/layouts only.
    - `authActive()` and the public `/api/auth/me` ALSO re-check the UA fingerprint (`matchesStoredFingerprint`, [ua-fingerprint.ts](src/lib/ua-fingerprint.ts)) for cookie sessions — the prefetch-skip means the page-render path and that public route are otherwise the only authenticated surfaces with no fingerprint enforcement. Bearer/native sessions skip it (app-secure storage, not an ambient cookie).

30. **Cap every JSON request body — `readJsonCapped(req, maxBytes)` (or `readJsonCappedOr` for tolerant routes), never a bare `await req.json()`.**

    Why:
    - [next.config.ts](next.config.ts) sets `proxyClientMaxBodySize: "50mb"` — a backstop, NOT a per-route limit. A bare `await req.json()` will parse up to 50 MB, so an oversized body (anonymous on first-run `register`, or any authenticated user on request/issue/vote routes) forces a large JSON parse = memory/CPU DoS.
    - The helpers in [body-size.ts](src/lib/body-size.ts) combine `checkBodySize` (Content-Length fast-reject) + `assertBodyBytesUnderCap` (post-read byte check; catches `Transfer-Encoding: chunked`) + `JSON.parse`. `readJsonCapped` 400s on malformed JSON; `readJsonCappedOr(req, max, fallback)` tolerates an empty/malformed body for routes where no body is a valid request.

    Rules:
    - New JSON route → `const parsed = await readJsonCapped<T>(req, CAP); if (parsed instanceof NextResponse) return parsed; const body = parsed;`. Caps: ~16 KB single object, 32–64 KB text-bearing, ~1 MB bulk/batch arrays.
    - Don't reintroduce a bare `await req.json()`. Upload/binary bodies (thumbnails, backup restore) are the only legitimate bypass.
    - Every JSON-reading route — including admin/settings/sync — now goes through the helpers; there are zero bare `await req.json()` calls left in `src/app/api`. Keep it that way.

31. **Bound large async fan-outs with `mapLimit` / `settleLimit` from [src/lib/concurrency.ts](src/lib/concurrency.ts) — never a bare `Promise.all(items.map(...))` over a user/library-sized list.**

    Why:
    - A bare `Promise.all` issues every task at once. Over a request-batch- or library-sized list this saturates the small Prisma connection pool and bursts hundreds of requests at upstream APIs (TMDB ~50 req/s; OMDB free tier 1k/day). Two live cases motivated the helper: the blocking ratings batch fanned out up to 200 OMDB chains ([omdb-availability.ts](src/lib/omdb-availability.ts)), and the cold Discover page fired ~105 concurrent TMDB list fetches ([tmdb.ts](src/lib/tmdb.ts)).
    - `mapLimit` is a bounded `Promise.all` (rejects if a task rejects — use when tasks self-catch). `settleLimit` is a bounded `Promise.allSettled` (never rejects) — a drop-in for the paged TMDB `Promise.allSettled(Array.from(...))` pattern.

    Rules:
    - Fixed-size fan-outs (2–3 elements, e.g. movie+tv split, similar+recommendations) stay as plain `Promise.all` — the cap is only for lists whose length scales with input/library size.
    - Pair the cap with `coalesce(key, fn)` (now exported from [concurrency.ts](src/lib/concurrency.ts); tmdb.ts, trakt.ts and mdblist's top-rated helper all import it) on shared cache-key computations so simultaneous callers share one fan-out instead of multiplying it. The list helpers wrap their whole body in `coalesce` (keyed on their cache key) and bound the page fetch with `settleLimit`; match that shape for any new list helper.
    - Don't add a third copy of the OMDB API key read — `getApiKey()` in [omdb.ts](src/lib/omdb.ts) is memoized + in-flight-coalesced (30s TTL) precisely so a 200-item batch doesn't issue ~400 identical `setting.findUnique` reads. Pass `{ fresh: true }` only for the admin connection test.

32. **A Radarr/Sonarr instance is identified by an `arrInstance` slug string, NEVER the old `is4k` boolean.** The two-instance (HD/4K) model was generalized to N named instances (e.g. an "anime" instance).

    Why:
    - The instance identity moved from `is4k Boolean` to `arrInstance String @default("")` across all six models (`MediaRequest`, `Radarr/Sonarr{Wanted,Available}Item`, `TrashApplication`) — `arrInstance` sits in the `@@id`/`@@unique` keys. Slugs: `""` = the default instance, `"4k"` = the legacy 4K instance, `"anime"`/… = named.
    - **The migration is NON-DESTRUCTIVE.** `is4k` is RETAINED in the schema (deprecated, out of every key) so `prisma db push` never drops a column — a column drop is a "genuinely destructive" change the entrypoint refuses to auto-apply (`docker-entrypoint.sh` exits 1). A pre-`db push` hook in the entrypoint backfills `arrInstance` from `is4k` (false→"", true→"4k") on boot, so db push only swaps the PK/unique keys onto an already-populated column — landing as the entrypoint's **auto-safe** "unique constraint" / "primary key will be changed" warnings. No manual step, no data loss; a real key collision fails db push loudly (23505) rather than merging 4K into the default. Non-Docker deploys run [scripts/migrate-is4k-to-arrinstance.mjs](scripts/migrate-is4k-to-arrinstance.mjs) before their manual push. Don't drop `is4k` until a later release when every deployment has migrated (mirrors the deprecated `User.autoApprove`/`quotaExempt`).

    Rules:
    - **Instance→Setting-key derivation is centralized in [arr-instances.ts](src/lib/arr-instances.ts)** (`arrSettingKey(service, slug, field)`; named slugs capitalize their first char → `radarrAnimeApiKey`; `"4k"` is unchanged so all legacy `radarr4k*` keys survive). The server-side registry (which instances exist + their routing/access metadata, a JSON `arrRadarrInstances`/`arrSonarrInstances` Setting) is [arr-instance-registry.ts](src/lib/arr-instance-registry.ts) — `getArrInstances` / `getSyncableArrInstances`.
    - **`arr.ts` client fns take `variant: ArrVariant = ""` — an instance slug.** Pass a request's `arrInstance` through. The legacy `"hd"` spelling still maps to `""` in `getCfg` (don't remove that back-compat). Sync fans out over `getSyncableArrInstances` with per-instance SCOPED `deleteMany` (guardrail 13); webhooks resolve the firing instance by secret-as-discriminator over every instance's `arrSettingKey(service, slug, "WebhookSecret")` (guardrail 2 — no early return, no HMAC).
    - **Per-instance secret Setting keys (`radarr<Slug>ApiKey`/`WebhookSecret`) must stay encrypted.** `isSensitiveSettingKey` in [settings-sensitive-keys.ts](src/lib/settings-sensitive-keys.ts) matches them by regex (guardrail 7a) — the static list can't enumerate admin-defined slugs.
    - **Access to a NAMED instance is a per-user grant** (`User.instanceGrants` JSON; `canRequestInstance`/`canAutoApproveInstance` in [permissions.ts](src/lib/permissions.ts)). The default is open to any requester; `"4k"` still uses the `REQUEST_4K*`/`AUTO_APPROVE_4K*` bits (zero user-data migration). Request routing (anime = TMDB genre 16 + `ja`/JP) is `routeMediaToSlug`.
    - **Instance-aware surfaces (landed post-v0.15.0):** the trash-guides admin UI/API (`?variant=<slug>`), the approve quality-profile picker (`/api/requests/quality-profiles?instance=<slug>`, legacy `?is4k=` kept), admin request-list instance chips, bulk "Request all" + Discord `/request` auto-routing (per-item `routeMediaToSlug`, access-gated fallback to default), the per-user grants editor (Users → Permissions & Quota → Instance access), detail-page "Request on <instance>" buttons ([request-instance-button.tsx](src/components/media/request-instance-button.tsx)) — whose target list has ONE resolver, `resolveNamedInstanceTargets` ([named-instance-targets.ts](src/lib/named-instance-targets.ts)), shared by the movie page, the TV page and `GET /api/requests/instances`; **never re-derive it at a call site.** All three had open-coded it and two had already drifted: the route enumerated `getArrInstances` (every REGISTERED instance) while the pages used `getSyncableArrInstances` (configured only), so a native client got a button for an instance with no url/apiKey that `/api/requests` can only answer 400 to. Enumerating the *configured* set is the correct behavior, and the resolver also collapses the per-instance `findFirst`+`findUnique` pair into two `arrInstance: { in: … }` reads for the whole set — library-diff arr verdict, per-instance disk stats (`ArrDiskSpace.extra` — additive, don't change the `radarr`/`sonarr` fields native clients decode), and `IssueGrab.arrInstance` + the issue Replace instance picker (webhook completion match is instance-scoped). The per-source `/api/sync/plex` + `/api/sync/jellyfin` Resync routes are ALSO instance-aware since a body `instance` slug was added — every read, delete AND insert follows it. That last one is not optional: scoping the deletes while leaving `serverInstance` off the inserted rows deletes a named server's library and re-creates it under the default slug, which un-restricts a `restricted` server and puts its server-local ratingKeys in the default's namespace. Their marking pass carries the same per-user visibility gate as the orchestrator, for the same reason. `/api/sync/tv-episodes` likewise rebuilds `TVEpisodeCache` from the UNION of every configured server, gated all-or-nothing — that table has no `serverInstance` column, so a partial union would wipe a down server's rows.
    - **Still default/HD+4K-scoped by design (not gaps):** the legacy HD/4K connection forms in settings-ui.tsx (named instances use `ArrInstancesManager`), `Request4kButton`'s `is4k:true` body (legacy shorthand the API keeps), the TRaSH starter pack + overview KPIs, and `RequestButton`'s request-time profile picker (default instance; the server drops the override on auto-route — see requests/route.ts).

33. **Account removal DISABLES; it never scrubs. The irreversible scrub is a separate, admin-only, two-step action.** [account-lifecycle.ts](src/lib/account-lifecycle.ts) is the only module that implements either half.

    Why:
    - Both removal paths (`DELETE /api/profile` self-delete and `DELETE /api/admin/users/[id]`) used to anonymize in place. That set `MediaServerUser.userId = null`, and **both `getMyWatchHistory` and the admin per-user views resolve play history through `MediaServerUser.userId`** — so from the moment an account was removed, every watch the person kept racking up on Plex/Jellyfin stopped being attributed to anyone. It never healed: the only relink path is by email, and the scrubbed row's `deleted-<id>@deleted.invalid` (or a Jellyfin user's synthetic `@jellyfin.local` login email) can never match what the media server reports.
    - Anonymizing also destroyed the identity an operator needs to undo a mistaken removal. A self-hosted instance wants "turn this account off", not "erase this person", as the default.

    Rules:
    - **`deactivateUserInTx` writes EXACTLY two things**: `authSession.deleteMany` (kill every device) and `{ deactivatedAt, sessionsRevokedAt }` on the User row. Do NOT add a field to that payload, and do NOT touch `MediaServerUser` — that link staying bound is the whole point. The deepEqual pins in `tests/account-lifecycle.test.mts` and `tests/profile-routes.test.mts` fail if you do.
    - **`purgeUserDataInTx` (POST `/api/admin/users/[id]/purge`) is the only place that scrubs**, and it throws `NotDeactivatedError` unless the row is already disabled — an active user's data can never be destroyed in one click. It is what services a real "delete my data" request (App Store Guideline 5.1.1(v) / GDPR erasure); the in-app "close account" button no longer does, so **an operator must run a purge when a user asks for erasure**. It sets `purgedAt`, which permanently blocks reactivation.
    - **Identity survives, so SIGN-IN must be refused explicitly.** Every provider's lookup (email, `plexUserId`, `jellyfinUserId`, OAuth `Account`) still matches a disabled row. `signInAndMintSession` ([auth.ts](src/lib/auth.ts)) is the single chokepoint: it re-reads `deactivatedAt` and throws `AccountDeactivatedError` **before** `initializeTokenOnSignIn` mints a JWT or writes an AuthSession row. If you add a provider, route it through that function — do not rely on `verifyAndRefreshSession`'s `deactivatedAt` check, which only fires on the *next* request, after the client already holds a token.
    - **Notifications are suppressed at two chokepoints, not per channel.** A disabled row keeps a live notification email, Discord link and push subscriptions. `claimAvailableNotificationWinners` ([notify-available.ts](src/lib/notify-available.ts)) drops disabled requesters from the batch "now available" winners (covering all six sync sites × four channels at once), and `notifyRequestStatusChange` gates the single-request approve/decline/available fan-out on one lookup. Don't re-scatter this into the individual push/Discord/email queries.
    - **NEVER test for a purged row with a bare `purgedAt != null`** — use `isPurgedRow` ([account-lifecycle.ts](src/lib/account-lifecycle.ts)). `purgedAt` postdates the deactivate/purge split, so every account removed by the older anonymize-on-delete code carries the scrubbed SHAPE (`deleted-<id>@deleted.invalid`) with a NULL marker. Reading those as merely "disabled" let one be re-enabled into a **zombie**: an ACTIVE row with no password, no provider subject, no OAuth rows and an unroutable email, so nobody can ever sign into it, while it counts toward the active-admin total and re-enters the Plex backfill's candidate set (warning on every boot). `markLegacyPurgedAccounts()` stamps the marker at boot and re-disables any existing zombie; it runs BEFORE `runPlexUserBackfillIfNeeded` in [instrumentation.ts](src/instrumentation.ts) for exactly that reason. The tombstone address has one producer, `purgedEmailFor` — keep it that way or detection silently breaks.
    - The last-admin CAS (advisory lock 42) lives on the deactivate path only; purge doesn't need it because a disabled row is already out of the active-admin count. Callers MUST short-circuit an already-disabled row before calling `deactivateUserInTx` — re-running it on a disabled ADMIN sees its own row excluded from the count and throws `LastAdminError` spuriously.

34. **`MediaServerUser → User` attribution resolves on the provider SUBJECT id first, email second — and NEVER overwrites a manual pin.** This binding is what makes play history belong to somebody: both `getMyWatchHistory` and every admin per-user view resolve through `MediaServerUser.userId`.

    Why:
    - `MediaServerUser.sourceUserId` **is** the Plex accountID / Jellyfin userId, i.e. exactly what sign-in pins to `User.plexUserId` / `User.jellyfinUserId`. A match there is the same identity by construction, with no collision risk — those columns are unique and written only by the matching provider's sign-in.
    - Email is a weak key and used to be the ONLY one. A Jellyfin account needs no email at all (both sides null ⇒ nothing ever linked), a Jellyfin-provisioned row carries the synthetic `jellyfin-<id>@jellyfin.local` login address no media server will ever report, and either side is user-changeable. Those users' watches were silently attributed to nobody, forever.

    Rules:
    - Both resolvers — `resolveMediaServerUser` ([play-history.ts](src/lib/play-history.ts), every 5s poll) and the hourly Jellyfin sync in [download-policy.ts](src/lib/download-policy.ts) — try the subject id, then fall back to email. Only the **email** branch carries the `mediaServer` cross-provider guard; a subject match needs none.
    - **Neither resolver may filter on `deactivatedAt`** — a disabled account still owns its history (guardrail 33). A PURGED account is excluded by construction on both branches instead (the purge nulls the subject columns *and* rewrites the email), so don't add a redundant status filter that would also catch disabled users.
    - **`manualUserLink = true` means an admin set the binding by hand — automatic resolution must skip the row entirely.** Set by `PATCH /api/admin/server-users/[id]` for both a manual link and a manual unlink (an unpinned unlink would be re-bound on the next poll). Without this pin the admin action is useless: the poller re-derives `userId` every 5 seconds. `{ autoLink: true }` releases the pin.
    - The link half of that route is deliberately NOT gated on `isServerAdmin` or `source === "plex"` — those guards belong to the `downloadsEnabled` half. Every identity owns watch history that has to land on the right account.

35. **A Plex/Jellyfin server is identified by a `serverInstance` slug string, and availability is a UNION across every configured server — NOTHING routes to a specific one.** Mirrors guardrail 32's arr model with that one deliberate divergence: an arr *request* must land on exactly one instance, whereas the only question multi-server answers here is "is this watchable somewhere, and what's playing right now."

    Why:
    - Identity moved into `serverInstance String @default("")` on five models — `PlexLibraryItem`, `JellyfinLibraryItem`, `MediaServerUser`, `PlayHistory`, `ActiveSession` — sitting inside the widened `@@id`/`@@unique` keys. Slugs: `""` = the default (and, for every single-server deployment, only) server; `"remote"`/… = named. Unlike `is4k`→`arrInstance` there is **nothing to backfill** — a plain `ADD COLUMN` with a `""` default is already correct for every existing row, which is why this migration needed no interpretation step.
    - The default instance is **byte-identical to the pre-multi-server behavior, everywhere**: `plexSettingKey("", …)`/`jellyfinSettingKey("", …)` reproduce the exact legacy Setting keys, `activeSessionId("plex", "", key)` emits the exact legacy 2-segment `plex:<key>` id (named instances get a 3rd segment), and `mediaInstanceLabel` returns a bare `"plex"`/`"jellyfin"`. A single-server deployment must never be able to tell this generalization happened — treat any diff it *can* observe as a bug.

    Rules:
    - **Key derivation is centralized in [media-instances.ts](src/lib/media-instances.ts)** (`plexSettingKey`/`jellyfinSettingKey`/`activeSessionId`/`parseActiveSessionId`/`mediaInstanceLabel`/`isValidMediaInstanceSlug`) — a **pure, zero-import** module, so `"use client"` components import it directly for badges. The server-side registry (which instances exist; a JSON `plexInstances`/`jellyfinInstances` Setting) is [media-instance-registry.ts](src/lib/media-instance-registry.ts) — `getMediaInstances`/`getSyncableMediaInstances`/`saveMediaInstances`. Entries are deliberately thin (`{slug, name}`): there is no `restricted`/`serverAll`/`autoRoute` metadata because nothing routes. The default `""` is **synthesized, never registry-backed** (a `""` registry entry would shadow it), and `saveMediaInstances` is a full replace — which is why the POST's "instances must be an array" guard is load-bearing: coercing a missing array to `[]` reads as "remove every named instance" and destroys unrecoverable encrypted tokens.
    - **Every library write is `serverInstance`-scoped and every fan-out is all-or-nothing** (guardrail 13). The orchestrator's Plex and Jellyfin arms each fetch per instance with per-instance error isolation, union the results into the one map the ~300 lines of downstream availability logic already expect, and write inside ONE shared transaction looping a scoped `deleteMany` + `batchCreateMany` per instance. `plexSyncSucceeded`/`jellyfinSyncSucceeded` require the write AND *every* configured instance's fetch to have succeeded, because they gate the revert/stale-fallback checks, which need to know this run's union is a COMPLETE picture. A failed instance contributes nothing and keeps its existing rows.
    - **`TVEpisodeCache` has no `serverInstance` column** (episodes are TMDB-anchored shared data), so its rewrite accumulates across instances and runs ONCE at the end, gated on `allEpisodesFetched && writable.length === fetched.length && writable.length > 0`. **That middle term is load-bearing**: an instance whose *library* fetch failed never enters `writable` and so never gets an episode fetch at all — without it the whole-table rewrite proceeds on an incomplete union and wipes the down server's episode rows for the length of its outage. Looping delete+insert per instance is also wrong (each pass would wipe the previous one's rows).
    - **Session ids carry the instance, and the finalize ledger must respect it.** Build every `ActiveSession.id` with `activeSessionId(...)` — a single stray `` `plex:${sessionKey}` `` template literal reintroduces the collision where two servers reusing the same low-cardinality `sessionKey` fight over one row. `clearFinalizedNotInCurrentSnapshot(instance, keys)` releases only entries whose *parsed* id belongs to that instance: instance A's snapshot can never release B's ledger state (B's keys are never in A's snapshot). Absence sweeps and bootstrap reconciles are likewise scoped, or one instance finalizes another's live sessions.
    - **Auth: the membership union fails open, and an INDETERMINATE instance poisons it.** `getCachedPlexAllowlist` ([plex-membership.ts](src/lib/plex-membership.ts)) caches per slug and returns the union; a configured instance that is cold with a failing/empty fetch returns `null` for the WHOLE call (no opinion, nobody locked out) — a partial union would mass-revoke every user whose only membership is on the down server. A STALE set is not indeterminate (it serves stale, so one outage never blanks the others); an UNCONFIGURED instance contributes nothing and never poisons; and an "unconfigured" verdict must never arm the retry backoff, or honoring that cached skip after an admin finishes configuring the instance yields an *enforcing* partial union. Sign-in ([auth.ts](src/lib/auth.ts)) loops instances first-match-wins with per-instance error isolation but still fails CLOSED overall; QuickConnect's instance is pinned into the signed flow cookie at initiate time and read back from the VERIFIED cookie, never a client-supplied field; and **rate-limit keys stay unscoped by instance** so an attacker's budget can't multiply with server count.
    - **On the PLEX membership, poller, backfill and SSE paths, read config with `setting.findUnique` ONLY** — `getMediaInstances` + `getPlexConfig(slug)` + a skip-if-unconfigured `continue`, never `getSyncableMediaInstances`/`isMediaInstanceConfigured` (they issue `findMany`). This is a test-harness contract, not a style preference: those suites discriminate reads BY SHAPE — `session-refresh`'s stub defines only `findUnique`, and the poller's harness starves plex-events' reconcile by matching *any* `findMany` over **Plex** connection keys, so a shape change there opens a real SSE stream against a fetch stub or silently converts a config-guard test into an accidental exception test. The poller's **Jellyfin** arm is the deliberate exception and still calls `getSyncableMediaInstances("jellyfin")` — the starvation trap is Plex-only, and that harness's `isSyncRead` branch depends on the `findMany` reaching it. The in-code comment above the Plex arm in [sync/play-history/route.ts](src/app/api/sync/play-history/route.ts) is the authority on which arm is which; don't "unify" them.
    - **Per-instance secret Setting keys must stay encrypted.** `MEDIA_INSTANCE_SECRET_RE` in [settings-sensitive-keys.ts](src/lib/settings-sensitive-keys.ts) matches `plex<Slug>AdminToken`/`jellyfin<Slug>ApiKey` by regex (guardrail 7a) — the static list can't enumerate admin-defined slugs. It deliberately does NOT match `ServerUrl`/`AdminEmail`/`Libraries`/`*PathStripPrefix`/`RestrictSignIn`, which stay plaintext.
    - **De-registering an instance must clean up its derived rows** — `/api/admin/media-instances`'s removal path deletes that slug's `PlexLibraryItem`/`JellyfinLibraryItem` and `ActiveSession` rows and its full Setting-key set, inside the same transaction as the registry write. Without it those library rows are unreachable by every writer (no sync path targets a de-registered slug) while still counting toward the admin dashboard, the settings library count and `/api/admin/stats`, which read them unscoped. (Since grants landed, the user-facing read path no longer shows them — the visible-instance list comes from `getMediaInstances`, which returns only REGISTERED entries, so a de-registered slug is filtered out. Don't weaken the cleanup on the strength of that: the admin surfaces above still count the orphans, and nothing else would ever remove them.) `MediaServerUser` is soft-deleted and `PlayHistory` untouched (guardrails 28/19). The cleanup is not retroactive: a deployment that removed an instance before this shipped still has orphans.
    - **A RESTRICTED instance's library counts only for users granted it, and that answer must be produced in the DATA layer.** `MediaInstanceConfig.restricted` + `User.mediaServerGrants` + `canViewMediaInstance` ([permissions.ts](src/lib/permissions.ts), still a zero-import leaf) + the resolvers in [media-visibility.ts](src/lib/media-visibility.ts). Load-bearing details: grants are **service-namespaced** (`{plex:{…}, jellyfin:{…}}`) because Plex `"remote"` and Jellyfin `"remote"` are different servers with different content — do NOT copy arr's flat `instanceGrants` map, which has that collision latent; the default `""` instance can never be restricted (the byte-identical-default rule); ADMIN short-circuits; and `UNSAFE_GRANT_SLUGS` guards BOTH nesting levels on parse and serialize. **Never enforce this at the presentation layer** — `getBadgeVisibility` is a cosmetic mask and the raw payload ships the unmasked field, so a mask there leaks a restricted server's availability to anyone with devtools or the native client. `attachAllAvailability` resolves visibility internally from the `userId` it already receives (like its existing `getUserHiddenSet` read), so all 28 call sites stayed untouched; the eight surfaces that bypass that chokepoint (request POST's already-available rejection, bulk — which must use the TARGET user's grants, not the caller's — issues, votes, both Discord paths, person pages, the two detail pages) each scope their own query. **`TVEpisodeCache` is the one table that cannot be scoped** — it has no `serverInstance` column and every server's episodes accumulate into one `source` namespace, so its three read sites instead gate on whether the viewer can see some server of that type actually holding the title (`visibleEpisodeSourcesFor`/`From` in [media-visibility.ts](src/lib/media-visibility.ts)). Without that gate a plain `source IN (…)` read hands an ungranted user the restricted server's per-episode holdings as raw JSON on `/api/tv-availability` and the season route. **The `(app)/admin` subtree is deliberately NOT gated**: it admits `MANAGE_USERS`/`MANAGE_REQUESTS`/`MANAGE_ISSUES`, none of which carry the ADMIN bit, and those roles need the true global library to triage — same reasoning as guardrail 28's unscoped history/stats surfaces. Admin delegation is a trust boundary, not a visibility one. **`/popular` is a SECOND deliberate exemption, and a user-facing one.** `getMostPopularOnServer` aggregates `PlayHistory` across every server with no `serverInstance` predicate, so its ranking, play counts, viewer counts and watch hours span restricted instances for every viewer. This was audited, scoped, and then deliberately reverted: "most played on the server" is meant to answer one global question, and a viewer-relative ranking makes two users legitimately disagree about it. The consequence is accepted and is NOT a bug to re-fix — an ungranted user can infer that a restricted server holds a title and roughly how much it is watched. **Availability is still masked**: the badge beside such a title stays hidden because `attachAllAvailability` scopes normally, so the page deliberately answers "this is popular here" while refusing to answer "you can watch this". If you re-audit this file, that asymmetry is intentional. Anything NEW that exposes per-server watch data to non-admins is still covered by the rule above — this exemption is for this one aggregate, not a licence for the class.
    - **The sync-side grant filter is PRE-CAS, and that is not a style choice.** A request flips to `AVAILABLE` only when the title sits on a server *that requester* can see, and the notify follows the same gate — so the filter runs on the already-materialized candidate array before any id reaches `claimAvailableNotificationWinners`. That preserves guardrail 14 (the CAS is still the sole writer of `notifiedAvailable` and simply never sees a gated id) and guardrail 15 (the `stillPending` snapshot is still READ once — the invariant constrains the read, not filtering afterward; the marking pass has filtered per-user on `User.mediaServer` in four places since long before grants). **Do NOT use the `deactivatedAt` filter in [notify-available.ts](src/lib/notify-available.ts) as the template** — that one sits AFTER the `UPDATE … RETURNING` and deliberately BURNS the claim so a re-enabled account doesn't replay a backlog. Burning it here would mean an ungranted requester could never be notified even after being granted. A gated row keeps `notifiedAvailable = false`, stays PENDING/APPROVED, and is re-evaluated every run. The two ARR marking passes are deliberately ungated: *arr availability is a file in a root folder with no instance identity, so there is nothing per-instance to gate on.
    - **Instance-aware surfaces:** library/episode sync + the availability union, the 5s play-history poller and the Plex SSE manager map (one manager per instance), download-policy user reconcile, Jellyfin sign-in (server picker when >1) and Plex membership, both terminate-session routes, fix-match (DB row *and* the upstream call — they must agree, or you rewrite the wrong server's library with another server's ratingKey), bad-matches + admin/library path normalization (grouped per instance so one server's mount root can't collapse the other's), and per-server badges on admin library/activity/users.
    - **Still default-only by design (not gaps):** Plex reachability (`plexServerReachable` + the `plex:reachability` SSE event + the admin badge are single-server plumbing), library-scan's post-approve trigger, the webhook presence probes, and the `library-sample-paths` mount preview (default instance only — mixing instances would collapse the inferred mount to ""). Per-instance `Libraries` and `Movie/TvPathStripPrefix` are now WRITABLE from the media-instances manager; the strip prefixes have delete-on-blank semantics there (an empty-string row would shadow the `named ?? default` fallback in bad-matches/admin-library, so blank = delete the row = inherit the default server's prefix).

36. **An unconfigured media server is SKIPPED, never failed. A client must decide that BEFORE the request, not from the response.**

    Why:
    - `/api/sync/plex` and `/api/sync/jellyfin` answer `400 {"error":"<X> server not configured"}`. That is a perfectly good signal *for that one server*, but every admin control POSTed to both unconditionally and then folded the two answers into one verdict — so on a single-server deployment (which is most of them) the absent server's 400 decided the outcome. `ResyncLibraryButton` took the FIRST error and went red on a run where its one real server had just rewritten its whole library; `MasterDbFillButton` did the opposite, requiring BOTH to fail, so a genuine outage on a two-server install shipped as green.
    - The orchestrator could not express it either. `plexMarked`/`jellyfinMarked` are initialised to `0` and always serialized, so "no Jellyfin here" and "Jellyfin synced and matched nothing" are byte-identical, and `failedSources` is gated on `plexConfiguredEnabled` so it deliberately never names a server that was never attempted.

    Rules:
    - **Pass `plexConfigured`/`jellyfinConfigured` from the server component and call only what exists.** Both parents already read the settings they need ([settings/page.tsx](src/app/(app)/settings/page.tsx), [admin/library/page.tsx](src/app/(app)/admin/library/page.tsx)) — no new query. Probing an absent server and discarding its 400 is the antipattern. The booleans describe the DEFAULT instance, which is correct for these buttons because they send no `instance` slug (guardrail 35).
    - **`/api/sync` reports `skippedSources` alongside `failedSources`** — never-attempted vs configured-and-broken. Both are omitted when empty, so absent reads correctly as "none" on an older client. For *arr the predicate keys on `radarrSyncedSlugs.size`, NOT `radarrEnabled`: the flag only means "the step did not blow up", and an enabled-but-unconfigured Radarr still sets `radarrSyncSucceeded` while refreshing nothing.
    - **Red means a CONFIGURED server failed.** Nothing configured is neutral, not an error. A partial failure still refreshes — the rows that did sync are what the click was for.
    - **Never sum `plexMarked` and `jellyfinMarked`.** One marking pass, one `stillPending` snapshot, so a title on both servers is counted once by each. Report per source.
    - **One POST to `/api/sync` already syncs Jellyfin.** Its Jellyfin arm is a strict superset of a bodiless `/api/sync/jellyfin` call (full unwindowed replace over every instance, vs insert-only inside a 2-hour window on the default alone). Don't add a second call; it re-runs the whole marking pass and races the orchestrator's own delete-and-replace.
37. **NEVER build a Jellyfin series→tmdbId map from `JellyfinLibraryItemData.itemId` alone — use `buildSeriesItemIdIndex`.** This is the SAME-server, multi-*library* twin of guardrail 35 (which is about multi-*server*); the two are independent.

    Why:
    - One title legitimately sits in several libraries on ONE server (Anime vs TV, HD vs 4K, an accidental double-import). `getJellyfinItemsByType` still collapses to one **row** per tmdbId because `JellyfinLibraryItem` is keyed `@@id([tmdbId, mediaType, serverInstance])` — that collapse is correct and stays.
    - Each copy carries its OWN item id. Every episode is filed under whichever `SeriesId` its copy has, and `processEpisodes` `continue`s on an unrecognised `SeriesId`, so a map built from the surviving id dropped the other copy's **entire episode set** out of `TVEpisodeCache` — silently, presenting as "those seasons aren't in the library". A watch of the losing copy likewise resolved to no title and attributed to nobody.

    Rules:
    - **`JellyfinLibraryItem.jellyfinItemIds String[] @default([])` holds EVERY id the title occupies, `jellyfinItemId` included.** The singular column stays as the canonical id (fix-match, the upstream remap); the array is what makes the other copies addressable. Written by the sync from `libraryItemIds(data)` ([jellyfin.ts](src/lib/jellyfin.ts)); pinned structurally by `tests/schema-invariants.test.mts`.
    - **Every read ORs the two columns — never swap wholesale to `has`/`hasSome`.** Rows written before the column existed carry `[]` until a full sync rewrites them (the hourly orchestrator always full-replaces; Jellyfin's `recentOnly` path is insert-only and will NOT backfill an existing row). The four readers: `resolveShowTmdbId` ([play-history.ts](src/lib/play-history.ts)), the poller's bulk prefetch ([sync/play-history/route.ts](src/app/api/sync/play-history/route.ts)), the admin-activity backfill, and fix-match. Whenever a lookup map is keyed by item id, key it by **every** id the row answers to or widening the query just finds a row the map then misses.
    - The array needs its **GIN index** (`@@index([jellyfinItemIds], type: Gin)`) — the 5s poller runs a `has`/`hasSome` on every tick and a btree cannot serve array containment.
    - The losing copies also ride in-memory on `JellyfinLibraryItemData.duplicateItemIds`, and `buildSeriesItemIdIndex` maps every one of them. All three series-map builders go through it — [/api/sync/route.ts](src/app/api/sync/route.ts), [/api/sync/jellyfin/route.ts](src/app/api/sync/jellyfin/route.ts), and `getJellyfinTVEpisodes`'s internal fallback. Its `.values()` repeat per copy: dedupe before using them as a tmdbId list (the `tmdbIdsBeingReplaced` delete scope).
    - **Which copy becomes the stored row is `prefersCandidate` — newest `addedAt`, item-id tiebreak — NOT arrival order.** The library-scoped walk fetches folders concurrently, so plain last-write-wins let the winner (and with it the row's `itemId`, `filePath`, `addedAt` and ratings) flip between syncs. Order-independence is the whole point; don't "simplify" it back to a bare `items.set()`. The rule is also what the unscoped single-query path already did by construction (`SortBy=DateCreated` ascending + last write), so single-library servers see no change.
    - **fix-match remaps EVERY copy, serially.** All copies of a title are mismatched on the server, so remapping one left the others reporting the old tmdbId and the next library sync could elect an unfixed copy — the admin's correction silently reverted. Only a total failure aborts; a partial one still records the copies that moved and returns a `warning` naming the shortfall. Keep it serial — parallel `FullRefresh` calls are how these start timing out.

37a. **A fix-match runs as a BACKGROUND JOB with a polled status — never as a request the browser waits on.** `POST /api/admin/fix-match` with `async: true` answers 202 + `jobId` at once and the client polls `GET /api/admin/fix-match/status?id=`; the registry is [fix-match-jobs.ts](src/lib/fix-match-jobs.ts), the client half is [client/fix-match.ts](src/lib/client/fix-match.ts).

    Why:
    - A Jellyfin series identify keeps refreshing every season and episode for minutes after `RemoteSearch/Apply` returns, and the route (rightly) waits to confirm. A reverse proxy keeps one request open for ~60s (nginx, NPM) to 100s (Cloudflare), so the browser got a **502 while the remap succeeded** — the operator saw "failed", retried, and queued yet another full refresh on an already-busy server.
    - The in-process job outlives the request the same way guardrail 17's backfill does (single long-lived Node server). The status route 404s after a restart and the client tells the operator to re-sync instead of retrying.

    Rules:
    - The synchronous default (no `async`) is a **wire contract the iOS app pins** — keep it byte-identical; gate a native switch on the reported `apiVersion` (guardrail 25), never by changing the default.
    - The same key (server + instance + mediaType + from→to) already running ⇒ the same job is returned, never a second remap of one title.
    - A job's `error` is the client-safe message only — the route still logs the real detail before throwing `FixMatchError`.

38. **`'unsafe-eval'` in the CSP is gated on `NODE_ENV === "development"` and NEVER widens. Don't delete the branch either.**

    Why:
    - React's development build calls `eval()` to reconstruct server-side error stacks in the browser, and Turbopack's HMR runtime evaluates modules the same way. Without the carve-out every `next dev` page logged *"eval() is not supported in this environment"* and those debugging features were dark — a permanent console error that trains people to ignore the dev console, which is the only place dev-only hydration **warnings** ever surface (guardrail 16a).
    - Widening it is a real vulnerability, not a lint nit: `'unsafe-eval'` makes any string reaching `eval()`/`new Function()` executable, which is most of what the per-request nonce + `'strict-dynamic'` policy exists to prevent. Production is the response an attacker can reach.

    Rules:
    - The condition lives inline in [src/proxy.ts](src/proxy.ts)'s `cspValue`. `next build` sets `NODE_ENV=production`, so Turbopack constant-folds the branch away — the string is **absent from the production bundle**, not merely false at runtime. Verify that way (`grep unsafe-eval` the built `.next/server/chunks/*.js`), not by reading the source.
    - `tests/proxy.test.mts` pins BOTH directions (development grants it; `production`/`test`/unset never do). A one-sided pin would be satisfied by a hardcoded constant — keep both.
    - Next's CSP guide documents this exact carve-out and states neither React nor Next uses `eval()` in production. `style-src` needs no dev branch here: it is already `'unsafe-inline'` in every environment.
    - [SECURITY.md](SECURITY.md) describes the **shipped** posture. It stays accurate only while this branch is dev-only — if that ever changes, that file changes with it.

39. **A new `tw-merge` group goes BEFORE the catch-all it narrows, and `npm run audit:tw-merge` must stay green.**

    Why:
    - [tw-merge.ts](src/lib/tw-merge.ts) decides which utilities conflict from a hand-maintained table of prefix regexes, and `groupOf` returns the FIRST match. A group placed after the catch-all it was meant to narrow is unreachable, and a catch-all that swallows a *different* CSS property silently deletes one of the two classes.
    - The failure is invisible: both classes are real, the merged string still looks plausible, and nothing type-checks or lints differently. It has shipped visibly twice — `ui/drawer.tsx`'s DrawerPopup lost `border-t` to the border-colour catch-all, and `ui/avatar.tsx`'s AvatarBadge lost `bg-primary` to `bg-blend-color`. One full audit against Tailwind 4.3.3's 23,286 utilities found 20 more of the same shape.
    - The table is also v3-shaped wherever nobody has looked: Tailwind renames (`bg-left-top` → `bg-top-left`) and additions (3D `rotate-x/y/z`, `transition-behavior`, `-safe` alignments) do not announce themselves.

    Rules:
    - **Order is load-bearing** — specific before catch-all. `["bg-blend", /^bg-blend-/]` must precede `["bg", /^bg-/]`.
    - **Constrain the value shape when the prefix is an ordinary word.** `border-w`/`ring-w`/`inset-s` all require `-\d`, `-[` or a known keyword. A bare `/^end-/` merged the prose `end-credits` with `end-to-end`.
    - **Utilities that COMPOSE get one group EACH, never a shared one.** Each backdrop filter and each font-variant-numeric toggle contributes its own `--tw-*` var to one shared value, so a single `backdrop`/`fvn` group deletes half the effect — the same over-merge bug from the other direction.
    - **A group whose NAME can equal a real class is a trap.** Unknown classes fall back to keying by their own string, so bare `ring` merged with ring colours only because the catch-all group happened to be *called* `ring`. Renaming it would have silently broken that; `matchGroup` (null when nothing matched) is what the auditor uses to tell the two apart.
    - **Legitimate same-family collapses are allowlisted with a reason** in [scripts/audit-tw-merge.mts](scripts/audit-tw-merge.mts) — a reset (`ease-initial`) or one shorthand spelled two ways (`bg-linear-*` vs `bg-conic`). Adding an entry is a claim that the utilities cannot meaningfully apply together; read the emitted CSS first.
    - The auditor derives everything from Tailwind's own design system, so it needs no maintenance on upgrade — it re-derives and reports. If Tailwind drops `__unstable__loadDesignSystem` it fails loudly rather than auditing an empty set.

    ```bash
    npm run audit:tw-merge            # blocking in CI
    npm run audit:tw-merge -- --list  # show the allowlisted findings and why
    ```

    **Run it bare, never piped** — a pipe reports the last command's exit code, the same trap as `generate-licenses.mts --check`.

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
- A `src/lib/*` util's public surface (`arr.ts`, `plex.ts`, `jellyfin.ts`, `cron-auth.ts`, `play-history.ts`)

run a full consumer grep:

```bash
rg "functionName|typeName" -t ts -t tsx
rg "fetch\(['\"]/api/<route>" -t ts -t tsx
```

**NEVER** assume `tsc` covers it. `fetch(...).then(r => r.json() as SomeType)` lies.

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
- `ActiveSession` — written by the 5s play-history poller ([src/app/api/sync/play-history/route.ts](src/app/api/sync/play-history/route.ts)) and the Plex SSE handler ([src/lib/plex-events.ts](src/lib/plex-events.ts)), **not** by webhook handlers (there are no Plex/Jellyfin webhooks).

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
