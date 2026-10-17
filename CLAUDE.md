@AGENTS.md

# Summonarr

Self-hosted media request aggregator. Users browse TMDB (trending / popular / discover / upcoming), request movies and TV, vote, and file issues. Admins approve requests and auto-fulfill via Radarr/Sonarr. The app ingests Plex and Jellyfin libraries + play history so users see availability, active sessions, and watch activity in one place. There is no public README — this file is the canonical project brief.

## Stack

- **Next.js 16.3.8** (App Router). AGENTS.md is not a suggestion — **read [node_modules/next/dist/docs/](node_modules/next/dist/docs/) before touching framework code**.
- **TypeScript** strict, path alias `@/*` → `./src/*`
- **Prisma 7.10** + **PostgreSQL 17**, schema-first. No `prisma/migrations/` directory — changes are applied via `prisma db push`.
- **Custom session auth** — a `jose`-signed (HS256) session JWT, not NextAuth (the project migrated off it; there is no `next-auth` dependency and no `auth.config.ts`). Session lifecycle lives in [src/lib/session-jwt.ts](src/lib/session-jwt.ts) (sign/verify + the cookie-vs-bearer transport binding, keys from [signing-keys.ts](src/lib/signing-keys.ts) — guardrail 6h), [src/lib/session-refresh.ts](src/lib/session-refresh.ts) (`verifyAndRefreshSession`: DB revocation, `sessionsRevokedAt`/`passwordChangedAt` cutoffs, role rotation, the sign-in deadline — guardrail 6c), [src/lib/session-cookie.ts](src/lib/session-cookie.ts), and [src/lib/auth.ts](src/lib/auth.ts) (`auth()` — JWT-only read). A custom `AuthSession` table backs per-device tracking + revocation. Providers: local credentials, Plex OAuth, Jellyfin (standard + QuickConnect), OIDC (`openid-client`).
- **Tailwind v4** — **no `tailwind.config.js`**. Theme lives inline in [src/app/globals.css](src/app/globals.css) under `@theme inline` with oklch variables and `.dark` class-based dark mode.
- **UI**: [src/components/ui/](src/components/ui/) — `@base-ui/react` (Radix-style) primitives scaffolded via the `shadcn` CLI, composed with the in-repo `@/lib/cva` and `@/lib/tw-merge` reimplementations (the `class-variance-authority` and `tailwind-merge` npm packages are **not** installed — these are hand-written equivalents; the merger's group table — named utilities AND a matrix of arbitrary `[…]`/`(…)` values — is CI-audited against the installed Tailwind, see guardrail 39).
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

Typechecking is **dual-compiler**: `npm run typecheck` runs the native TS 7 compiler (the `tsgo` dev-dep alias `npm:typescript@7` — also what `npx tsc` resolves to via the bin link), and `npm run typecheck:classic` runs the classic TS 6 that `next build` and typescript-eslint load via `require('typescript')`. Run BOTH before claiming types pass — the root `typescript` package MUST stay on 6 until Next and typescript-eslint support TS 7's JS API (they probe `typescript/lib/typescript.js` / `ts.Extension`, both gone in 7 — see the ignore rule in [.github/dependabot.yml](.github/dependabot.yml) and Dependabot PRs #165/#173). CI runs both checks.

The unit suite (`npm test`, Node's built-in `node:test`, files in [tests/](tests/)) covers pure/in-memory surfaces of `src/lib` plus route/proxy handlers invoked directly. Rules that always apply: claim "unit tests pass" **only** for that surface — it does NOT cover live-DB behaviour end to end (DB-bound paths run against in-memory prisma stubs; raw-SQL aggregates are not exercised); source must use **erasable TS syntax only** (no constructor parameter properties); tests must never hit a real DB or the network; new tests colocate in `tests/*.test.mts` and import source with an explicit `.ts` extension. CI also runs a headless E2E route crawl ([scripts/e2e-crawl.mts](scripts/e2e-crawl.mts)) that gates hydration/runtime correctness (guardrail 16) only. The full coverage inventory, loader details and per-area pins are in [docs/testing.md](docs/testing.md).

## Directory map

- [src/app/(app)/](src/app/(app)/) — user-facing pages: home, movies, tv, upcoming, popular, top, votes, requests, issues, donate, profile, settings, plus an `admin/` subtree (activity, users, library, backup, audit-log, stats, issues).
- [src/app/api/](src/app/api/) — REST handlers grouped by domain: `sync/`, `webhooks/`, `auth/`, `admin/`, `requests/`, `issues/`, `votes/`, `ratings/`, `play-history/`, `profile/`, `search/`, `sessions/`, `push/`, `discord/`, `cron/`, `health/`.
- [src/lib/](src/lib/) — integrations and utilities: `plex.ts`, `jellyfin.ts`, `jellyfin-availability.ts`, `arr.ts`, `cron-auth.ts`, `play-history.ts`, `tmdb-types.ts`, `prisma.ts`.
- [src/components/](src/components/) — feature components; primitives under `ui/`. The admin nav is grouped (`ADMIN_NAV_GROUPS` / `NavItem.group` in [nav-items.ts](src/lib/nav-items.ts), rendered by [admin-nav-groups.tsx](src/components/layout/admin-nav-groups.tsx)); `adminNavItems` stays in group order with `/admin` first (the mobile Admin tab opens the first visible item). A page that needs ANY of several flags goes in `NAV_ITEM_ANY_FEATURE_KEYS` — the arr pages need Radarr or Sonarr — and its page must enforce the same gate (`tests/nav-groups.test.mts`).
- [prisma/schema.prisma](prisma/schema.prisma) — every model (User, Account, AuthSession, MediaRequest, Plex/JellyfinLibraryItem, Radarr/Sonarr{Wanted,Available}Item, TVEpisodeCache, TmdbCache, TmdbMediaCore, Issue, IssueMessage, IssueGrab, PlayHistory, ActiveSession, DeletionVote, PushSubscription, Setting, MediaServerUser, TitleSuggestion, RecommendationTitle, …).
- [src/generated/prisma/](src/generated/prisma/) — generated client output. **Never edit by hand.**
- There is **no** `middleware.ts` — Next 16 renamed it to `proxy.ts`. See [src/proxy.ts](src/proxy.ts): per request it runs the CSRF origin check on mutating `/api/*`, validates+refreshes the session via `verifyAndRefreshSession` (DB-checked, refusing a token on the wrong transport — guardrail 6h), gates non-public paths (login redirect + admin/issue-admin role checks; there is no UA-fingerprint check), and stamps the CSP nonce. There is no NextAuth `authorized()` callback — gating is inline in `proxy()`.

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

**"For You" recommendations** — [src/lib/recommendations.ts](src/lib/recommendations.ts) + [src/lib/recommendation-graph.ts](src/lib/recommendation-graph.ts) + [src/lib/recommendation-quality.ts](src/lib/recommendation-quality.ts)

Detail: [docs/architecture/for-you-recommendations.md](docs/architecture/for-you-recommendations.md).

**Request watch grades** — [src/lib/watch-grade.ts](src/lib/watch-grade.ts) (pure rules) + [src/lib/watch-grade-data.ts](src/lib/watch-grade-data.ts) (prisma)

Detail: [docs/architecture/request-watch-grades.md](docs/architecture/request-watch-grades.md).

**Library cleanup** — [src/lib/library-cleanup.ts](src/lib/library-cleanup.ts) (pure rules) + [library-cleanup-data.ts](src/lib/library-cleanup-data.ts) (prisma) + [library-cleanup-arr.ts](src/lib/library-cleanup-arr.ts) (Radarr/Sonarr listing + delete), page `/admin/cleanup` behind `feature.admin.cleanup` (default OFF), ADMIN-only.

Detail: [docs/architecture/library-cleanup.md](docs/architecture/library-cleanup.md).

**Never watched** — [never-watched.ts](src/lib/never-watched.ts) (pure verdict) + [never-watched-data.ts](src/lib/never-watched-data.ts) (evidence loader) + [never-watched-report.ts](src/lib/never-watched-report.ts) (report, cache, chip read) + [upstream-watch.ts](src/lib/upstream-watch.ts)/[upstream-watch-data.ts](src/lib/upstream-watch-data.ts) (the media servers' own watch records), page `/admin/never-watched` behind …

Detail: [docs/architecture/never-watched.md](docs/architecture/never-watched.md).

**Missing** — [src/lib/arr-missing.ts](src/lib/arr-missing.ts) (pure rules) + [arr-missing-data.ts](src/lib/arr-missing-data.ts) (live listings), page `/admin/missing`, ADMIN-only, Sonarr and Radarr tabs.

Detail: [docs/architecture/missing.md](docs/architecture/missing.md).

**Download Queue + Radarr/Sonarr health** — page `/admin/queue`, ADMIN-only. [arr-queue.ts](src/lib/arr-queue.ts) (pure) + [arr-queue-data.ts](src/lib/arr-queue-data.ts); [arr-health.ts](src/lib/arr-health.ts) (pure) + [arr-health-data.ts](src/lib/arr-health-data.ts).

Detail: [docs/architecture/download-queue-radarr-sonarr-health.md](docs/architecture/download-queue-radarr-sonarr-health.md).

**Radarr/Sonarr monitor** — [arr-watch.ts](src/lib/arr-watch.ts) (pure) + [arr-watch-data.ts](src/lib/arr-watch-data.ts), cron `/api/cron/arr-watch` (lock 2051, `ARR_WATCH_INTERVAL`), setting `arrWatchDiskLowPercent` (Settings → Notifications → Radarr/Sonarr alerts, `PATCH /api/admin/arr-watch`).

Detail: [docs/architecture/radarr-sonarr-monitor.md](docs/architecture/radarr-sonarr-monitor.md).

**Request "Pick release"** — `GET/POST /api/requests/[id]/releases` (MANAGE_REQUESTS): interactive search on an APPROVED/AVAILABLE request's own instance, the same projected `ArrRelease` list the Issue "Replace" panel uses.

Detail: [docs/architecture/request-pick-release.md](docs/architecture/request-pick-release.md).

**Request "Why?" status** — `GET /api/requests/[id]/arr-status` (MANAGE_REQUESTS), opened by the "Why?" button on APPROVED rows of the request queue ([request-arr-status.tsx](src/components/admin/request-arr-status.tsx), read on click only). One verdict plus details from the request's OWN instance (tmdbId, mediaType, arrInstance — guardrail 32;

Detail: [docs/architecture/request-why-status.md](docs/architecture/request-why-status.md).

**Issue "Replace file"** — `GET/POST /api/issues/[id]/files` (ADMIN — deleting files is ADMIN-only; ISSUE_ADMIN keeps Refetch and Replace-release), rules in [issue-replace.ts](src/lib/issue-replace.ts), panel in [issue-actions.tsx](src/components/admin/issue-actions.tsx).

Detail: [docs/architecture/issue-replace-file.md](docs/architecture/issue-replace-file.md).

**"Open in Radarr/Sonarr"** — every link goes through `GET /api/admin/arr/open` (ADMIN), which resolves the title on click ([arr-links-data.ts](src/lib/arr-links-data.ts)) and 302s to the instance's page for it (Add New for a title it doesn't have). The host is the per-instance `ExternalUrl` setting (the address a BROWSER uses; plaintext, never fetched by the server), else the connection `Url`. Links render for ADMIN only: queue/missing rows, the request queue, and the movie/TV detail pages (instances whose synced cache holds the title — no live call at render).

**Admin arr management** — everything an admin used to open Radarr/Sonarr for, ADMIN-only, read live — each page paints the last answer it got at once and then reloads live ("instant, then live", guardrail 5h). Shared plumbing: [arr-admin.ts](src/lib/arr-admin.ts) (`configuredArrCfg` — a slug is never turned into Setting reads unless the registry lists it, guardrail 32; `enabledArrInstances`;

Detail: [docs/architecture/admin-arr-management.md](docs/architecture/admin-arr-management.md).

**Library match check** — [library-match.ts](src/lib/library-match.ts) (pure rules) + [library-match-data.ts](src/lib/library-match-data.ts), the "Match check" section of Admin → Library (ADMIN; it renders on a one-server deployment too, unlike the Plex↔Jellyfin diff below it).

Detail: [docs/architecture/library-match-check.md](docs/architecture/library-match-check.md).

**Observability** — admin-only `GET /api/admin/debug/arr-state?tmdbId=<id>&type=movie|tv` dumps the whole pipeline: cache rows, `attachArrPending` result, live Radarr/Sonarr check, tvdb→tmdb mapping, total wanted-table counts, and the most recent `LIBRARY_SYNC` audit row. Use this before guessing when a badge is missing.

Detail: [docs/architecture/observability.md](docs/architecture/observability.md).

**Logging** — custom `console.error`/`console.warn` wrapper. Namespaced with `[scope]` prefixes. `console.log` success/progress messages were intentionally removed. Silent success is the convention.

**Errors** — API routes return `NextResponse.json({ error }, { status })`, no try/catch wrapper. Shared error classes: `SafeFetchError`, `ArrResponseError`, `BackupCryptoError`. React boundaries at [src/app/(app)/error.tsx](src/app/(app)/error.tsx) and [src/app/global-error.tsx](src/app/global-error.tsx).

## Environment

Required: `DATABASE_URL`, `NEXTAUTH_SECRET` (≥32 chars), `TOKEN_ENCRYPTION_KEY` (**exactly 64 hex chars / 32 bytes** — the AES-256-GCM key for all encrypted `Setting.value` / `Account` token fields; checked **first** at boot via `assertTokenEncryptionKey()` and `process.exit(1)` on failure in *every* environment, not just production), `AUTH_URL`, `CRON_SECRET` (≥32 chars), `TRUST_PROXY` (an internet-facing instance must sit behind a trusted reverse proxy with this set to exactly `"true"`; it is also the sole gate on reading `X-Forwarded-For`/`X-Real-IP`). **In production, a blank/non-`"true"` value means LOCAL-ONLY mode and now FAILS CLOSED** — the Host guard it relies on is client-supplied and spoofable, so boot is refused unless the operator explicitly sets `SUMMONARR_ALLOW_LOCAL_ONLY=true`; a *public* `AUTH_URL` is refused either way and the opt-in cannot unlock it. Development never fails. The whole rule set is one pure function, `evaluateLocalOnlyStartup` ([src/lib/local-only.ts](src/lib/local-only.ts)), called from [instrumentation.ts](src/instrumentation.ts) — put changes there, not inline in the boot sequence. This supersedes the former "NEVER exit on a blank `TRUST_PROXY`" rule: the default docker deployment still ships it blank, so `.env.example` and [docker-container/README.md](docker-container/README.md) ship the opt-in alongside it and the Upgrading section calls it out. `TMDB_READ_TOKEN` is functionally required (core browse/search) but is **warn-only** at boot — its absence logs a warning and the app still starts.
Optional: `NEXTAUTH_SECRET_PREVIOUS` (verify-only: the old `NEXTAUTH_SECRET` during a planned rotation, so sessions survive it — ≥32 chars, never another secret's value, and never set after a leak; native sessions it signed die when it is removed — guardrail 6h), `OIDC_{ISSUER,CLIENT_ID,CLIENT_SECRET,DISPLAY_NAME}`, `SUMMONARR_ALLOW_OAUTH_FIRST_ADMIN`, `SUMMONARR_DISABLE_MFA_ENFORCEMENT` (switches off the "require two-factor for administrators" redirect — guardrail 6d), `SUMMONARR_ALLOW_LOCAL_ONLY` (see `TRUST_PROXY` above — required to run local-only in production), `SUMMONARR_DEFAULT_LOCALE` (`en`|`es`|`fr`|`de`|`pt`|`it`|`zh`, default `en`; a region or script tag (`pt-BR`, `zh-Hans-CN`, POSIX `pt_BR.UTF-8`) is read on its primary subtag, the same rule `negotiateLocale` applies to Accept-Language, and a value naming no supported language falls back to `en` and is warned about ONCE at boot via `instanceDefaultLocaleWarning()` — the fallback UI language and the language of notifications to users with no stored `User.locale`; read per request, deliberately not a Setting — see [server-locale.ts](src/lib/i18n/server-locale.ts)), `BACKUP_DB_PASSWORD` (≥12 chars), `BASE_PATH`, `AUTH_TRUSTED_ORIGIN`, `TRUSTED_PROXY_HOPS` (default 1), `DELAYED_JOBS_MAX_{PENDING,QUEUE,CONCURRENCY}`, and the cron interval knobs (`SYNC_INTERVAL`, `UPCOMING_SYNC_INTERVAL`, `RATINGS_SYNC_INTERVAL`, `PLAY_HISTORY_SYNC_INTERVAL`, plus `LIST_CACHE_SYNC_INTERVAL`, `WARM_ACTIVITY_INTERVAL`, `WARM_MDBLIST_INTERVAL`, `WARM_OMDB_INTERVAL`, `WARM_RECOMMENDATIONS_INTERVAL`, `WARM_LIBRARY_INTERVAL`, `SCRUB_AUDIT_PII_INTERVAL`, `TRASH_SYNC_INTERVAL`, `PURGE_SESSIONS_INTERVAL`, `PLEX_WATCHLIST_SYNC_INTERVAL` — default 1800, the watchlist auto-request poll; a no-op while `feature.behavior.watchlistAutoRequest` is off, `TRAKT_SYNC_INTERVAL` — default 1800, per-user Trakt (guardrail 34c); a no-op until a Trakt client secret is saved and watchlist auto-request or For You is on, `UPSTREAM_WATCH_SYNC_INTERVAL` — default 86400, the media servers' own watch-record snapshot for the never-watched report (guardrail 14d); a no-op while both `feature.admin.neverWatched` and `feature.admin.cleanup` are off, `ARR_WATCH_INTERVAL` — default 900, the Radarr/Sonarr monitor (guardrail 7c); skipped before its lock while no Radarr/Sonarr instance is enabled and configured; its first tick is ~11 minutes after boot, `ARR_SNAPSHOT_INTERVAL` — default 300, the admin arr pages' background re-reads (guardrail 5h; each view on its page's 5/10/15-minute priority); skipped before its lock while nothing is due; first tick ~5 minutes after boot), `SSE_MAX_LISTENERS` (default 500; bounds **both** the emitter listener cap and the concurrent SSE connection cap in `/api/events` — intentionally one knob, see [src/lib/sse-emitter.ts](src/lib/sse-emitter.ts)).

Jellyfin is **not** an env var — its server URL + API key are stored as the `jellyfinUrl` / `jellyfinApiKey` Settings, configured in Admin → Settings → Media. Login (standard + QuickConnect), library sync, play-history, fix-match, and server-user admin all read the URL via `getConfiguredJellyfinUrl()` ([src/lib/jellyfin-config.ts](src/lib/jellyfin-config.ts)). There is no `JELLYFIN_URL` fallback.

## Deployment

Multi-stage Docker (`node:26.10.0-alpine3.23`, five stages: deps → prisma-gen → builder → migrate-deps → runner) → standalone Next build, non-root `nextjs` user (UID 1001). Postgres 17-alpine sidecar with `postgres-data` volume. Internal port 3000 → host 3001. The image creates `/data` (app) and `/app/.next/cache` dirs, but neither compose file mounts them as volumes — only `postgres-data` is persisted. There are **no** external `sync-cron` / `upcoming-cron` compose services: the app container runs its **own internal cron loop** (`docker-entrypoint.sh` `_cron_loop` + `_play_history_loop`), POSTing to `http://localhost:3000/api/...` with `Bearer ${CRON_SECRET}` so the secret never leaves the container. **Image-size discipline**: the migrate-deps stage prunes the Prisma CLI's dependency tree via [scripts/prune-migrate-deps.mjs](scripts/prune-migrate-deps.mjs) (~250 MB → ~66 MB — studio/dev tooling, mysql2/postgres drivers, typescript, react, etc. are never loaded by `db push`), then a build-time smoke test runs a real `db push` against an unreachable DB and requires the P1001 error — proving the pruned module graph still loads — before the tree ships. **That smoke test runs unconditionally, and it must stay that way — do NOT re-add a cross-build skip.** It was briefly gated on `TARGETPLATFORM == BUILDPLATFORM` because under QEMU the pruned CLI's wasm get-config returns corrupted bytes and reports every line of a valid schema as unparseable, which blocked the v0.25.0 release twice. That was an emulator fault, not an arch or schema one — proven by `--platform linux/arm64 --target migrate-deps` passing on a native arm64 host while the emulated CI build failed identically. **The skip is unnecessary because nothing cross-builds any more**: [docker-publish.yml](.github/workflows/docker-publish.yml) builds each platform on its own native runner (`ubuntu-latest` for amd64, `ubuntu-24.04-arm` for arm64, stitched by `docker buildx imagetools create`), and the security gate + ci.yml's docker build are amd64 on amd64 hosts. Native arm64 went from a **cancelled 3h0m22s** emulated build — GitHub's hard job ceiling, so no `timeout-minutes` could have saved it — to **~3 min**. If you ever reintroduce an emulated leg you will hit the wasm bug again; add a native runner, not a skip. The native `schema-engine-*` binary in `@prisma/engines` MUST stay: `db push` executes it and silently re-downloads it at boot when missing (a boot-time internet dependency; the bundled wasm schema engine is NOT used). The builder stage also strips the glibc sharp/libvips variants (`@img/sharp-*linux-*`) from the standalone output — the Alpine runtime is musl-only, and `outputFileTracingExcludes` does not actually drop them (tested; hence the explicit `rm`).

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
2. **Never remove the `?token=` webhook query param.** Sonarr and Radarr webhook UIs have no header field, and both handlers share the same code path. (There are no Plex/Jellyfin webhook handlers — only `radarr` and `sonarr`.) Keep the timing-safe compare. Do not "upgrade" to HMAC — the upstream services do not sign requests.
2a. **The webhook token NEVER leaves the server during one-click setup — not in a response, not in an audit row, not in an error the arr echoes back.** `setupArrWebhook` ([arr-health-data.ts](src/lib/arr-health-data.ts)) builds the `?token=` URL itself and writes it straight into Radarr/Sonarr.

    Why:
    - The arr test-POSTs the URL before saving, and its HTTP error text quotes the request URL — token included. Relayed verbatim, the refusal shown to the admin (and logged) would carry the secret.
    - The health report is polled by the browser; a URL in it would put the secret in the RSC/devtools surface the copy-on-click design (`/api/settings/webhook-urls`) exists to avoid.

    Rules:
    - Refusal text goes through `arrValidationMessage`, which masks `token=`. The health GET returns only the verdict (`ok`/`missing`/`tokenMismatch`/`eventsMissing`). The `SETTINGS_CHANGE` audit records the BASE address, never the URL.
    - An instance with no secret gets one generated, create-if-absent (`setting.createMany` + `skipDuplicates`, encrypted by the Prisma extension — guardrail 7a), so two setups racing end on ONE secret instead of the second stranding the first hook's token. The generation is audited the moment it commits, even if the arr then refuses the hook. The default instance reuses the legacy shared `webhookSecret` when it has no own secret, exactly as the handlers resolve it.
    - An existing Connect entry pointing at `/api/webhooks/<service>` is updated IN PLACE (PUT), keeping the admin's name, tags and extra events; only the URL and Summonarr's handled events (`WEBHOOK_EVENTS`) are set — never a second entry.
3. **Schema-first Prisma.** No migrations directory exists. Schema changes are applied with `prisma db push`, then `prisma generate`. Do not scaffold `prisma migrate` workflows.
4. **Bulk writes must use `batchCreateMany` + `BATCH_TX_TIMEOUT`.** Raw `createMany` on library-sized datasets blows transaction timeouts. Always chunk via `batchCreateMany` and pass `{ timeout: BATCH_TX_TIMEOUT }` to `$transaction`.
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

    Rule index (every rule, with its reasoning, is in the detail file):
    - Facts read from the arrs' own source (2026-10-11) — don't "fix" them back:
5f. **An issue's Replace file deletes ONLY files the instance reports inside the issue's scope, re-read at POST time, and it blocklists with ONE Mark failed per DOWNLOAD.**

    Detail and rationale: [docs/guardrails/5f.md](docs/guardrails/5f.md).

    Rule index (every rule, with its reasoning, is in the detail file):
    - "Unmonitor deleted episodes/movies" is undone, exactly.
5g. **Delegate-facing Radarr/Sonarr status is COARSE: phase, progress, time left, the attention flag, quality names, counts and dates — NEVER an output path, download id, download client or indexer name, release title or arr URL.** `GET /api/requests/[id]/arr-status` is read by MANAGE_REQUESTS delegates, not only admins.

    Why:
    - A queue record carries the output path, download id, client and indexer; a history grab carries the apikey'd download URL (5e); the arr's own status messages quote the output path ("No files found are eligible for import in /downloads/…") and file names.

    Rules:
    - Project through `projectDownload` / `scrubMessage` only: credentials masked by `safeMessage`, the item's own private values removed whole, then URLs, absolute paths and media file names; a line that is only a file name is dropped.
    - Every queue and history record must name the title's arr id (strict `movieId`/`seriesId ===`), so an arr that ignored the query's filter can't leak another title.
    - The verdict never carries a private completeness or release rule: `sonarrSeriesCompletion` (14a) and `missingMovie` are the only ones.
    - `tests/request-arr-status.test.mts` pins it with a planted-value leak scan (37 mutations, each fails a named test).
5h. **An admin arr page paints its last answer at once and then reads live — and a snapshot is DISPLAY ONLY: nothing that writes ever reads one.** Server: [arr-snapshot.ts](src/lib/arr-snapshot.ts) (`withAdmin(snapshotted(…))` on each admin Radarr/Sonarr READ route); client: [use-arr-snapshot.ts](src/components/admin/use-arr-snapshot.ts) + [arr-snapshot-note.tsx](src/components/admin/arr-snapshot-note.tsx).

    Detail and rationale: [docs/guardrails/5h.md](docs/guardrails/5h.md).

    Rule index (every rule, with its reasoning, is in the detail file):
    - NEVER wrap a read whose answer must not be replayed: release searches (handles are single-use and bound to one search — release-handles.ts), `/api/admin/arr/commands`, rename previews, the Why? status, or anything a non-ADMIN can read.
    - NEVER let a write path read a snapshot, and never base a form's edits on one once a live read has landed (the title manager's Settings form rebases on the live read exactly as on a background re-read).
    - Kept fresh in the background, by priority.
6. **Route all cron/sync handlers through `isCronAuthorized` (or its actor-returning form `getCronActor`).** Do not re-implement `CRON_SECRET` checks inline. `getCronActor` ([cron-auth.ts](src/lib/cron-auth.ts)) is the SAME chokepoint — `isCronAuthorized` is just `getCronActor(...) !== null` — and returns who is driving the run (`{ trigger: "admin", userId, userName }` or `CRON_SYSTEM_ACTOR`) so a route needing audit attribution reads the session ONCE instead of gating with `isCronAuthorized` and then re-reading it. `scripts/audit-routes.mts` accepts either name as the cron guard.
6a. **User-session API routes must wrap their handlers with `withAuth`/`withAdmin`/`withIssueAdmin` from [src/lib/api-auth.ts](src/lib/api-auth.ts).** The wrapper runs the auth check before the handler body and returns 401/403 itself, so the guard can never be forgotten or mis-returned (the failure mode that the older inline `requireAuth(...) + if (session instanceof NextResponse) return session;` pattern allowed). Do not re-implement `auth() + isTokenExpired() + role` boilerplate inline. Callsite:

    Detail and rationale: [docs/guardrails/6a.md](docs/guardrails/6a.md).
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
    - Protected buckets live in their own process-wide map. When it is full of live buckets, a NEW account's attempt is refused (fail closed); a live bucket is never evicted to make room.
    - Never add a cheap, attacker-mintable key (per-IP, per-secret, per-pin) to the list, or a flood fills the protected map instead.
    - `mfa-user:` is charged for CODE methods only (TOTP, recovery). Passkey attempts are bounded by the per-IP limit and the per-token failure cap.
    - `tests/rate-limit.test.mts` pins each call site's literal prefix to the list, so a renamed key fails it.
6f. **The admin "Connect Plex" PIN is created AND polled under a per-attempt random client identifier that lives only in the signed HttpOnly connect cookie, bound to the admin who started it. NEVER the shared `PLEX_CLIENT_ID`, and never a pin id taken from the request.** [plex-flow-state.ts](src/lib/plex-flow-state.ts) (`signPlexConnectCookie`), [/api/auth/plex/pin](src/app/api/auth/plex/pin/route.ts).

    Why:
    - plex.tv hands a PIN's authToken to whoever presents the pin id and the client identifier that created it, with no code and no secret. `summonarr-server` is identical in every install and public in the source, and the old poll took any `?id=`, so anyone could poll recent pin ids and collect an admin's Plex OWNER token.

    Rules:
    - `POST` creates the PIN and sets the cookie. `PATCH` polls the cookie's pin and stores the token server-side through `savePlexAdminToken` ([plex-admin-connect.ts](src/lib/plex-admin-connect.ts)). The owner token never reaches the browser.
    - The cookie is signed with an HKDF subkey of `NEXTAUTH_SECRET` with its own `typ` and audience, never the raw session key.
    - `tests/auth-signin-routes.test.mts` pins each leg from the attacker's side.
6g. **A password change or "sign out everywhere" must leave a session hijacker NOTHING that outlives the sessions. Anything a session can plant that would survive (a linked Discord account, a Trakt connection) needs a step-up to plant, and every step-up password draws on ONE audited per-account budget.** [step-up-auth.ts](src/lib/step-up-auth.ts), [session-footholds.ts](src/lib/session-footholds.ts), [account-security-notify.ts](src/lib/account-security-notify.ts).

    Why:
    - A password change and sign-out-everywhere ended the sessions but left push registrations, pending Discord link and merge codes and (sign-out-everywhere) the calendar feed URL. Linking Discord and connecting Trakt needed only a session, so a hijacker could link THEIR accounts and keep approving, requesting and receiving pushes as the owner after the owner's compromise response.
    - Every step-up route had its own password bucket and never audited a miss, so a stolen session could test passwords at ~11 a minute across them.
    - Restoring a backup brought back every session revoked since it was taken, and native tokens never expire (6c).

    Rules:
    - Password change and revoke-all (both modes) delete PushSubscription, DiscordLinkToken and DiscordMergeCode rows in the SAME transaction (`footholdDeletes` / `clearSessionFootholdsInTx`) and clear the calendar token. Then they email the owner, listing what is still connected. A redeemed Discord link and a Trakt connection are NOT removed; listing them is the defence. The web bell re-sends its browser subscription once per page load and the iOS app re-registers after sign-in, so the owner's own devices come back.
    - Every step-up password goes through `verifyStepUpPassword`: the protected `step-up-pw:` bucket (6e), a refund on success, `AUTH_LOGIN_FAILED` `reason: "step_up_password"` on a miss. `tests/step-up-auth.test.mts` scans `src` for any other `verifyPassword(` caller (sign-in in auth.ts excepted).
    - `requireStepUp` (password, or an SSO sign-in younger than 5 minutes) guards `generate-link`, the Trakt device start, and `initiate-merge` for WEB sessions. A native session is exempt there because the shipped app has no prompt (guardrail 25). "Native" is `isNativeSession`, the session's never-expiring deadline fixed at sign-in, NEVER the transport: a stolen browser cookie replayed as a bearer token is still a web session.
    - Every completed Discord link (`mergeDiscordIntoWebAccount`, the one chokepoint for `/link` and confirm-merge) is audited and mailed to the owner after the commit.
    - A DB restore deletes every AuthSession row and stamps every user's `sessionsRevokedAt` inside the restore transaction (backup-import.ts).
    - Boot refuses NEXTAUTH_SECRET, CRON_SECRET and TOKEN_ENCRYPTION_KEY sharing a value (`secretReuseError`, [boot-secrets.ts](src/lib/boot-secrets.ts)).
    - A user's quota counts what they requested AND what they filed on others' behalf (`MediaRequest.filedBy`, `quotaUsageWhere` in [quota.ts](src/lib/quota.ts)). Every quota counter uses it; `tests/quota.test.mts` fails on an inline one.
    - The CLI reset (`scripts/reset-password.mjs`) mirrors the in-app change: 12-character minimum, both cutoffs, AuthSession rows, calendar token, footholds, and `--admin` sets permissions with the role.
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
    - `NEXTAUTH_SECRET_PREVIOUS` is verify-only and forces the slow path, so browsers re-sign onto the new key at once. Native tokens are never re-issued: removing the previous secret signs out every iOS session it signed. After a LEAK, rotate WITHOUT it.
    - The legacy raw-key session path stays for native tokens minted before this change, accepted only in its legacy shape (no kid, typ "JWT", no audience, no transport claim) and never as the current key. Short-lived flow and request tokens switched with no fallback.
    - Nothing compares the `uaFingerprint` claim with the request; it is informational. A response that appends a refreshed session cookie is `private, no-store` (`markSessionResponseUncacheable`).
    - `tests/session-transport.test.mts` and `tests/signing-keys.test.mts` pin it, with the reader wiring in each reader's own suite.
6i. **A password hash records its own cost (`scrypt:2:<ln>:<r>:<p>:<salt>:<key>`, written at OWASP's N=2^17, r=8, p=1), every verify does the work of a current one, and every scrypt call goes through the process-wide hash slot. On an account with two-factor, a password CHANGE also needs a fresh second factor.** [password-hash.ts](src/lib/password-hash.ts), `authorizeWithCredentials` in [auth.ts](src/lib/auth.ts), [profile/password](src/app/api/profile/password/route.ts), [account-security-notify.ts](src/lib/account-security-notify.ts).

    Why:
    - `scrypt:1` stored no parameters, so its 2^15 cost could never be raised without breaking every stored hash.
    - Raising the cost made a legacy hash 4× cheaper to verify than the unknown-account dummy, so response time alone would have told which emails have an account.
    - scrypt runs on libuv's 4-thread pool, shared with file reads, `dns.lookup` and zlib, and each 2^17 derivation takes 128 MiB. An unbounded burst of sign-ins stalls unrelated requests and can OOM a small container.
    - A session from a phishing relay of the password plus ONE code could set a password the owner doesn't know. The password alone is exactly what the relay holds.
    - An exhausted per-account sign-in bucket also refuses the owner, with nothing to tell them why.

    Rules:
    - `verifyPassword` reads the parameters FROM the hash (bounded on read: 2^14–2^20, r ≤ 16, p ≤ 4, ≤ 256 MiB) and still accepts legacy `scrypt:1` at 2^15/8/1. A verify against a cheaper hash runs padding derivations at the stored parameters, so its work equals one at `SCRYPT_PARAMS`; `dummyVerify` uses `SCRYPT_PARAMS`. `tests/password-hash.test.mts` pins equal work with `scryptWorkDone()`.
    - `authorizeWithCredentials` rehashes (`needsRehash`) after a successful verify. The rehash is AWAITED, because the 2FA challenge's `pwv` fingerprints the stored hash and a later rehash would kill the challenge. It is a CAS on the verified hash and touches neither `passwordChangedAt` nor sessions.
    - At most `MAX_CONCURRENT_HASHES` (2) derivations run at once: `withHashSlot`, a `processSingleton` (27a), FIFO, unbounded queue (refusing a verify would turn a flood into a lockout of real users). Never call `scrypt` outside it.
    - The standalone CLI copies (`scripts/reset-password.mjs`, `create-user.mjs`, `e2e-seed.mts`) keep their hashing between the `>>> password-hash` / `<<< password-hash` markers. The test runs each block and checks its output with the app's `verifyPassword` and `needsRehash`.
    - `PATCH /api/profile/password` on an account with an active factor needs `secondFactor` through `mfaSecondFactorStepUp`, checked AFTER the password verified so a wrong password never burns a code. Same body and `400 { error, secondFactorRequired, methods }` as enrollment (6d). There is NO native exemption: the native kind is chosen by whoever signs in, so a relay would just send `X-Summonarr-Client`. Without 2FA the route is byte-identical.
    - The shipped iOS app's ChangePasswordView sends no `secondFactor`. For a 2FA account it gets the 400 and shows `error`, which tells the user to change the password on the website. `API_VERSION` is not bumped: the signal is reactive, as in 6d. The iOS fix is to show its existing StepUpSheet on `secondFactorRequired`.
    - A full `login-email:` bucket mails the owner (`sign-in-locked`) ONCE per window per account: `claimSignInLockoutNotice` (synchronous, process-wide) then `void notifySignInLockout`. It fires from the failed verify that spends the last guess, where the row is already loaded, NEVER from a refusal, so a refused attempt still reads nothing from the DB (`tests/auth.test.mts`). Live local-password accounts only. The caller's response and timing are unchanged.
7. **No success logs.** `console.error` and `console.warn` only, namespaced with a `[scope]` prefix. Silent success is the convention. Do not add `console.log` for happy-path events.
7a. **NEVER call `encryptToken` at the call site for `Setting.value`, `Account.{access_token,refresh_token,id_token}` or `UserTotp.secret`.** The Prisma extension in [src/lib/prisma.ts](src/lib/prisma.ts) handles encryption on every write to those fields and decryption on every read. Pre-encrypting at the route, sign-in/OIDC, or library layer produces double-encrypted rows of the form `enc:v1:<enc:v1:…>` — on read the extension decrypts once and hands callers the inner ciphertext, which then gets sent as an API key/token to upstream services and fails auth. This bug shipped in `bc81802` (a route-level pre-encryption in `/api/settings` and an `encryptingAdapter` wrapper in `auth.ts`); both were removed afterward. The remaining legitimate `encryptToken` callers are: `PushSubscription` writes ([push/subscribe](src/app/api/push/subscribe/route.ts) and [push/apns](src/app/api/push/apns/route.ts) — the latter encrypts the APNs `deviceToken`; the extension does not cover that table) and the one-shot migration scripts under [scripts/](scripts/). Do not add a third. `UserTotp.secret` (guardrail 6d) is covered by the extension — and unlike `Setting.value` every write of that column is sensitive, so its `updateMany`/`createMany` are ENCRYPTED rather than refused; never read it through a nested `include: { totp: … }` from a user query (that bypasses the `userTotp` hooks — `tests/mfa-prisma-extension.test.mts` scans for it).
7b. **A warning that restates an UNCHANGED condition on every pass goes through `warnOnChange` ([log-dedup.ts](src/lib/log-dedup.ts)). Rate questions are answered by the cron run history — NEVER by counting log lines.**

    Detail and rationale: [docs/guardrails/7b.md](docs/guardrails/7b.md).

    Rule index (every rule, with its reasoning, is in the detail file):
    - NEVER emit "(repeated N times)"
    - NEVER repeat-suppress an EVENT.
    - The history read is best-effort and MUST stay swallowed — several suites stub `prisma.setting` with `upsert` alone, and an observability read must never turn a cron route into a 500.
7c. **The Radarr/Sonarr monitor announces a disk on a CHANGE of state only, and each failed or newly stuck download exactly ONCE — state written BEFORE the events.**

    Detail and rationale: [docs/guardrails/7c.md](docs/guardrails/7c.md).
8. **Minimal tests; dual-compiler typecheck.** A small `node:test` suite exists (`npm test`) covering pure leaf modules only — do not fabricate coverage beyond what [tests/](tests/) actually exercises, and do not claim broader test coverage than that. For verification run `npm run lint`, `npm run typecheck` AND `npm run typecheck:classic` (native TS 7 + the classic TS 6 that `next build` uses — see Commands), and `npm test`, and say what you ran.
9. **Keep state management minimal.** Don't introduce Zustand/Jotai/Redux/TanStack Query to "clean up" components. URL search params + `useState` is the house style.
10. **Keep data fetching to REST + server components.** Don't introduce tRPC, server actions, or GraphQL without discussion. Client components use `fetch('/api/…')`; server components call Prisma directly.
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
14b. **A title an admin deleted through Library cleanup must NEVER be demoted and re-pushed. The demote's CAS carries `cleanedUpAt: null`, and nothing takes a TITLE off Radarr/Sonarr except the confirmed cleanup route and the title manager's confirmed Remove — both stamp before deleting.** (File deletes — the title manager's Files tab, an issue's Replace file — leave the title on the instance, so the arr's own search, not a re-push, is what follows them.)

    Detail and rationale: [docs/guardrails/14b.md](docs/guardrails/14b.md).

    Rule index (every rule, with its reasoning, is in the detail file):
    - Only a DEFINITE refusal removes a stamp.
14c. **NEVER list notification channels at a "now available" call site — every claimed winner goes through `fanOutAvailableWinners` ([request-notifications.ts](src/lib/request-notifications.ts)) — the sync/webhook claimers AND the admin's manual "mark available" in `dispatchRequestStatusChange` — and it is the ONLY `request.available` emit (the hub itself emits only `request.approved`/`request.declined`). Outbound channels (webhook / ntfy / Gotify, `NotificationAgent` rows) are reached ONLY through `emitNotificationEvent(s)` ([notify-agents.ts](src/lib/notify-agents.ts)), which never throws and never blocks the caller.**

    Detail and rationale: [docs/guardrails/14c.md](docs/guardrails/14c.md).
14d. **"Never watched" has ONE definition — the verdict in [never-watched.ts](src/lib/never-watched.ts), fed by the evidence loader in [never-watched-data.ts](src/lib/never-watched-data.ts). The report, the cleanup `neverWatched`/`unwatched` rules, the delete route's re-judgement and the detail-page chip all go through it; a private `playCount === 0` anywhere is a second definition, and the two drift.**

    Detail and rationale: [docs/guardrails/14d.md](docs/guardrails/14d.md).

    Rule index (every rule, with its reasoning, is in the detail file):
    - Evidence is a union and is NEVER filtered
    - A title is judged only when EVERY server holding it is recorded and has history
    - The narrowed read (`only`) must reach the full read's verdict.
    - Upstream evidence is READ-ONLY
    - Seasons are reported only for shows that HAVE been watched
    - "Eligible" on the report is exactly the delete dry run's selection
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
    - Errors are swallowed by design: the next sync re-resolves the `tmdbId`, so a failed backfill is self-healing.

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
    - The live poller's finalize (`sourceSessionId = ${sessionKey}:${startedAt}`, via [recordCompletedSession](src/lib/play-history.ts)) captures every Jellyfin watch while the app is up, with full metadata (codec/transcode/resolution/bitrate/device/IP/markers).
    - The old `sync-jellyfin-history` cron (PlaybackReporting `jf-pr:` + IsPlayed `jf-hist:` imports) was removed — it only ever added pre-install and downtime history, which the project decided it no longer needs. With it gone, all Jellyfin rows share the live namespace, so the `@@unique([source, sourceSessionId])` constraint + `createMany({skipDuplicates})` in `recordCompletedSession` is the whole dedup story — no cross-namespace `liveCovers` guard is needed anymore.

    Rules:
    - **NEVER** make the live poller skip Jellyfin finalize — it's the only writer now; skipping it loses the watch entirely.
    - If you ever re-introduce a Jellyfin backfill that writes a different `sourceSessionId` namespace, you MUST re-add a cross-path guard (the deleted route used a `±10min` `(mediaServerUserId, sourceItemId)` window) so the same watch can't land twice and inflate play counts/watch hours on admin/activity.
    - The `getJellyfinSessions` lib helper feeds the live poller — don't confuse it with the removed `getJellyfinPlaybackReporting`/`getJellyfinUserPlayHistory`/`getJellyfinItemRuntimes` backfill helpers (also deleted).
    - "The poller" is now a loop over every configured Jellyfin server (guardrail 35) and `PlayHistory.serverInstance` records which one a watch came from — so "sole writer" means the poller *as a whole*, not one connection. Don't assume a single Jellyfin anywhere on this path.
19a. **NEVER reconcile a `bitrate` column by MAGNITUDE. Normalize on `source` via [bitrate.ts](src/lib/bitrate.ts).**

    Detail and rationale: [docs/guardrails/19a.md](docs/guardrails/19a.md).
19b. **NEVER store a play-history aggregate that was computed across a `clearActivityCache()`. Every memoized aggregate in [play-history.ts](src/lib/play-history.ts) goes through `memoizeActivity` (or reads `activityGeneration()` before computing and passes it to `setCached`).**

    Why:
    - Every session finalize clears the activity cache. The Statistics fan-out takes seconds on the five-connection pool, so one that began before a finalize finished after the clear and re-cached the pre-finalize numbers for the full TTL — the invalidation silently undone.
    - Concurrent cold loads (two admins, the iOS app, the warm cron) each ran the whole ~35-statement fan-out.

    Rules:
    - `clearActivityCache()` bumps `activityCacheGeneration`; `setCached` drops a write whose generation is stale. `memoizeActivity` also coalesces per (generation, key), so a load after a clear never joins a computation from before it.
    - `tests/activity-stats.test.mts` pins both, mutation-verified (guard dropped, no bump, no coalescing).
19c. **NEVER let a stored transcode reason claim a cause the server didn't report.** Vocabulary and translations live in [transcode-reasons.ts](src/lib/transcode-reasons.ts).

    Why:
    - Plex's `/status/sessions` says WHICH stream it transcoded, never why. The capture labelled every video transcode "Video codec not supported" — remote quality step-downs included — and the Statistics page turned the top label into advice ("addressing it would meaningfully cut server transcode load").
    - Jellyfin's fallback for a transcode with no `TranscodeReasons` was "Container not supported", equally invented.

    Rules:
    - Plex writes `Video transcoded` / `Audio transcoded` / `Subtitle burn-in`; a missing reason is `No reason reported`. Rows written before that are rewritten on read by `TRANSCODE_REASON_SQL` — Plex rows ONLY (on a Jellyfin row the same words are Jellyfin's own reason). Every surface that groups by reason uses that expression.
    - The UI translates each comma-joined phrase through the literal `TRANSCODE_REASON_KEYS` map. `tests/jellyfin.test.mts` feeds Jellyfin's whole TranscodeReason enum through the humanizer and fails on a phrase with no key.
19d. **NEVER show the Statistics/Activity previous-period delta unless the previous window was fully RECORDED.** `prevPeriod.complete` in `getPlayHistoryStats` ([play-history.ts](src/lib/play-history.ts)) is the same coverage question as guardrail 14d's window.

    Why:
    - A previous window that tracking only partly covered reads as a drop in plays that never happened — and one source's old rows say nothing about a server tracked only since last week.

    Rules:
    - Every relevant tracking stamp — the global switch, plus the filtered source's (or both with no source filter) — must be ≤ the previous window's start. No stamp keeps the old behaviour (installs from before the stamps existed).
    - With no source filter, every source with plays since the probe bound must also have one before it, so one source's old rows never vouch for a source tracked only recently.
    - Retention shorter than 2× the window cuts into the previous one, so it is incomplete. When retention ≥ 2× the window, a row within a day of the purge cutoff counts as evidence, because the purge erases the older rows that would prove it.
    - `tests/activity-stats.test.mts` pins it.
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
23a. **NEVER interpolate an SQL fragment into a TAGGED `$queryRaw`/`$executeRaw`. Build the query with `Prisma.sql` and pass it as ONE value: `prisma.$queryRaw(Prisma.sql\`…${fragment}…\`)`.**

    Why:
    - Inside the Next bundle, the client's tagged-template path did not recognise a `Prisma.sql`/`Prisma.empty` fragment imported from `@/generated/prisma` as SQL, and bound it as a parameter. Postgres answered `syntax error at or near "$1"` and `/admin/stats` 500'd on every query that carried an optional `AND createdAt >= …` clause.
    - The unit loader shares one module instance, so the identical call passed every unit test **and** a direct run against a real Postgres. Only a live `next dev` render showed it. The `Prisma.sql(...)` builder composes fragments itself, so the form above is immune; every other raw query in `src/` already used it.

    Rules:
    - A fragment is anything from `Prisma.sql` / `Prisma.empty` / `Prisma.join` / `Prisma.raw`, or a variable or helper that produces one (`sinceClause(since)`, `statusCond`). Plain values — a `Date`, a number, `String(now)` — are what a tagged template is for, and stay as they are.
    - `tests/raw-sql-composition.test.mts` scans `src/` for the tagged shape (a fragment named directly, or an identifier/call declared in the same file from one). It is mutation-verified against reverting one `admin-stats-data.ts` query. A fragment produced in ANOTHER file and interpolated here is invisible to it — so the rule, not the scan, is the boundary.
    - A test stub of `$queryRaw` must accept both call shapes (a template-strings array, or a single `{ sql, values }` object) — see `tests/admin-stats.test.mts`.
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
27a. **Every in-memory auth ledger is process-wide (`processSingleton`), NEVER a module-level `Set`/`Map`.**

    Why:
    - Turbopack copies a lib module into every server chunk that imports it ([process-singleton.ts](src/lib/process-singleton.ts)). `session-revocation.ts`'s force-revalidate Sets were plain module state: the revoke routes marked in THEIR chunk, while the proxy and every page render read their own copies, which nothing ever wrote. So "revocation takes effect on the next request" held for `withAuth` API routes only, and a revoked session kept rendering pages for the whole dbCheckedAt window (10s admin / 60s user).

    Rules:
    - Any state that means "remember across the whole server" goes through `processSingleton`: revocation marks, rate-limit buckets, the MFA token ledger.
    - A single-module unit test can't see the bug. Pin it with a cache-busted second import (`?chunk=…`), the unit-test analogue of a second chunk, as `tests/session-revocation.test.mts` does.
28. **NEVER hard-delete a `MediaServerUser`. Soft-delete (`active = false`) instead.**

    Detail and rationale: [docs/guardrails/28.md](docs/guardrails/28.md).

    Rule index (every rule, with its reasoning, is in the detail file):
    - De-registering a media-server instance is NOT a licence to hard-delete its rows.
29. **Page/layout authorization is DB-checked (`authActive()` / `readActiveSummonarrSession()`), NEVER the proxy alone and NEVER JWT-only `auth()`.**

    Detail and rationale: [docs/guardrails/29.md](docs/guardrails/29.md).

    Rule index (every rule, with its reasoning, is in the detail file):
    - The redirect MUST stay before/outside the layout's `try/catch` or the `NEXT_REDIRECT` throw gets swallowed.
    - A page/layout that makes a **role-based** redirect (`role !== "ADMIN"`, etc.) MUST read the session with `authActive()` (drop-in for `auth()`, identical `SummonarrSession` shape) or `readActiveSummonarrSession()` (the [admin layout](src/app/(app)/admin/layout.tsx) pattern) — never JWT-only `auth()`.
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
31a. **A limit only bounds work the task AWAITS, and `after()` has no limit at all. NEVER pass a stale-while-revalidate getter to `mapLimit`, and a cron calling `attachRatingsUnified` ALWAYS passes `deferToAfter: false`.**

    Why:
    - `getOmdbRatingsForTmdb` returns a stale row immediately and DETACHES its refresh. `mapLimit(staleRows, 6, getter)` therefore capped six cache reads at a time while every upstream refresh started together.
    - Next runs a request's `after()` callbacks through a p-queue with no concurrency limit, all at once when the response closes. The recommendation verdict pass calls `attachRatingsUnified` once per 200 titles, so up to 50 calls' worth of deferred refreshes ran together after the cron responded. Observed live: hundreds of `[omdb] TMDB external_ids fetch failed (429)` lines right after `[warm-recommendations ok]`.

    Rules:
    - A task handed to `mapLimit`/`settleLimit` must await all of its upstream work. For a list refresh use `revalidateOmdbForTmdb` ([omdb.ts](src/lib/omdb.ts)), the getter with its refresh awaited, or write the awaited twin of whatever getter you need.
    - `deferToAfter: false` runs the deferred refresh before `attachRatingsUnified` returns. It is for callers with no response to protect and many calls to make; pages keep the default so the viewer isn't held waiting.
    - The OMDB fallback never fetches a title that already has an OMDB row (`lacksOmdbRow`). The getter would only hand that row back, plus a detached refresh; the stale-OMDB pass refreshes it instead.
    - `tests/ratings-refresh.test.mts` pins every route with in-flight counts and `tests/recommendations.test.mts` pins the verdict pass's option; all twelve mutations fail a named test.
32. **A Radarr/Sonarr instance is identified by an `arrInstance` slug string, NEVER the old `is4k` boolean.** The two-instance (HD/4K) model was generalized to N named instances (e.g. an "anime" instance).

    Detail and rationale: [docs/guardrails/32.md](docs/guardrails/32.md).

    Rule index (every rule, with its reasoning, is in the detail file):
    - The migration is NON-DESTRUCTIVE.
    - Instance→Setting-key derivation is centralized in [arr-instances.ts](src/lib/arr-instances.ts)
    - `arr.ts` client fns take `variant: ArrVariant = ""` — an instance slug.
    - Per-instance secret Setting keys (`radarr<Slug>ApiKey`/`WebhookSecret`) must stay encrypted.
    - Access to a NAMED instance is a per-user grant
    - Instance-aware surfaces (landed post-v0.15.0):
    - Still default/HD+4K-scoped by design (not gaps):
33. **Account removal DISABLES; it never scrubs. The irreversible scrub is a separate, admin-only, two-step action.** [account-lifecycle.ts](src/lib/account-lifecycle.ts) is the only module that implements either half.

    Detail and rationale: [docs/guardrails/33.md](docs/guardrails/33.md).

    Rule index (every rule, with its reasoning, is in the detail file):
    - `deactivateUserInTx` writes EXACTLY two things
    - `purgeUserDataInTx` (POST `/api/admin/users/[id]/purge`) is the only place that scrubs
    - Identity survives, so SIGN-IN must be refused explicitly.
    - Notifications are suppressed at two chokepoints, not per channel.
    - NEVER test for a purged row with a bare `purgedAt != null`
    - Callers MUST short-circuit an already-disabled row before calling `deactivateUserInTx` — re-running it on a disabled ADMIN sees its own row excluded from the count and throws `LastAdminError` spuriously.
34. **`MediaServerUser → User` attribution resolves on the provider SUBJECT id first, email second — and NEVER overwrites a manual pin.** This binding is what makes play history belong to somebody: both `getMyWatchHistory` and every admin per-user view resolve through `MediaServerUser.userId`.

    Detail and rationale: [docs/guardrails/34.md](docs/guardrails/34.md).

    Rule index (every rule, with its reasoning, is in the detail file):
    - Neither resolver may filter on `deactivatedAt`
    - `manualUserLink = true` means an admin set the binding by hand — automatic resolution must skip the row entirely.
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
34d. **A MANAGE_USERS delegate (no ADMIN bit) may re-link ordinary members' media-server identities, but NEVER to themselves, and NEVER an identity owned by an admin, going to an admin (role or bit), or belonging to the media server's own admin. A delegate also may not create a local account under a media-server user's email.** [server-users/[id]](src/app/api/admin/server-users/[id]/route.ts), [admin/users POST](src/app/api/admin/users/route.ts).

    Why:
    - Linking an identity is what makes its watch history readable by its new owner (`/api/play-history/mine*`). A delegate could point the server owner's identity at their own account and read everything they watched, while the owner's own history went blank.
    - `resolveMediaServerUser` falls back to an EMAIL match for an identity with no provider-bound account (34). A delegate creating `friend@…` with a password of their choosing got that friend's identity bound to it on the next poll.

    Rules:
    - The admin check re-reads the identity AND both owners inside the write's transaction, under advisory lock 42 (the role-change lock).
    - An ADMIN keeps the unrestricted escape hatch, which is why the route exists.
    - `tests/admin-routes.test.mts` and `tests/admin-users-audit-routes.test.mts` pin it.
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
37a. **A fix-match runs as a BACKGROUND JOB with a polled status — never as a request the browser waits on.** `POST /api/admin/fix-match` with `async: true` answers 202 + `jobId` at once and the client polls `GET /api/admin/fix-match/status?id=`; the registry is [fix-match-jobs.ts](src/lib/fix-match-jobs.ts), the client half is [client/fix-match.ts](src/lib/client/fix-match.ts).

    Why:
    - A Jellyfin series identify keeps refreshing every season and episode for minutes after `RemoteSearch/Apply` returns, and the route (rightly) waits to confirm. A reverse proxy keeps one request open for ~60s (nginx, NPM) to 100s (Cloudflare), so the browser got a **502 while the remap succeeded** — the operator saw "failed", retried, and queued yet another full refresh on an already-busy server.
    - The in-process job outlives the request the same way guardrail 17's backfill does (single long-lived Node server). The status route 404s after a restart and the client tells the operator to re-sync instead of retrying.

    Rules:
    - The synchronous default (no `async`) is a **wire contract the iOS app pins** — keep it byte-identical; gate a native switch on the reported `apiVersion` (guardrail 25), never by changing the default.
    - The same key (server + instance + mediaType + from→to) already running ⇒ the same job is returned, never a second remap of one title.
    - A job's `error` is the client-safe message only — the route still logs the real detail before throwing `FixMatchError`.
    - Jobs past `MAX_RUNNING_JOBS` QUEUE (status `queued`, `queueAhead` on the status route; a bounded queue 429s past `MAX_QUEUED_JOBS`) — they are not refused. A queued job is never a stall.
    - The client gives up on a RUNNING job only when its progress signature stops changing (`STALL_LIMIT_MS`), never on a fixed wall-clock window: copies run serially and a multi-copy series legitimately outlasts any fixed number. Every runner therefore reports each attempt, phase and copy (`copy`/`copies`) through `report`.
    - A Plex title remaps EVERY copy in `plexRatingKeys` (the twin of the Jellyfin loop), touching a rider key only when Plex says it still carries the old id; copies that fail stay on the old row. Both servers carry the removed row's descriptive columns to the corrected row and UNION item keys into an existing target row (`fix-match-rows.ts`) — a remap never replaces keys or drops `addedAt`.
    - The job tray (`GET /api/admin/fix-match/jobs`, `FixMatchTray`) is coarse: title, server, status, outcome — never a ratingKey, path or token.
37b. **Exactly one TMDB id may keep a `PlexLibraryItem` row per conflated Plex ratingKey, and WHICH one must resolve the same way on every run.** The Plex twin of 37's `prefersCandidate`. One definition — [plex-dedupe.ts](src/lib/plex-dedupe.ts) — called by BOTH writers, the orchestrator's Plex arm and the admin Resync route.

    Detail and rationale: [docs/guardrails/37b.md](docs/guardrails/37b.md).

    Rule index (every rule, with its reasoning, is in the detail file):
    - Look the prior mapping up BY RATING KEY
    - Honour a pin only when its tmdbId is in the batch.
    - Every remaining choice is a total order over the candidates, never arrival order.
    - One definition, not two agreeing copies.
37c. **A Plex title's EVERY ratingKey on a server lives in `PlexLibraryItem.plexRatingKeys`, and every ratingKey read ORs it against `plexRatingKey`.** The Plex twin of 37 (`jellyfinItemIds`).

    Detail and rationale: [docs/guardrails/37c.md](docs/guardrails/37c.md).

    Rule index (every rule, with its reasoning, is in the detail file):
    - Written by both Plex writers (orchestrator arm, `/api/sync/plex`) from `plexLibraryRatingKeys(data)` — canonical key first, then `duplicateRatingKeys` collected across sections, within a section, and from legacy-agent resolution (`withDuplicateRatingKeys`, which NEVER mutates: one entry object is …
    - `plexRatingKeys` is NEVER made exclusive on write.
    - A key held by several rows resolves through `pickPlexRowForKey` / `indexPlexRowsByKey` ([plex-dedupe.ts](src/lib/plex-dedupe.ts)) — the canonical holder, else the lowest tmdbId (37b's total order); the ONLY place one owner is picked — NEVER a `findFirst` without an order, and never last-write-wins …
37d. **ALWAYS send `CollapseBoxSetItems=false` (`JELLYFIN_NO_COLLECTION_GROUPING`, [jellyfin.ts](src/lib/jellyfin.ts)) on every Jellyfin `/Items` query that can list a Movie or a Series.**

    Why:
    - Summonarr calls Jellyfin with an API key, and an API key has no user. For a user-less query Jellyfin replaces every member of a collection with its BoxSet. The server's "group movies/shows into collections" settings are only read when there IS a user, so turning them off does nothing for us. `ExcludeItemTypes=BoxSet` doesn't help either, because the grouping runs after the type filter. Neither does `MinDateLastSaved` or `SearchTerm`. Only an explicit `false` always wins (`Folder.CollapseBoxSetItems` / `AllowBoxSetCollapsing` in Jellyfin's source).
    - Seen live on Jellyfin 12.2 (2026-10-13): the library sync was missing 2,230 of 9,134 movies, every one of them in a TMDB collection. Each read as "Plex only", and requests for them never saw Jellyfin. Practical Magic 2 arrived, Jellyfin created the Practical Magic Collection, and the 1998 film disappeared with it. A user token sees everything, so a check made while signed in to Jellyfin looks fine. Reproduce with an API key.

    Rules:
    - The sync, the availability probe, the never-watched played-items read and fix-match's confirmation search all send it. A query limited to `Episode` can't be grouped and is exempt.
    - The library sync never turns a BoxSet into a title. A listing that still returns one logs once through `warnOnChange` (7b): it means the server ignored the flag and titles are missing.
    - `tests/jellyfin.test.mts` stubs the grouping (members appear only when the flag is sent) and scans `src` for `/Items?` literals that can list a Movie or Series without it. Every site is mutation-verified.
37e. **A library match check Fix rematches ONE item (fix-match's `itemKey` mode), and the route believes only the stored flag.**

    Why:
    - The tmdbId mode remaps EVERY copy holding the old id (37). A title often holds a correct copy beside the wrong one ("Ghost in the Shell (2017)" matched to the 1995 film's id beside the real 1995 film), and "fixing" the id would rematch the correct copy too.
    - An unmatched item has no id and no library row, so the tmdbId mode can't name it at all.

    Rules:
    - `itemKey` only NAMES an item the last stored check flagged on that server and instance (`findMatchFlag`). The current id, media type and path come from the flag, never the body. An item the check didn't flag is a 404, and a malformed key is a 400, with nothing sent.
    - The DB phase moves only that key (`moveItemToTitleInTx`). The item leaves every other title's row on its server: a row left with no copy is deleted, and a row whose canonical copy it was falls back to its next copy. It joins the corrected title's row. Plays move by THIS item's key, never filtered by the old id (an unmatched item's plays carry none): a movie by `sourceItemId`, an episode by `sourceShowId`. The episode cache is left to the next full sync, which has no item key to move one copy's episodes. The flag leaves the stored report in the same transaction.
    - Item jobs are keyed by the item (`fixMatchJobKey`), so two unmatched items fixed to one title are two jobs. The tmdbId mode and its wire contract are unchanged.
    - `tests/fix-match-routes.test.mts`, `tests/library-match.test.mts` and `tests/library-match-data.test.mts` pin it. 20 of 21 mutations fail a named test; the survivor removes a redundant abort check.
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

    Detail and rationale: [docs/guardrails/39.md](docs/guardrails/39.md).

    Rule index (every rule, with its reasoning, is in the detail file):
    - Order is load-bearing
    - Constrain the value shape when the prefix is an ordinary word.
    - An arbitrary value's GROUP is decided by its value shape, exactly as Tailwind types it — through the shared fragments at the top of [tw-merge.ts](src/lib/tw-merge.ts) (`LEN`, `WIDTH_ARB`, …
    - Utilities that COMPOSE get one group EACH, never a shared one.
    - A group whose NAME can equal a real class is a trap.
    - Legitimate same-family collapses are allowlisted with a reason
40. **"For You" per-title data is SERVER-WIDE, and it is the ONLY source. The engine makes no upstream call at all — the SCHEDULING is what makes that safe.**

    Detail and rationale: [docs/guardrails/40.md](docs/guardrails/40.md).

    Rule index (every rule, with its reasoning, is in the detail file):
    - The order is the guarantee: SELECT, then BUILD, then COMPUTE.
    - A seed cap IS a build-budget knob — changing one changes what the build must cover.
    - The required set is built WITHOUT the per-run cap.
    - `conclusive` is derived from SEED COVERAGE, not from whether anything came back.
    - A graph refresh that THROWS aborts the run.
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

41. **A `withAdvisoryLock` callback that can run for minutes MUST observe its AbortSignal.**

    Detail and rationale: [docs/guardrails/41.md](docs/guardrails/41.md).

    Rule index (every rule, with its reasoning, is in the detail file):
    - RETURN, never throw, on abort.
    - The sync orchestrator is the same rule with a worse consequence, and its check goes at ARM boundaries ONLY.
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
