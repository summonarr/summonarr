@AGENTS.md

# Summonarr

Self-hosted media request aggregator. Users browse TMDB (trending / popular / discover / upcoming), request movies and TV, vote, and file issues. Admins approve requests and auto-fulfill via Radarr/Sonarr. The app ingests Plex and Jellyfin libraries + play history so users see availability, active sessions, and watch activity in one place. There is no public README — this file is the canonical project brief.

## Stack

- **Next.js 16.2.9** (App Router). AGENTS.md is not a suggestion — **read [node_modules/next/dist/docs/](node_modules/next/dist/docs/) before touching framework code**.
- **TypeScript** strict, path alias `@/*` → `./src/*`
- **Prisma 7.8** + **PostgreSQL 17**, schema-first. No `prisma/migrations/` directory — changes are applied via `prisma db push`.
- **Custom session auth** — a `jose`-signed (HS256) session JWT, not NextAuth (the project migrated off it; there is no `next-auth` dependency and no `auth.config.ts`). Session lifecycle lives in [src/lib/session-jwt.ts](src/lib/session-jwt.ts) (sign/verify), [src/lib/session-refresh.ts](src/lib/session-refresh.ts) (`verifyAndRefreshSession`: DB revocation, `sessionsRevokedAt`/`passwordChangedAt` cutoffs, role rotation, sliding window), [src/lib/session-cookie.ts](src/lib/session-cookie.ts), and [src/lib/auth.ts](src/lib/auth.ts) (`auth()` — JWT-only read). A custom `AuthSession` table backs per-device tracking + revocation. Providers: local credentials, Plex OAuth, Jellyfin (standard + QuickConnect), OIDC (`openid-client`).
- **Tailwind v4** — **no `tailwind.config.js`**. Theme lives inline in [src/app/globals.css](src/app/globals.css) under `@theme inline` with oklch variables and `.dark` class-based dark mode.
- **UI**: [src/components/ui/](src/components/ui/) — `@base-ui/react` (Radix-style) primitives scaffolded via the `shadcn` CLI, composed with the in-repo `@/lib/cva` and `@/lib/tw-merge` reimplementations (the `class-variance-authority` and `tailwind-merge` npm packages are **not** installed — these are hand-written equivalents).
- **Client state**: plain `useState` + URL `searchParams`. No Zustand, Jotai, Redux, or TanStack Query.
- **Data fetching**: REST API routes + `fetch` on the client, or server components calling Prisma directly. No tRPC. No server actions.
- **Package manager**: npm (see `package-lock.json`). No `packageManager` field, no `.nvmrc`.

## Commands

```bash
npm run dev         # next dev
npm run build       # next build
npm run start       # next start (production)
npm run lint        # eslint
npm run audit:deps  # custom TypeScript dep audit
```

