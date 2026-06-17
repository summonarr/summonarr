# Summonarr

Self-hosted media request aggregator. Browse TMDB (trending, popular, discover, upcoming), request movies and TV, vote on requests, and file issues. Admins approve requests and auto-fulfill via Radarr/Sonarr. Summonarr ingests Plex and Jellyfin libraries plus play history, so users see availability, active sessions, and watch activity in one place.

> **Status:** v0.13.2 beta — feature-complete for the initial release. **Beta testers wanted** — see [Beta testing](#beta-testing).

## Install

**The supported install path is Docker Compose from [`docker-container/`](./docker-container/).** It pulls the pre-built image from GHCR — no build step required.

👉 **[Deployment guide: `docker-container/README.md`](./docker-container/README.md)** (env vars, reverse proxy, webhooks, backups, upgrading, troubleshooting).

Quick taste:

```bash
git clone https://github.com/summonarr/summonarr.git
cd summonarr/docker-container
cp .env.example .env
${EDITOR:-vi} .env
docker compose up -d
```

Then open <http://localhost:3001>. The first user to register is auto-promoted to `ADMIN`.

## Features

- TMDB-powered browse: trending, popular, discover, upcoming
- Movie and TV requests with voting and issue tracking
- Admin approval with automatic fulfillment through Radarr and Sonarr
- Plex and Jellyfin library + play-history ingestion (including active sessions)
- GitHub-style 365-day activity heatmap and per-user stats
- Local, Plex OAuth, Jellyfin (standard + QuickConnect), and OIDC sign-in
- Per-device session tracking, Web Push notifications, optional SMTP email
- AES-256-GCM encryption at rest for provider secrets and push/OAuth tokens
- Encrypted, password-protected database backups (export/import via the admin UI)
- Webhook support for Plex, Jellyfin, Sonarr, and Radarr
- Admin debug endpoint (`/api/admin/debug/arr-state`) for inspecting the Radarr/Sonarr pipeline end-to-end

## Architecture at a glance

The compose stack runs two containers:

| Service     | Image                                | Role                                                                                  | Port (host → container) |
| ----------- | ------------------------------------ | ------------------------------------------------------------------------------------- | ----------------------- |
| `summonarr` | `ghcr.io/summonarr/summonarr:latest` | Next.js app **plus** an internal cron loop that drives sync jobs (no sidecar needed). | `3001 → 3000`           |
| `postgres`  | `postgres:17-alpine`                 | Primary database. Persisted to the `postgres-data` named volume.                      | not exposed to host     |

Everything Summonarr needs at runtime — schema sync (`prisma db push`), library sync, TMDB refresh, play-history polling, cache warmers, audit-PII scrubbing — runs inside the `summonarr` container.

```
                   ┌───────────────────────┐
      browser ───▶ │   Reverse proxy       │ ───▶ summonarr:3000
                   │  (optional, TLS)      │       │
                   └───────────────────────┘       │
                                                   ▼
                                             postgres:5432
                                                   │
                                                   ▼
                                         postgres-data  (named volume)
```

## Building the image yourself

The root [`docker-compose.yml`](./docker-compose.yml) builds from source using the local `Dockerfile` and reads `.env.local` (not `.env`):

```bash
git clone https://github.com/summonarr/summonarr.git
cd summonarr

cp .env.example .env.local
${EDITOR:-vi} .env.local

docker compose build
docker compose up -d
docker compose logs -f summonarr
```

The Dockerfile is a four-stage build (deps → builder → migrate-deps → runner), produces a Next.js standalone bundle, runs as non-root `nextjs:nodejs` (UID 1001), and strips `npm`/`npx` from the final image to eliminate npm-bundled CVEs.

The set of required env vars is the same as the GHCR deploy — see [`docker-container/README.md`](./docker-container/README.md#environment-variables) for the full reference.

## Local (non-Docker) development

Docker is the supported deployment. For development against a local Postgres:

```bash
git clone https://github.com/summonarr/summonarr.git
cd summonarr
npm install

cp .env.example .env
# Set DATABASE_URL directly when running Postgres yourself, e.g.:
#   DATABASE_URL=postgresql://summonarr:password@localhost:5432/summonarr
# Then fill in NEXTAUTH_SECRET (≥32 chars), AUTH_URL, CRON_SECRET (≥32 chars),
# TMDB_READ_TOKEN, TRUST_PROXY.

npx prisma db push    # apply schema (no migrations folder)
npx prisma generate   # regenerate client (outputs to src/generated/prisma)
npm run dev
```

App runs at <http://localhost:3000> in dev mode.

Available scripts:

```bash
npm run dev          # next dev
npm run build        # next build
npm run start        # next start (production)
npm run lint         # eslint
npm run audit:deps   # custom TypeScript dep audit
npx tsc --noEmit     # type-check — there is no `typecheck` script
```

There is no test suite yet.

## Project structure

```
src/app/(app)/       user-facing pages + admin subtree (users, activity,
                     library, backup, audit-log, stats, issues)
src/app/api/         REST routes (sync, webhooks, auth, requests, issues,
                     ratings, play-history, profile, push, discord,
                     cron, health, admin/debug/…)
src/lib/             integrations: plex, jellyfin, jellyfin-availability,
                     arr, cron-auth, play-history, prisma, tmdb-types
src/components/      feature components; primitives under ui/
src/generated/prisma generated Prisma client (never edit by hand)
prisma/              schema.prisma (schema-first, no migrations folder)
public/              static assets
scripts/             build-time helpers (audit-deps, smoke-test-security, …)
Dockerfile              multi-stage standalone Next build, non-root user
docker-compose.yml      app + Postgres 17, builds from source, reads `.env.local`
docker-container/       ready-to-deploy setup pulling the GHCR image, reads `.env`
  README.md             deployment guide (env vars, proxy, webhooks, backups)
  docker-compose.yml    pulls ghcr.io/summonarr/summonarr:latest
  .env.example          annotated env template
docker-entrypoint.sh    schema sync, dedupe, cron loops, play-history poll
```

See [`CLAUDE.md`](./CLAUDE.md) and [`AGENTS.md`](./AGENTS.md) for the architecture brief and Next 16 / contribution conventions.

## Security

Please report security issues privately per [`SECURITY.md`](./SECURITY.md). In short:

- Provider secrets, OAuth tokens, and Web Push subscription tokens are encrypted at rest with AES-256-GCM when `TOKEN_ENCRYPTION_KEY` is set.
- Database backups are encrypted with AES-256-GCM + PBKDF2-SHA256 using `BACKUP_DB_PASSWORD`.
- Webhook payloads are authenticated with a constant-time compare against the configured secret.
- All `/api/sync*` and `/api/cron*` endpoints gate on `CRON_SECRET` (or an admin session).
- The container runs as non-root (`nextjs:nodejs`, UID 1001), with `npm`/`npx` removed from the runtime image.
- Security headers (HSTS, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`) are applied to every response; `/api/*` responses set `Cache-Control: private, no-store` + `Vary: Cookie`.

## Privacy

Summonarr is self-hosted: the developer operates no servers and collects no data. The iOS app talks only to the server you run and to TMDB's image CDN for artwork. See [`PRIVACY.md`](./PRIVACY.md) for the full policy (also used as the App Store privacy policy URL).

## Changelog

### v0.13.2

**Added**

- Native-client API version negotiation: a public `/api/config/compat` endpoint and an `X-Summonarr-Api` response header let the iOS app verify it's on a compatible server version (and prompt to update when it isn't). Ships dormant — no effect on the web app or existing setups.

**Changed**

- The **Support Us** / Donate page and its nav entry are now hidden automatically when no donation links are configured.

### v0.13.1

**Added**

- Approve a request with a chosen quality profile — admins can override the Radarr/Sonarr default at approval time (e.g. approve at 720p when the instance defaults to 1080p). Applied once at approval and recorded in the audit log.
- Create local username/password accounts from the admin **Users** page — fills the gap left by closed registration (handy for an App Review demo login). A `create-user` operator script does the same headlessly.
- Admin stats: top requesters and a per-server library breakdown (movies / series / episodes / runtime) for each Plex and Jellyfin server.
- More native **iOS app** API parity: vote state on media detail, grouped watch-provider types (stream / rent / buy), genre and keyword IDs for deep-linking into filtered browse, account source (local / Plex / Jellyfin) in the admin users list, and the auto-disable-new-Jellyfin-users toggle state.

**Fixed**

- TMDB keyword and genre fields now return a consistent shape across every list and detail endpoint, so native clients decode them reliably; legacy cached rows are coerced on read.

### v0.13.0

**Added**

- Groundwork for a native **Summonarr iOS app**: a full set of API endpoints the client uses — TMDB discovery (home, upcoming, popular, top-rated), single-title detail, bearer-token sessions, native Plex sign-in, a user-readable public config endpoint, plus native endpoints for requests, votes, issues, Discord link/unlink, and admin (users list with permissions + notification prefs, library bad-matches).
- Filter, sort, and search on the requests and votes lists.
- IP address is now a filter option in play-history search.
- Reporters can reopen a resolved issue by replying to it.
- Privacy policy ([`PRIVACY.md`](./PRIVACY.md)), also used as the App Store privacy URL.

**Changed**

- 4K admin actions (approve / retry / search) now route to the 4K Radarr/Sonarr instance.

**Fixed**

- Deletion votes are now persisted once an item passes the vote threshold (a transaction abort could previously roll the vote back behind a success response).
- Bulk requests: closed a quota race with a serializable transaction; batch decline now notifies only the newly-declined rows; a non-numeric quota limit is treated as disabled instead of NaN.
- Granting the admin permission bit now requires the admin role.
- SSRF policy allows rotating-CDN DNS while still blocking private ranges on the public fetch path.
- Sync de-duplicates ActiveSession inserts, stamps `availableAt`, and re-arms the vote gate.
- Backup/restore: release the import slot on an oversized first chunk, rate-limit restores per attempt, and attribute conflict-skips to the correct table.
- Admin stats no longer overflow when averaging fulfillment hours; the active-sessions response coerces BigInt playtime safely.
- Password-length cap is consistent across sign-in and account writes; issue replies with a non-string body return 400 instead of 500.

### v0.12.4

**Added**

- 4K availability is now surfaced on browse and detail pages for users with 4K access.
- Per-source webhook tokens with copy-paste Radarr/Sonarr webhook URLs (HD and 4K) under Settings → Media.
- Admins are notified when Radarr/Sonarr flag a download as "manual interaction required".

**Changed**

- Behind a reverse proxy, the client IP is now read from the correct X-Forwarded-For position. Multi-proxy deployments (e.g. Cloudflare → Nginx) should set the new `TRUSTED_PROXY_HOPS` to the number of proxies in front of the app.

**Fixed**

- Session revocation is enforced immediately on sign-out and across the admin area, and logout now fully revokes the session server-side.
- Login is throttled per account in addition to per IP, blunting distributed password-spray.
- Webhook secrets are no longer embedded in the settings page — they are fetched only when a URL is copied.
- Outbound-request error logs no longer include credential-bearing URLs (Plex token, OMDb/MDBList/ipinfo keys).
- Backup import rejects malformed multi-row INSERT statements.

### v0.12.3

**Added**

- Optional 4K Radarr/Sonarr instances: requests can route to a dedicated 4K instance, with a server-wide "allow everyone to request 4K" toggle, per-user 4K permission toggles in the admin editor, and TRaSH Guides custom formats and quality profiles applied to the 4K instances automatically.
- Overseerr-style granular permissions with per-request-type quotas.
- Request an entire collection in one click with "Request all", and admins can submit requests on behalf of another user.
- Discover now features trending movies and TV side by side.

**Fixed**

- Backup restore is hardened: the import INSERT regex is derived from the table allowlist and the internal loopback sync trigger is encapsulated, with non-2xx responses now logged.
- Issue-notification emails escape the recipient's display name.

### v0.12.2

**Added**

- Movie and TV detail pages now surface country, original language, and more metadata, with clickable genre and keyword chips that jump to filtered discovery.
- Admin stats page gained a per-server library breakdown.
- Activity heatmaps got a click-to-drill-down popover — clickable Top titles and top viewers (top 3) — plus a transcode-pressure card and richer hover tooltips on the activity line charts (share, vs average, vs previous).
- Activity history table now offers 150 and 200 rows-per-page options.
- Cache Management supports per-source clear + refetch.
- Admin activity page now has a Terminate button for Jellyfin streams.
- Machine sessions are hardened with an IP allowlist, rate limiting, and machine-attributed audit logging.

**Changed**

- Jellyfin login and server are now configured from Admin → Settings instead of the `JELLYFIN_URL` environment variable.
- Dropped NextAuth-era environment aliases, the legacy TMDB v3 key, and other dead variables.
- Session terminate now uses an in-page dialog instead of the native browser prompt.
- Plex now locks out un-shared users on session refresh.
- Removed the legacy Jellyfin play-history backfill cron; the live poller is the sole writer.

**Fixed**

- Session termination targets Plex sessions by GUID and unblocks Jellyfin Stop.
- Now-playing ordering is stable with a deterministic tiebreaker.
- Plex activity shows a friendly device name (Apple TV, Roku) instead of the machine GUID.
- Play-history resolution buckets collapse 720/720p and 1080/1080p.
- The activity calendar window is pinned to UTC.
- The in-memory session-revocation fast-path is wired into session refresh.
- Webhooks reject non-object JSON payloads with 400 instead of 500.
- Detail-page UI cleanups: extras no longer overlap the hero buttons, a tidier meta line, a keyboard focus indicator on clickable chips, and heatmap popover values no longer overhang the box.

### v0.12.1

**Added**

- Real-time Plex playback tracking over Server-Sent Events — the now-playing card updates and clears the instant a stream starts or stops instead of waiting on the 5-second poll.
- Activity views surface intro/credits markers and per-session network/connection metadata.
- Resume-grouping for play history — a watch split across sittings ("paused Monday, finished Tuesday") collapses into a single viewing.
- Settings observability panel now surfaces the Jellyfin history cron alongside the other jobs.

**Changed**

- The container now waits on an `/api/health` readiness probe before starting play-history sync instead of a fixed 30-second boot delay.
- The Plex reachability badge reflects local server connectivity (not plex.tv remote access) and only appears when Plex is configured.

**Fixed**

- Plex sessions no longer stop being tracked ~1 minute into a stream (live streams were being false-finalized by the stall detector).
- A server or container restart (e.g. a Docker upgrade) no longer marks an ongoing stream as stopped or drops the now-playing card.
- The now-playing progress bar no longer jumps backward between the real-time feed and the 5-second poll.
- Jellyfin plays imported from PlaybackReporting were incorrectly marked unwatched on most servers.
- Jellyfin history backfill no longer double-counts plays already captured live.
- Play-history accuracy pass: paused sessions stay active, resume-from-pause no longer ends a watch early, imports record real durations, and activity-stats queries serialize correctly.
- Revoked or demoted admin sessions are no longer honored on sync/cron endpoints.

### v0.12.0

NextAuth v5 is removed. Authentication, session management, and OIDC are now served by a Summonarr-native stack built directly on `jose` and `openid-client`. Net diff is roughly -600 lines across the auth subsystem; the new path is smaller, fully owned by this repo, and behaves the same to users.

**Changed**

- Sessions, sign-in routes, and OIDC code-exchange are now handled by Summonarr directly. JWT cookies are issued and verified via `jose`; OIDC discovery/code-exchange runs through `openid-client`. Existing `AuthSession` rows continue to work — no re-login required.
- `verifyAndRefreshSession` mirrors the load-bearing behaviour of the old NextAuth `refreshToken` callback: cross-replica `AuthSession` revocation, `sessionsRevokedAt` / `passwordChangedAt` cutoffs, role refresh with `sessionId` rotation, non-ADMIN sliding window (now+3600 capped at the original session deadline), and ADMIN 7-day hard ceiling. `dbCheckedAt` keeps the hot path off Postgres (10 s for ADMIN/ISSUE_ADMIN, 60 s for others) — same performance shape as before.
- `withAuth` / `withAdmin` / `withIssueAdmin` transparently append `Set-Cookie` to the handler's response when a refresh produces a new JWT, so slides and rotations land without a client round-trip.
- New `/api/auth/me` endpoint plus `SummonarrSessionProvider` replace `useSession` from `next-auth/react` across all client components.

**Fixed**

- Admin sidebar now appears immediately after sign-in — the client refreshes the session and routes in the same tick instead of waiting for a manual reload.
- Plex-user backfill on boot now targets only Plex-only users (no `passwordHash`, no `jellyfinUserId`, no OIDC `Account` row) and logs the affected users by email + ID when an admin token can't resolve them. Local/Jellyfin/OIDC accounts with a null `plexUserId` are no longer scanned on every boot.

**Internal**

- `authorize()` helpers extracted from the credentials provider into reusable modules so each provider has a single audited entry point.
- Trivial `@base-ui/react` wrappers (button, input, badge, avatar) collapsed to direct primitives — fewer indirection layers, no behavior change.

### v0.11.3

This release consolidates a multi-pass security and correctness audit (24 merged PRs, #73–#96). No breaking changes — primarily defense-in-depth, race-condition fixes, and observability.

**Added**

- Email notifications now fire on `AVAILABLE` transitions from both the sync orchestrator and the Sonarr/Radarr webhook paths (previously push-only).
- Settings observability panel surfaces per-cron `ok`/`error` outcomes from the most recent run.
- Container hardening in both compose files: `no-new-privileges`, `cap_drop: ALL` (Postgres re-adds only `CHOWN/SETUID/SETGID/DAC_OVERRIDE/FOWNER`), and a 128 MiB tmpfs `/tmp` for the app.
- `engines.node = ">=22 <27"` declared in `package.json` so `npm ci` fails fast on unsupported Node versions.
- Three new hot-path Prisma indexes: `PlexLibraryItem(addedAt)`, `JellyfinLibraryItem(addedAt)`, and `IssueGrab(tmdbId, mediaType, notifiedAt)`. Applied automatically on container restart via `prisma db push`.

**Changed**

- ADMIN sessions are now capped at a 7-day ceiling derived from `iat`, regardless of activity. Non-admin sessions are unchanged.
- Radarr/Sonarr add-payloads use an explicit allowlist of forwarded fields instead of spreading the upstream response — defends against the upstream injecting unexpected fields into the POST body.
- Database-import chunks are now hard-capped at 32 MiB so backup-restore can't be used as a memory-pressure vector.
- Number formatting across the admin dashboard forces `en-US` locale so SSR and hydration agree (guardrail 16).
- Settings PATCH rolls back field writes when the upstream service test fails inside the same transaction — partial saves are no longer possible.
- Per-source sync success is now stamped (`lastPlexSyncSucceededAt` / `lastJellyfinSyncSucceededAt`) so the orchestrator's mixed `Promise.allSettled` outcome is observable.
- `mdblist-warm` uses atomic `INSERT … ON CONFLICT` CAS for winner-takes-all coordination.
- Cold-miss fetches for OMDB and MDBList are now coalesced — concurrent lookups for the same key share one upstream call.
- CI Node version aligned with the production runtime (Node 26).

**Fixed**

- `AVAILABLE` notifications are filtered to the actual compare-and-swap winners — no more duplicate push/email when Plex and Jellyfin sync runs overlap on the same title.
- `DeletionVote` rows are wiped on every `AVAILABLE`-transition site (sync, webhooks, interactions, request mutations) — stale votes no longer survive a request re-becoming available.
- Webhook grab-notification reset is now reachable; the replay-digest now rolls back when the handler body throws (so a transient handler failure no longer silently blackholes subsequent identical webhooks).
- Session revocation closes a cross-replica 60-second window by bumping `sessionsRevokedAt` inside the same transaction, with a monotonic guard.
- `MediaRequest.status` rolls back to `PENDING` on Radarr/Sonarr push failure (both single-request and batch endpoints); issue-status transitions use CAS.
- Email is normalized at four cross-boundary sites (download-policy, play-history, plex-user-backfill, auth-adapter) so case/whitespace variants no longer create duplicate `MediaServerUser` rows.
- Two encryption regression gaps closed: `encryptToken` is now idempotent when called on already-`enc:v1:`-prefixed input, and `account.updateMany`/`createMany` throw if a token field is set — both prevent the double-encrypted `enc:v1:<enc:v1:…>` rows that broke OAuth sign-in in earlier releases.
- `MediaServerMismatchError` is surfaced from the Jellyfin play-history sync instead of being swallowed.
- IP-info popup re-reads the cache when re-opened (no stale entries); issue-fix-match search aborts the prior fetch on debounce.
- `fix-match` lookups are rate-limited to 10/min/user.
- Settings URLs containing `username:password@` are rejected on write and stripped from `GET` responses.
- Three play-history races: `ActiveSession` lifecycle CAS, `MediaServerUser` upsert serialized via a Postgres advisory lock, and Plex `isServerAdmin` derived from the actual server-owner account (not just any present admin).
- **Hotfix.** The advisory-lock key above used an unsigned 32-bit FNV-1a hash; values ≥ 2³¹ were typed as `bigint` by Postgres and missed the `pg_advisory_xact_lock(int, int)` overload. Now masked with `& 0x7fffffff` so play-history polls stop crashing for ~half of `MediaServerUser` rows.
- `THIRD_PARTY_LICENSES.txt` generator now treats `optional: true` lockfile entries (with no os/cpu/libc) as platform-gated, so on-disk LICENSE reads no longer differ between a macOS dev box and Linux CI.

**Internal**

- Three audit quick-wins: hardcoded `EXCLUDED_USERNAMES` cleared, synthetic `@discord.local` email suffix added, push-test handler decrypts `p256dh`/`auth` before sending.
- License-check CI failure now prints the first divergence hunk so a stale `THIRD_PARTY_LICENSES.txt` is debuggable without a manual re-run.
- `AuditAction` enum derived from `Object.values(AuditAction)` (single source of truth) instead of the duplicated string arrays the admin UI used to carry.

### v0.11.1

**Added**

- Loading skeletons for the Requests, Issues, Votes, Upcoming, Popular, and Top routes (paired with a shared `PosterGridSkeleton`). Route swaps now feel immediate while TMDB / Prisma queries warm up.
- Skip-to-main-content link on every authenticated page so keyboard users can jump past the sidebar and header in one tab.
- ARIA live regions on admin action buttons (Approve / Decline / Sync / Re-push / Discord role sync) so screen readers announce the result.
- Activity heatmap is now screen-reader-readable (`role="img"` plus an aria-label summary with totals, active days, and peak-day plays).
- Audit-log entry is now written when an admin rotates or removes the Plex admin token — previously the most security-sensitive `SETTINGS_CHANGE` operation was silently exempt from the audit pipeline.
- New `PlayHistory` composite indexes on `(source, startedAt)` and `(mediaType, startedAt)` for filtered Activity-page queries. Applied automatically on container restart via the existing `prisma db push` entrypoint step.

**Changed**

- **Light mode now renders correctly.** Legacy Tailwind utilities (`bg-zinc-*`, `text-zinc-*`, `bg-indigo-*`, etc.) used across 64 files were only remapped under `[data-theme="dark"]`. Mirroring the remap to `[data-theme="light"]` routes them through the design-system token stack, which inverts per theme; zinc-600 is split per theme.
- The cron purge job now sweeps stale rows from `PlexTokenCache` (including legacy-null rows older than 90 days), `WebhookReplay`, `TmdbMediaCore`, `IpLookupCache` (90-day cutoff), and `AuditLog` (365-day cutoff). The sweeper that the model comment in [prisma/schema.prisma](prisma/schema.prisma) promised never landed in `maintenance.ts`; it does its job now.
- Discord webhook timestamp tolerance is asymmetric — future-dated interactions are rejected. Past timestamps still get the documented 5 s window; future timestamps get 2 s for benign clock skew and no more.
- Concurrent in-flight Jellyfin QuickConnect long-polls are capped (3 per IP, 50 global). A single client can no longer hold every available socket for 25 s at a time.
- `/api/push/vapid-key` now requires authentication; `/api/auth/setup-status` is rate-limited (30/min per IP). Both were anonymous probes.
- Settings tab navigation carries `aria-label` and `aria-current="page"`; login credentials inputs declare `autoComplete="email"` / `autoComplete="current-password"`; cast-section credit cards activate on Space as well as Enter.

**Fixed**

- **Query performance.** Wide `OR: items.map(...)` clauses against composite primary keys (home rails, votes page, admin library, admin issues, ratings prewarm) are replaced with `tmdbId IN […]` split by media type — the planner serves these from the existing composite index. Votes-page renders dropped from ~120 round-trips to 2 batched queries; admin library no longer builds 25 000-disjunct queries Postgres can't optimise; the admin Activity dashboard no longer fires 4 redundant aggregates that `getPlayHistoryStats` already returned; the TRaSH-Guides starter-pack resolver now runs in parallel instead of a serial `for…of`.
- **Webhook ergonomics.** Radarr and Sonarr **Test** buttons no longer return 409 when clicked twice within the 24-hour replay-digest TTL — the digest check now skips Test events entirely. Sonarr `Download` webhooks backfill `MediaRequest.tvdbId` when a `tmdbId`-matched event arrives, so a later `tvdbId`-only event can still evict its wanted-cache row.
- Plex-only / Jellyfin-only library items no longer flap back to `AVAILABLE` after the next sync.
- Jellyfin play-history pagination advances by the actual page count, not an assumed page size.
- More Like This suggestions now block on TMDB rating enrichment before rendering.
- Now Playing quality cell shows resolution and bitrate space-separated; plays-per-day chart pads empty days with zeros.
- Auth fingerprint-mismatch redirect builds with mutable headers so the cookie-clear actually applies (the previous `Response.redirect(...)` form returned an immutable-headers response, swallowing the `Set-Cookie` append).
- `arr-stats` disk-space lookups route through `arrFetch` — restores the 50 MB body cap (guardrail 5) and the consistent timeout/error handling that bare `safeFetchAdminConfigured` lacked here.
- Modal dialogs route through the accessible `Dialog` primitive; form controls have labels and focus-visible rings; invalid `role="button"` on `<tr>` elements removed from the Activity history and recent-plays tables.
- Plex and Jellyfin library cache lookup keys are now indexed.

**Internal**

- CI now runs `npm run audit:routes` as a blocking step (CLAUDE.md guardrail 6a was documented but not enforced before). 89 routes audited; every authenticated route carries a recognised guard.
- ESLint `no-unused-vars` respects the `_`-prefix convention (`argsIgnorePattern: "^_"`) so `withAuth` / `withAdmin` handler signatures stop reporting ~70 noise warnings on every lint. Final lint count: 0 warnings, 0 errors.
- CLAUDE.md updated to reflect Next 16's `middleware.ts` → `proxy.ts` rename (the previous note steered readers — and AI assistants — past `src/proxy.ts`).
- Drop `as any` cast on the base `jwt` callback delegation in `src/lib/auth.ts` — typed local with a null check.
- Type the client-side `fetch().then(r => r.json())` returns in `discord-link-ui`, `audit-log-table`, and `activity-recent-plays` so a server-shape change can no longer rot silently.

### v0.11.0

**Breaking**

- **Legacy bcrypt password hashes are no longer accepted.** Since v0.10.x the local-credentials provider transparently rehashed bcrypt logins to scrypt on every successful sign-in; this release removes the bcrypt verify fallback entirely. Any local account that has *not* signed in since the rehash shipped will be unable to log in after upgrading. **Before deploying**, run `node scripts/migrate-legacy-passwords.mjs` — it lists any remaining `$2`-prefixed rows and must report zero. If it does not, re-run it with `--nullify` to clear those hashes, which sends the affected users through the password-reset flow on next sign-in. Plex, Jellyfin, and OIDC accounts are unaffected.
- The unused Plex and Jellyfin webhook routes (`/api/webhooks/plex`, `/api/webhooks/jellyfin`) and their `plexWebhookSecret` / `jellyfinWebhookSecret` settings have been removed. The settings UI never surfaced these URLs, and the 5-second play-history polling sync already ingests the same sessions (with richer transcode metadata), so no shipped install relied on them. Radarr and Sonarr webhooks are unchanged. Orphan `Setting` rows for the removed keys are harmless and may be deleted manually.

**Added**

- `SSE_MAX_LISTENERS` env var makes the SSE connection cap tunable (defaults to 500).
- "Fork me on GitHub" link in the mobile navigation drawer footer.

**Changed**

- The admin API documentation page now renders through a lightweight in-tree OpenAPI viewer instead of the bundled `swagger-ui-react`.
- Dependency-surface reduction: `bcryptjs`, `tsx`, `swagger-ui-react`, `shadcn`, `@auth/prisma-adapter`, `lucide-react`, and ~10 other packages dropped in favor of in-tree implementations — smaller image and less supply-chain surface, no behavior change.
- Text columns across `MediaRequest`, `Issue`, `AuditLog`, `PlayHistory`, `ActiveSession`, and others are now length-capped (`@db.VarChar`). The Docker entrypoint's `db push` auto-retry was extended to apply the resulting text→varchar narrowing casts and cascading primary-key rebuilds without requiring `SUMMONARR_ACCEPT_DATA_LOSS`.

**Fixed**

- **Concurrency / correctness pass.** Advisory locks added to `TVEpisodeCache` rewrites and the full setup-restore transaction; the sync orchestrator gained advisory locks, batched compare-and-swap updates, and graceful fallback across stale sources.
- **Security hardening.** `safe-fetch` closes a DNS-rebind window, SSRF-checks trusted hosts, and plugs IPv6 gaps; webhook routes gained a per-IP rate limit, tolerate malformed numerics, and return a unified 401 body; per-email auth rate-limit fallback; SMTP host pinned against DNS rebinding; non-admin session count capped; the Plex token cache is now bound by `plexUserId` rather than reassignable email.
- **Hydration / accessibility.** `absTime` pinned to UTC and day labels made timezone-stable (guardrail 16); the IP-info panel is portaled so it escapes table-grid clipping; keyboard-navigable activity rows and modal a11y improvements.
- `safe-fetch` strips stale `Content-Encoding` / `Content-Length` headers when re-wrapping a decompressed response body.
- The audit-log export pre-writes its row and validates the requested date range.
- Discord approval flow audited; issue GUID allowlist tightened; remaining hydration-unstable dates fixed.

### v0.10.4

**Changed**

- Runtime container base image bumped to Node 26 (`node:26.1.0-alpine3.23`).
- CI security tooling updated (`github/codeql-action` v4.35.5, `zizmorcore/zizmor-action` v0.5.6).

**Fixed**

- Patched a `brace-expansion` denial-of-service advisory (bumped to 5.0.6) without disturbing the legacy resolver path.
- Routine dependency refresh (`swagger-ui-react`, `eslint-config-next`).

### v0.10.3

**Added**

- Appearance system: selectable theme + accent color, with a new discover hero on the home page.
- Admin Requested page gains a media-type filter and a release-year sort.
- Activity titles now link through to a per-title page at `/admin/activity/media`; requests page shows content rating and external ratings.
- Sync auto-retries `APPROVED` requests that Radarr/Sonarr never accepted, instead of leaving them stuck.
- Play history captures the real transcode reason reported by the media server.

**Changed**

- Admin Activity overview redesigned (metrics dashboard, recent plays, now-playing).
- Project relicensed/clarified as AGPL-3.0-only with bundled third-party notices and a source link in the UI.

**Fixed**

- Activity dashboard metrics corrected and filter SQL consolidated into one builder.
- Play history Top movies/TV use real cover art and exclude rewatches; user "Most watched" prefers the live cache over a stale snapshot for artwork.
- Unmapped titles in user "Most watched", Recent plays, and the user detail page now resolve via a library fallback so they link correctly.

### v0.10.2

**Changed**

- CI security hardening to clear findings raised by the v0.10.1 scan suite against `main`:
  - `docker-publish.yml` now declares a top-level least-privilege `permissions: contents: read`; the publish job keeps its wider opt-in scopes (Scorecard `TokenPermissionsID`, HIGH).
  - `persist-credentials: false` on the `actions/checkout` step in all seven workflows that don't push back to the repo, so a compromised later step can't exfiltrate the cached `GITHUB_TOKEN` (Zizmor `artipacked`).
  - Dependabot now applies per-ecosystem cooldown windows (npm patch 2d / minor 5d / major 14d; github-actions 5/7/14; docker 3/5/14) so a freshly-published malicious or broken version has time to be retracted upstream before it lands in a PR. Patch windows kept short so CVE fixes still flow fast (Zizmor `dependabot-cooldown`).

No runtime or application code changed in this release.

### v0.10.1

**Added**

- Three new GitHub Actions security workflows: **Dependency Review** (PR-time block on new vulnerable deps or restricted licenses), **OSSF Scorecard** (weekly supply-chain hygiene score, published to the public OpenSSF registry), and **Zizmor** (static analyzer for the workflow files themselves).
- Per-source webhook secrets (`plexWebhookSecret`, `jellyfinWebhookSecret`, `radarrWebhookSecret`, `sonarrWebhookSecret`) with a legacy `webhookSecret` fallback. `scripts/migrate-webhook-secrets.mjs` copies the legacy value into the four new keys on first run.
- New `EmptyState` component used across browse, upcoming, top, and popular grids. Distinguishes TMDB config errors from filtered-empty cases and offers contextual CTAs ("Clear filters", "Switch to Most Played").

**Changed**

- a11y / mobile: aria-labels on 11 icon-only buttons (issue actions, activity history, filter bars, user-list filters, fix-match, user-table close); touch targets bumped to h-9 on push-device revoke, settings cron run, and settings clear-cache / cancel buttons; "This device" badge in auth-sessions made solid indigo + checkmark.
- Native `window.confirm` replaced with inline confirmations for admin vote dismiss, session revoke, push-device removal, user delete + revoke-all-sessions, issue take-over, and TRaSH spec "Forget".
- Visual contrast: activity-calendar empty cells use `--ds-bg-3`, active cells alpha range bumped to 0.45–1.0 for dark-mode legibility (legend included). `requests` AVAILABLE chip retoned to match the admin list. media-card corner badge drops the duplicate IMDb chip and shows the TMDB community score with a star icon instead. admin section card border radius normalized.

**Fixed**

- **Concurrency / correctness pass.** Jellyfin sync no longer wipes `TVEpisodeCache` on each `recentOnly` pass — delete is now scoped to recent `tmdbId`s. Admin PATCH to AVAILABLE uses an atomic `notifiedAvailable` CAS so users can't get two "now available" notifications when the sync orchestrator races the admin button. Radarr/Sonarr cache refresh hoisted ahead of the revert pass and gated on per-source success flags — a transient ARR outage no longer mass-demotes AVAILABLE → APPROVED. Plex and Jellyfin sync stop re-stamping `availableAt` on already-notified rows every tick.
- **Security audit batch** (31 findings). Webhook + interactions handlers reject oversized bodies via `Content-Length` pre-check; async `pbkdf2` and per-IP rate limit on the unauthenticated `setup/import` path; same-origin check on the admin-session branch of `isCronAuthorized` so cookie-based cron triggers can't be CSRF'd; Prisma extension forbids `setting.updateMany` with `value`; Jellyfin history cron pins `MediaServerUser.serverMachineId`; advisory lock gains optional `AbortSignal`; per-IP rate limit on the Plex login provider; SSRF-policy check on admin-configured SMTP host before constructing the nodemailer transport. Plus hydration fixes (guardrail 16) in three components and the activity calendar, BIGINT-cast regex guards on three admin warm routes, HMAC of the Plex token cache key, consistent Discord markdown escaping, and per-user scoping of the Discord search cache.
- **Dependency advisories cleared.** Next.js → 16.2.6 (resolves 13 GHSAs incl. proxy bypass, RSC cache poisoning, image-optimization DoS), react/react-dom → 19.2.6, resend → 6.12.3, tailwind-merge → 3.6.0, `github/codeql-action` → 4.35.4.
- **Docker base image.** Pin to `node:25.9.0-alpine3.23`, clearing 15 advisories including CVE-2026-21636 (critical) and CVE-2025-55130 (critical) that the previous floating `node:25-alpine3.21` tag was resolving to.
- `global-error.tsx` imports `globals.css` and uses `--ds-*` tokens so unrecoverable error pages adapt to light mode.
- `activity-history-table` surfaces fetch errors with a red error row + Retry button instead of silently swallowing them; `AbortError` is still ignored.
- `tmdb-core-sync` `$transaction` now passes `{ timeout: BATCH_TX_TIMEOUT }`.
- `fix-match` route: 50 success-progress logs deleted; 14 wrapper logs converted to direct `console.warn/error` with `[fix-match]` prefix per guardrail 7.
- Sonarr + Radarr webhook routes no longer log the "configure Authorization header instead" warning. Per guardrail 2, those services' webhook UIs have no header field — `?token=` is the only upstream-supported option, so the warning was pure noise.

### v0.10.0

**Added**

- Plex and Jellyfin **Save & Test** under Settings → Media — saving the connection now verifies it by loading libraries from the upstream server in one click, with the picker auto-populated on success.
- Settings page surfaces a banner listing any saved Setting that fails to decrypt (e.g. after `TOKEN_ENCRYPTION_KEY` rotation), with the affected key names so operators know which rows to re-save.
- Now Playing usernames in the admin Activity dashboard link directly to the per-user activity page.
- TRaSH Guides admin page split into tabbed sub-routes; apply/refresh hardened with lock symmetry, per-spec error tracking, and stricter input validation.

**Changed**

- TMDB poster grids use `next/image` optimisation — faster page loads and lower bandwidth.
- Play-history sync batches Setting reads, prefetches lookup maps, and parallelises writes — noticeably faster on large libraries.
- `[token-crypto]` legacy-plaintext warnings now name the affected row (e.g. `Setting.jellyfinApiKey`, `Account.access_token (id=…)`); non-sensitive Setting rows (URLs, booleans, feature flags, thresholds) are stored plaintext by design and no longer trigger the warning.

**Fixed**

- Settings page no longer 500s when one Setting row can't be decrypted — affected rows return as empty and are surfaced in the on-page banner instead of crashing the render path.
- Plex/Jellyfin/Radarr/Sonarr integrations rejecting credentials with HTTP 401 after the security rollout — collapsed double-encryption of Setting + Account tokens introduced by route-level pre-encryption layered on top of the Prisma extension. Recovery: `scripts/fix-double-encrypted.mjs`.
- **Comprehensive security audit pass.** `TOKEN_ENCRYPTION_KEY` is now mandatory at boot; Plex/Jellyfin sign-in bound to `(provider, sub)` instead of email; SSO users can no longer set local passwords; sync orchestrator wrapped in an advisory lock; webhooks scoped by `serverMachineId`; SSE allowlist split per-role so `ISSUE_ADMIN` no longer sees other users' request/vote/push events; donation URLs gated to `http(s)://`; tighter SSRF detection (incl. v4-mapped IPv6); statement_timeout on the advisory-lock client; new audit actions (FIX_MATCH, AUDIT_LOG_EXPORT, PLAY_HISTORY_DELETE, BATCH_REQUEST_DECLINE, VOTE_DISMISS_ALL, SERVER_USERS_BULK); session and machine-session hardening with UA fingerprint pinning. Operator action: set `TOKEN_ENCRYPTION_KEY=<64 hex chars>` and run `prisma db push` once on first start.
- Closed IDOR, SSRF, rate-limit, and compare-and-swap gaps across issues, Discord, profile, and Discord-interactions routes.
- Backup integrity: snapshot-isolated exports, proper JSON column escaping, duplicate-row tolerance during restore.
- Sync orchestrator and webhook handlers — race-condition and idempotency fixes.
- Admin egress tightened; play-history query inputs validated; admin audit trail expanded.
- TRaSH: Sonarr episode naming applied; first-apply error log quieted.
- Mobile: respect `safe-area-inset-top` on notched iOS and Android devices.

### v0.9.5

**Added**

- Live Watch on the admin Activity page — active sessions and recent plays refresh in real time via SSE.
- Jellyfin play-history capture: a dedicated cron job (`sync-jellyfin-history`) backfills completed sessions into Summonarr's history.

**Changed**

- Plex user download-permission controls removed from the admin Users page. The Plex sharing API does not expose a working remote toggle for `allowSync`, so the previous toggle persisted to the DB but never reflected on Plex. Jellyfin download enforcement is unchanged. Manage Plex download permissions in Plex itself.

### v0.9.4

**Added**

- Download-permission management layer for Plex and Jellyfin users — per-user enable/disable, bulk operations, diagnostics endpoint, and a background sync cron job (`sync-download-policies`).
- Chunked upload for DB restore and setup-mode import — large backup files no longer time out during upload.
- Setup-mode import panel with chunked upload support.

**Changed**

- `TRUST_PROXY=false` now restricts the app to local connections instead of crashing on startup.

**Fixed**

- Server Users table back-link now lands on the Users list, not the Activity overview.
- Server Users table columns are now sortable by header click.
- Mobile layout and responsive polish across several pages.

### v0.9.3

**Added**

- `lastRunAt` tracking for cron-only jobs (warm-activity, warm-list-cache, warm-mdblist, warm-omdb, ratings sync) so they surface in **Admin → Settings**.
- Public `/.well-known/security.txt` for security-disclosure contact.

**Changed**

- Expanded `SECURITY.md` with clearer disclosure policy and contact details.

**Fixed**

- React #418 hydration errors across six components — purged `Date.now()` / `new Date()` from `"use client"` render paths in `filter-bar`, `top-filter-bar`, `activity-history-table`, `activity-recent-plays`, `trash-guides-client`, and `activity-calendar`.
- Hydration mismatch from a nested `<button>` inside `MediaCard`.
- Hydration mismatch when `user.image` is unset (skip `AvatarImage` rather than render an empty `<img>`).
- TRaSH-Guides descriptions: HTML now stripped before render, with hardened sanitization against CodeQL-flagged tag-confusion patterns.
- Audit log labels: `ISSUE_CLAIM` and previously unmapped actions now render their human-readable label.
- Profile page falls back to the login email when `notificationEmail` is unset.
- **Most Played** now dedupes by `tmdbId` across Plex + Jellyfin so the same title doesn't double-count.
- Admin requester row: widened gap so the count badge stays readable next to long usernames.

### v0.9.2

**Added**

- TRaSH integration: import Custom Format Groups directly from the TRaSH `cf-groups` catalog.
- Issue claim: admins can claim an issue to scope subsequent reply notifications to themselves.
- Admin user management: per-user issue-notification toggle, visible for all users.

**Changed**

- Issue replies now fan out via email to the reporter and to other admins (not just the responder), honoring each user's `notifyOnIssue` preference.

**Fixed**

- Media activity page renders correctly when a user has no play history.
- `notifyOnIssue` is now respected when an admin replies to a reporter.

### v0.9.1

Prior release. See `git log v0.9.1` for details.

## Beta testing

Summonarr v0.13.2 is a beta release and real-world feedback is needed before a stable 1.0. If you run Plex or Jellyfin at home and want to help:

1. **Deploy** using [`docker-container/README.md`](./docker-container/README.md).
2. **Exercise the app** — browse, request movies and TV, approve them through Radarr/Sonarr, trigger webhooks, and use the admin pages.
3. **Report what breaks** — open a GitHub issue with the details listed in [Contributing](#contributing) below.

Particularly useful feedback:

- Anything that breaks with large Plex or Jellyfin libraries (thousands of items).
- Edge cases in the Radarr/Sonarr approval pipeline (stuck requests, missing badges).
- Auth flows: Plex OAuth, Jellyfin QuickConnect, and OIDC providers other than Authentik.
- Mobile layout issues or Web Push notification failures.

There is no mailing list or Discord. GitHub Issues is the only channel.

## Contributing

**Bug reports and feature requests are welcome.** If you open an issue, please include:

- A clear description of the problem or requested feature.
- Steps to reproduce (for bugs): what you did, what you expected, what actually happened.
- Relevant environment details: Docker image tag, host OS, which external services (Plex, Jellyfin, Radarr, Sonarr) are involved.
- Log output from `docker compose logs summonarr` covering the failure window.
- For request-pipeline issues: the output of `/api/admin/debug/arr-state?tmdbId=<id>&type=movie|tv` (admin only).

Issues opened without sufficient detail to reproduce or understand the problem may be closed without action.

## License

Summonarr is licensed under the **GNU Affero General Public License v3.0**. See [`LICENSE`](./LICENSE) for the full text.

This means that if you run a modified version of Summonarr on a network server and let others interact with it, you must also make the modified source code available to those users.