There is **no** `typecheck` script — run `npx tsc --noEmit` when you need it. There is **no** unit test suite (no vitest/jest, no `*.test.ts`) — do not claim "unit tests pass." CI does run a headless E2E route crawl ([.github/workflows/e2e.yml](.github/workflows/e2e.yml) → [scripts/e2e-crawl.mts](scripts/e2e-crawl.mts)): it builds the app against a throwaway Postgres, seeds an admin via [scripts/e2e-seed.mts](scripts/e2e-seed.mts), signs in, and fails on any uncaught client error (React #418 hydration mismatches in particular — guardrail 16). It cannot run locally without the full stack; it has no Plex/Jellyfin/ARR/TMDB backends, so it gates hydration/runtime correctness only, not data-dependent behaviour.

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
- Runs the download-policy sync + Plex + Jellyfin library fetch+write *concurrently* via `Promise.allSettled`. The Radarr and Sonarr wanted/available refreshes run earlier and are **sequential to each other** (HD+4K fetches parallelize *within* each); there is no separate TMDB "job" here beyond an expired-`TmdbCache` purge near the end.
- One shared `stillPending` snapshot is reused across both sources' marking passes. The "now available" notification fire-exactly-once guarantee is an atomic claim (`claimAvailableNotificationWinners`, an `UPDATE … RETURNING` compare-and-swap on `notifiedAvailable`) — not a plain update — so an item appearing in both libraries in the same run notifies once.
- Parallel Plex+Jellyfin sync, shared `stillPending` snapshot, `recentOnly` for Jellyfin, and batch tx timeouts landed together (the original commit hash cited here, `3dcbd79`, is not reachable in the current squashed history — see the audit note).

**Sync modes**
- **Full sync** — atomic `deleteMany` + repopulate inside one `$transaction`. The orchestrator `/api/sync` route does **not** read the body — it always does a full library replace. The `{ "full": true }` body flag is parsed only by the per-source routes `/api/sync/plex` and `/api/sync/jellyfin` (the admin "Resync" button), where `recentOnly = rawBody.full !== true`.
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
- `safeFetchTrusted(url, { allowedHosts })` — required hostname allowlist; skips DNS-based SSRF. For fixed third-party APIs (TMDB, plex.tv, discord.com, ipinfo.io, api.trakt.tv, api.github.com, raw.githubusercontent.com, www.omdbapi.com, api.mdblist.com, api.resend.com).
- `safeFetchAdminConfigured(url)` — runs SSRF policy with `allowPrivate=true` (RFC1918/ULA/loopback OK; link-local + 0.0.0.0 still blocked). For URLs persisted in `Setting` (Radarr/Sonarr/Jellyfin/Plex server).

**Webhook auth** — [src/app/api/webhooks/](src/app/api/webhooks/) (**sonarr, radarr only**)
- There is **no Plex or Jellyfin webhook handler** — those routes were removed. Plex real-time activity comes from the SSE stream ([src/lib/plex-events.ts](src/lib/plex-events.ts)); Jellyfin activity from the 5s play-history poller. Only `radarr/route.ts` and `sonarr/route.ts` exist.
- SHA-256 + `timingSafeEqual` against the stored webhook secret (`radarrWebhookSecret` / `sonarrWebhookSecret` + 4K variants, with a legacy shared `webhookSecret` fallback).
- Accepts either `Authorization: Bearer …` **or** a `?token=…` query param. The query-string fallback is load-bearing — see guardrails.
- No HMAC signature validation; none of these services send one.

**Play history** — [src/lib/play-history.ts](src/lib/play-history.ts)
- `recordCompletedSession()` ingests when an `ActiveSession` completes and writes a `PlayHistory` row with full playback metrics (duration, pause, codec, resolution, bitrate, device, IP, etc).
- `getActivityCalendarUncached()` (~line 1892) backs the GitHub-style 365-day heatmap in [src/components/admin/activity-calendar.tsx](src/components/admin/activity-calendar.tsx). A `$1` placeholder offset bug in its filtered-query path was fixed — the dynamic SQL builder starts parameters at `$1`, not `$2`.

**Observability** — admin-only `GET /api/admin/debug/arr-state?tmdbId=<id>&type=movie|tv` dumps the whole pipeline: cache rows, `attachArrPending` result, live Radarr/Sonarr check, tvdb→tmdb mapping, total wanted-table counts, and the most recent `LIBRARY_SYNC` audit row. Use this before guessing when a badge is missing.

**Logging** — custom `console.error`/`console.warn` wrapper. Namespaced with `[scope]` prefixes. `console.log` success/progress messages were intentionally removed. Silent success is the convention.

**Errors** — API routes return `NextResponse.json({ error }, { status })`, no try/catch wrapper. Shared error classes: `SafeFetchError`, `ArrResponseError`, `BackupCryptoError`. React boundaries at [src/app/(app)/error.tsx](src/app/(app)/error.tsx) and [src/app/global-error.tsx](src/app/global-error.tsx).

## Environment

Required: `DATABASE_URL`, `NEXTAUTH_SECRET` (≥32 chars), `TOKEN_ENCRYPTION_KEY` (**exactly 64 hex chars / 32 bytes** — the AES-256-GCM key for all encrypted `Setting.value` / `Account` token fields; checked **first** at boot via `assertTokenEncryptionKey()` and `process.exit(1)` on failure in *every* environment, not just production), `AUTH_URL`, `CRON_SECRET` (≥32 chars), `TRUST_PROXY` (production refuses to boot only when `AUTH_URL` is a *public* host and this isn't `true` — an internet-facing instance must sit behind a trusted reverse proxy; a LAN/loopback `AUTH_URL` boots in local-only mode with the spoofable Host guard. NEVER unconditionally exit on a blank value — the default docker deployment ships it blank. See [instrumentation.ts](src/instrumentation.ts)). `TMDB_READ_TOKEN` is functionally required (core browse/search) but is **warn-only** at boot — its absence logs a warning and the app still starts.
Optional: `OIDC_{ISSUER,CLIENT_ID,CLIENT_SECRET,DISPLAY_NAME}`, `SUMMONARR_ALLOW_OAUTH_FIRST_ADMIN`, `BACKUP_DB_PASSWORD` (≥12 chars), `BASE_PATH`, `AUTH_TRUSTED_ORIGIN`, `TRUSTED_PROXY_HOPS` (default 1), `DELAYED_JOBS_MAX_{PENDING,QUEUE,CONCURRENCY}`, and the cron interval knobs (`SYNC_INTERVAL`, `UPCOMING_SYNC_INTERVAL`, `RATINGS_SYNC_INTERVAL`, `PLAY_HISTORY_SYNC_INTERVAL`, plus `LIST_CACHE_SYNC_INTERVAL`, `WARM_ACTIVITY_INTERVAL`, `WARM_MDBLIST_INTERVAL`, `WARM_OMDB_INTERVAL`, `SCRUB_AUDIT_PII_INTERVAL`, `TRASH_SYNC_INTERVAL`, `PURGE_SESSIONS_INTERVAL`), `SSE_MAX_LISTENERS` (default 500; bounds **both** the emitter listener cap and the concurrent SSE connection cap in `/api/events` — intentionally one knob, see [src/lib/sse-emitter.ts](src/lib/sse-emitter.ts)).

Jellyfin is **not** an env var — its server URL + API key are stored as the `jellyfinUrl` / `jellyfinApiKey` Settings, configured in Admin → Settings → Media. Login (standard + QuickConnect), library sync, play-history, fix-match, and server-user admin all read the URL via `getConfiguredJellyfinUrl()` ([src/lib/jellyfin-config.ts](src/lib/jellyfin-config.ts)). There is no `JELLYFIN_URL` fallback.

## Deployment

Multi-stage Docker (`node:26.3.0-alpine3.23`, five stages: deps → prisma-gen → builder → migrate-deps → runner) → standalone Next build, non-root `nextjs` user (UID 1001). Postgres 17-alpine sidecar with `postgres-data` volume. Internal port 3000 → host 3001. The image creates `/data` (app) and `/app/.next/cache` dirs, but neither compose file mounts them as volumes — only `postgres-data` is persisted. There are **no** external `sync-cron` / `upcoming-cron` compose services: the app container runs its **own internal cron loop** (`docker-entrypoint.sh` `_cron_loop` + `_play_history_loop`), POSTing to `http://localhost:3000/api/...` with `Bearer ${CRON_SECRET}` so the secret never leaves the container.

## Releasing — PR-then-tag flow

The project version is duplicated across four files. Drift is the default unless every bump touches all of them in the same commit. The Docker image tag (`v<X.Y.Z>`) is what users actually pull, so the README examples must agree with the package version or `SUMMONARR_VERSION=v<X.Y.Z>` will point at an image that doesn't exist.

The release flow is **PR-then-tag**: bump versions on `build`, PR to `main`, merge, *then* tag the merge commit on `main`. Tagging before the merge orphans the tag on a feature-branch commit unreachable from `main` — `git describe` breaks, `:v<X.Y.Z>` and `:main` reference different SHAs, and the [docker-publish workflow](.github/workflows/docker-publish.yml) builds the same release twice from two different commits. (`v0.9.1` and `v0.9.2` were tagged this way; both are orphan tags. Don't repeat it.)

### Step 1 — Bump versions on `build`

`<X.Y.Z>` is bare semver; the docker tag form is `v<X.Y.Z>`. Edit all five locations in one commit:

1. [package.json](package.json) — `"version": "<X.Y.Z>"` (root field).
2. [package-lock.json](package-lock.json) — `"version": "<X.Y.Z>"` in **two** places only: the top-level field and `packages.""` (lockfile v3 keeps both; `npm install` will rewrite either if they disagree). **Do not** global-find-replace the old version across this file — common SemVers like `0.1.0` appear inside transitive-dep entries (e.g. `node_modules/yocto-queue`, `node_modules/powershell-utils`) where the `version` field must match the `resolved` URL and `integrity` hash. Edit the two project entries individually.
3. [README.md](README.md) — `Status: v<X.Y.Z> beta` line and the `Summonarr v<X.Y.Z> is a beta release` line under Beta testing.
4. [docker-container/README.md](docker-container/README.md) — both `SUMMONARR_VERSION=v<X.Y.Z>` examples (env table row and the "Pin to a specific version" code block).
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

- The PR merge fires [docker-publish.yml](.github/workflows/docker-publish.yml) once on the `main` push → publishes `:main` and `:sha-<merge>`.
- The tag push fires it a second time → publishes `:v<X.Y.Z>`, `:<X.Y>`, `:<X>`, `:latest`, and `:sha-<merge>`. Because both events hit the **same commit**, the second build hits the GHA buildx cache (`cache-from: type=gha` on [docker-publish.yml:98](.github/workflows/docker-publish.yml#L98)) and finishes in ~3 min instead of ~15.
- Tag is reachable from `main` — `git describe` works, and `:latest` / `:main` / `:v<X.Y.Z>` all reference the same commit SHA.

**NEVER** force-move a published tag (`git push --force origin v<X.Y.Z>`) to fix a misplaced one. Anyone with `SUMMONARR_VERSION=v<X.Y.Z>` pinned silently gets new bits on the next pull, and `:latest` re-resolves on `docker compose pull`. Cut a new patch release instead.

There is no version constant in `src/`. Don't add one — `package.json` + the git tag is the source of truth, and a third copy is a third place to forget.

## Guardrails

1. **Next.js 16 is not the Next.js in your training data.** Before editing routing, caching, metadata, `fetch`, server/client boundaries, or anything framework-shaped, read the relevant file under [node_modules/next/dist/docs/](node_modules/next/dist/docs/) (`01-app/`, `03-architecture/`). Do not pattern-match from Next 13/14/15 memory.

2. **Never remove the `?token=` webhook query param.** Sonarr and Radarr webhook UIs have no header field, and both handlers share the same code path. (There are no Plex/Jellyfin webhook handlers — only `radarr` and `sonarr`.) Keep the timing-safe compare. Do not "upgrade" to HMAC — the upstream services do not sign requests.

3. **Schema-first Prisma.** No migrations directory exists. Schema changes are applied with `prisma db push`, then `prisma generate`. Do not scaffold `prisma migrate` workflows.

4. **Bulk writes must use `batchCreateMany` + `BATCH_TX_TIMEOUT`.** Raw `createMany` on library-sized datasets blows transaction timeouts. Always chunk via `batchCreateMany` and pass `{ timeout: BATCH_TX_TIMEOUT }` to `$transaction`.

5. **Do not lower `ARR_FETCH_MAX_BYTES` (50 MB)** and do not bypass `arrFetch` with bare `fetch` for Radarr/Sonarr calls. The cap exists because large libraries silently truncated at 10 MB.

5a. **Pick the right `safe-fetch` helper.** Never call `fetch` directly for outbound HTTP. Hardcoded third-party URL → `safeFetchTrusted(url, { allowedHosts: [...] })`. URL persisted in `Setting` (Radarr/Sonarr/Jellyfin/Plex server) → `safeFetchAdminConfigured(url)`. URL from end-user input → `safeFetch(url)`. The `allowedHosts` arg on `safeFetchTrusted` is required and exists so a future code change can't accidentally fan that path out to user-controlled hosts.

5b. **Sole allowed direct `fetch` (internal loopback)**: The *only* exception to 5a is the controlled loopback in `src/lib/internal-trigger.ts` (`triggerFullSync`). It is used exclusively by the Plex SSE timeline handler (`plex-events.ts`) to drive a full orchestrator run (`/api/sync`) so that the advisory lock (2000), `withCronRunRecording`, `isCronAuthorized`, and `LIBRARY_SYNC` audit path are identical to an external cron. Target is always `http://127.0.0.1:${PORT}/api/sync` authenticated with `CRON_SECRET`. Update this note (and the helper) if you ever need another internal trigger. All other server HTTP must go through the safe-fetch helpers.

6. **Route all cron/sync handlers through `isCronAuthorized`.** Do not re-implement `CRON_SECRET` checks inline.

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
    - **No sliding refresh for bearer clients** — they can't read `Set-Cookie`, so they ride the original fixed-lifetime token to expiry, then re-authenticate. Don't append `Set-Cookie` on a bearer request (guarded by `!bearerToken` / `!result.fromBearer`). A real refresh-token grant is deferred (Phase 3). Native clients should send `rememberMe: "true"` and a `User-Agent` containing `iPhone`/`iPad` so they get the long mobile/`maxDuration` TTL and a correct device label.

7. **No success logs.** `console.error` and `console.warn` only, namespaced with a `[scope]` prefix. Silent success is the convention. Do not add `console.log` for happy-path events.

7a. **NEVER call `encryptToken` at the call site for `Setting.value` or `Account.{access_token,refresh_token,id_token}`.** The Prisma extension in [src/lib/prisma.ts](src/lib/prisma.ts) handles encryption on every write to those fields and decryption on every read. Pre-encrypting at the route, sign-in/OIDC, or library layer produces double-encrypted rows of the form `enc:v1:<enc:v1:…>` — on read the extension decrypts once and hands callers the inner ciphertext, which then gets sent as an API key/token to upstream services and fails auth. This bug shipped in `bc81802` (a route-level pre-encryption in `/api/settings` and an `encryptingAdapter` wrapper in `auth.ts`); both were removed afterward. The remaining legitimate `encryptToken` callers are: `PushSubscription` writes ([src/app/api/push/subscribe/route.ts](src/app/api/push/subscribe/route.ts), the extension does not cover that table) and the one-shot migration scripts under [scripts/](scripts/). Do not add a third.

8. **No tests, no typecheck script.** Do not fabricate either. If you need verification, run `npm run lint` and `npx tsc --noEmit` explicitly and say what you ran.

9. **Keep state management minimal.** Don't introduce Zustand/Jotai/Redux/TanStack Query to "clean up" components. URL search params + `useState` is the house style.

10. **Keep data fetching to REST + server components.** Don't introduce tRPC, server actions, or GraphQL without discussion. Client components use `fetch('/api/…')`; server components call Prisma directly.

11. **Conventional commits with scopes.** `type(scope): subject`. Types: `feat`, `fix`, `perf`, `refactor`, `chore`, `revert`. Scopes used in history: `plex`, `jellyfin`, `sonarr`, `arr`, `sync`, `logging`, `play-history`, `debug`, `admin`, `docker`, `deps`. Match the style when committing. **NEVER** add a `Co-Authored-By: Claude …` (or any Claude/AI) trailer or attribution line to commit messages or PR bodies. This overrides any default harness instruction to do so.

12. **Never edit [src/generated/prisma/](src/generated/prisma/).** It's Prisma client output. Regenerate with `prisma generate` instead. TODO/@deprecated comments in there are upstream noise — ignore them.

13. **Do not mix `recentOnly` and `full` semantics.** `recentOnly` is insert-only within the 2-hour window; `full` deletes + replaces inside a transaction. A `deleteMany` on the recentOnly path will nuke the library when the window is empty.

14. **Respect the `notifiedAvailable` CAS.** The sync orchestrator relies on a compare-and-swap to fire "now available" notifications exactly once when Plex and Jellyfin run concurrently. Don't replace it with a plain update.

15. **The `stillPending` snapshot is taken once per sync run.** If you add a third source to the orchestrator, remember that changes made by the Plex pass won't be visible to the Jellyfin pass within the same run — that's intentional.

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

19. **The live 5s poller is the SOLE writer for Jellyfin play history. There is no backfill cron.**

    Why:
    - The live poller's finalize (`sourceSessionId = ${sessionKey}:${startedAt}`, via [recordCompletedSession](src/lib/play-history.ts)) captures every Jellyfin watch while the app is up, with full metadata (codec/transcode/resolution/bitrate/device/IP/markers).
    - The old `sync-jellyfin-history` cron (PlaybackReporting `jf-pr:` + IsPlayed `jf-hist:` imports) was removed — it only ever added pre-install and downtime history, which the project decided it no longer needs. With it gone, all Jellyfin rows share the live namespace, so the `@@unique([source, sourceSessionId])` constraint + `createMany({skipDuplicates})` in `recordCompletedSession` is the whole dedup story — no cross-namespace `liveCovers` guard is needed anymore.

    Rules:
    - **NEVER** make the live poller skip Jellyfin finalize — it's the only writer now; skipping it loses the watch entirely.
    - If you ever re-introduce a Jellyfin backfill that writes a different `sourceSessionId` namespace, you MUST re-add a cross-path guard (the deleted route used a `±10min` `(mediaServerUserId, sourceItemId)` window) so the same watch can't land twice and inflate play counts/watch hours on admin/activity.
    - The `getJellyfinSessions` lib helper feeds the live poller — don't confuse it with the removed `getJellyfinPlaybackReporting`/`getJellyfinUserPlayHistory`/`getJellyfinItemRuntimes` backfill helpers (also deleted).

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
    - Active-management surfaces (server-users admin list/page, the diagnose count) filter `active: true`; history/stats surfaces (the play-history user filter, the activity/stats aggregates) intentionally do NOT — a departed user's history stays visible and attributed.

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
    - Admin/settings/sync routes (ADMIN/CRON-auth + the 50 MB backstop) are lower-priority but should adopt the helper when next touched — they still read uncapped today.

## Working principles

Guardrails above are *what the code should look like*. These are *how to approach changes* — process rules adapted from a sibling project. They matter disproportionately in this codebase because Summonarr is an API-juggling aggregator: five upstream services (Plex, Jellyfin, Radarr, Sonarr, TMDB), multiple cache tables mirroring them, and a sync orchestrator that mutates shared state from several paths.

### Writing future rules in this file

1. **Absolute directives** — lead with `ALWAYS` or `NEVER`.
2. **Why first** — one to three bullets on the failure mode before the fix.
3. **Concrete commands or code** — no abstractions where a shell command will do.
4. **One point per block** — don't bundle unrelated examples.
5. **Bullets over paragraphs.**

Use ❌/✅ examples only when the antipattern is subtle. Do not add "warning signs" sections to obvious rules.

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
2. `npx tsc --noEmit` passes (there's no npm script for this — run it directly).
3. For UI/frontend changes, verify the feature in a browser against `npm run dev`, including the golden path and at least one edge case. If you can't test in a browser, say so explicitly — do not claim success.
4. For sync/webhook/cron changes, check `/api/admin/debug/arr-state` or the `LIBRARY_SYNC` audit row to confirm the pipeline ran end-to-end.
5. If a new convention emerged, update this file (guardrails or principles) in the same change.
6. No stray `console.log` success messages (guardrail 7).

There is no test suite. Do not claim "tests pass."
