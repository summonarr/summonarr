@AGENTS.md

# Summonarr

Self-hosted media request aggregator. Users browse TMDB (trending / popular / discover / upcoming), request movies and TV, vote, and file issues. Admins approve requests and auto-fulfill via Radarr/Sonarr. The app ingests Plex and Jellyfin libraries + play history so users see availability, active sessions, and watch activity in one place. There is no public README — this file is the canonical project brief.

## Stack

- **Next.js 16.2.3** (App Router). AGENTS.md is not a suggestion — **read [node_modules/next/dist/docs/](node_modules/next/dist/docs/) before touching framework code**.
- **TypeScript** strict, path alias `@/*` → `./src/*`
- **Prisma 7.7** + **PostgreSQL 17**, schema-first. No `prisma/migrations/` directory — changes are applied via `prisma db push`.
- **NextAuth v5** with JWT sessions plus a custom `AuthSession` table for per-device tracking. Providers: local credentials, Plex OAuth, Jellyfin (standard + QuickConnect), OIDC.
- **Tailwind v4** — **no `tailwind.config.js`**. Theme lives inline in [src/app/globals.css](src/app/globals.css) under `@theme inline` with oklch variables and `.dark` class-based dark mode.
- **UI**: [src/components/ui/](src/components/ui/) — `@base-ui/react` (Radix-style) primitives scaffolded via the `shadcn` CLI, composed with `class-variance-authority` and `tailwind-merge`.
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

There is **no** `typecheck` script — run `npx tsc --noEmit` when you need it. There is **no** test suite (no vitest/jest/playwright configs, no `*.test.ts`). Do not claim "tests pass."

## Directory map

- [src/app/(app)/](src/app/(app)/) — user-facing pages: home, movies, tv, upcoming, popular, top, votes, requests, issues, donate, profile, settings, plus an `admin/` subtree (activity, users, library, backup, audit-log, stats, issues).
- [src/app/api/](src/app/api/) — REST handlers grouped by domain: `sync/`, `webhooks/`, `auth/`, `admin/`, `requests/`, `issues/`, `votes/`, `ratings/`, `play-history/`, `profile/`, `search/`, `sessions/`, `push/`, `discord/`, `cron/`, `health/`.
- [src/lib/](src/lib/) — integrations and utilities: `plex.ts`, `jellyfin.ts`, `jellyfin-availability.ts`, `arr.ts`, `cron-auth.ts`, `play-history.ts`, `tmdb-types.ts`, `prisma.ts`.
- [src/components/](src/components/) — feature components; primitives under `ui/`.
- [prisma/schema.prisma](prisma/schema.prisma) — every model (User, Account, AuthSession, MediaRequest, Plex/JellyfinLibraryItem, Radarr/Sonarr{Wanted,Available}Item, TVEpisodeCache, TmdbCache, TmdbMediaCore, Issue, IssueMessage, IssueGrab, PlayHistory, ActiveSession, DeletionVote, PushSubscription, Setting, MediaServerUser, …).
- [src/generated/prisma/](src/generated/prisma/) — generated client output. **Never edit by hand.**
- There is **no** `middleware.ts`. Auth gating lives in NextAuth's `authConfig.callbacks.authorized()`.

## Core architecture

**Sync orchestrator** — [src/app/api/sync/route.ts](src/app/api/sync/route.ts)
- External-cron entry point, Bearer-authed via `CRON_SECRET` (or admin session).
- Runs Plex + Jellyfin library fetch+write *concurrently* via `Promise.allSettled`; Radarr/Sonarr/TMDB jobs run in parallel inside the same `Promise.all`.
- One shared `stillPending` snapshot is reused across both sources' marking passes. An atomic compare-and-swap on `notifiedAvailable` prevents duplicate user notifications when an item appears in both libraries in the same run.
- Landed in commit `3dcbd79` ("parallel Plex+Jellyfin sync, shared auth util, recentOnly for Jellyfin, and batch tx timeouts").

**Sync modes**
- **Full sync** — atomic `deleteMany` + repopulate inside one `$transaction`. Triggered by `{ "full": true }` in the POST body (admin "Resync" button).
- **recentOnly** (default for Jellyfin) — incremental insert-only, bounded by a 2-hour `MinDateLastSaved` window (`RECENT_WINDOW_MS`). Intentionally wider than `SYNC_INTERVAL=3600s` so one missed run is survivable.

**Batch writes** — [src/lib/cron-auth.ts](src/lib/cron-auth.ts)
- `batchCreateMany(tx, rows)` chunks inserts into `CREATE_MANY_BATCH = 5_000`.
- `BATCH_TX_TIMEOUT = 30_000` — always pass this to `prisma.$transaction(..., { timeout: BATCH_TX_TIMEOUT })` for library-sized writes.

**`isCronAuthorized`** — same file. Accepts an admin session *or* `Authorization: Bearer ${CRON_SECRET}`. Every sync/cron route funnels through this — touch carefully.

**arrFetch** — [src/lib/arr.ts](src/lib/arr.ts)
- Shared Radarr/Sonarr HTTP client. 30s timeout, **50 MB** response cap (`ARR_FETCH_MAX_BYTES`), injects `X-Api-Key`, throws `ArrResponseError` on non-2xx, routes through `safeFetchAdminConfigured`.
- Body cap was raised from 10 MB in `c7902db` because libraries with >3k movies were being silently truncated. Do not lower it.

**safe-fetch helpers** — [src/lib/safe-fetch.ts](src/lib/safe-fetch.ts)
- `safeFetch(url)` — full SSRF policy (resolve+pin, blocks RFC1918/loopback/link-local/CGNAT/multicast). For user-supplied URLs.
- `safeFetchTrusted(url, { allowedHosts })` — required hostname allowlist; skips DNS-based SSRF. For fixed third-party APIs (TMDB, plex.tv, discord.com, ipinfo.io, api.trakt.tv, api.github.com, raw.githubusercontent.com, www.omdbapi.com, api.mdblist.com).
- `safeFetchAdminConfigured(url)` — runs SSRF policy with `allowPrivate=true` (RFC1918/ULA/loopback OK; link-local + 0.0.0.0 still blocked). For URLs persisted in `Setting` (Radarr/Sonarr/Jellyfin/Plex server).

**Webhook auth** — [src/app/api/webhooks/](src/app/api/webhooks/) (plex, jellyfin, sonarr, radarr)
- SHA-256 + `timingSafeEqual` against the stored webhook secret.
- Accepts either `Authorization: Bearer …` **or** a `?token=…` query param. The query-string fallback is load-bearing — see guardrails.
- No HMAC signature validation; none of these services send one.

**Play history** — [src/lib/play-history.ts](src/lib/play-history.ts)
- `recordCompletedSession()` ingests when an `ActiveSession` completes and writes a `PlayHistory` row with full playback metrics (duration, pause, codec, resolution, bitrate, device, IP, etc).
- `getActivityCalendarUncached()` (~line 827) backs the GitHub-style 365-day heatmap in [src/components/admin/activity-calendar.tsx](src/components/admin/activity-calendar.tsx). Commit `803cd11` fixed a `$1` placeholder offset bug in its filtered-query path — the dynamic SQL builder starts parameters at `$1`, not `$2`.

**Observability** — admin-only `GET /api/admin/debug/arr-state?tmdbId=<id>&type=movie|tv` dumps the whole pipeline: cache rows, `attachArrPending` result, live Radarr/Sonarr check, tvdb→tmdb mapping, total wanted-table counts, and the most recent `LIBRARY_SYNC` audit row. Use this before guessing when a badge is missing.

**Logging** — custom `console.error`/`console.warn` wrapper. Namespaced with `[scope]` prefixes. `console.log` success/progress messages were intentionally removed in `88c20c5`. Silent success is the convention.

**Errors** — API routes return `NextResponse.json({ error }, { status })`, no try/catch wrapper. Shared error classes: `SafeFetchError`, `ArrResponseError`, `BackupCryptoError`. React boundaries at [src/app/(app)/error.tsx](src/app/(app)/error.tsx) and [src/app/global-error.tsx](src/app/global-error.tsx).

## Environment

Required: `DATABASE_URL`, `NEXTAUTH_SECRET`, `AUTH_URL`, `CRON_SECRET` (≥32 chars), `TRUST_PROXY`, `TMDB_READ_TOKEN`.
Optional: `JELLYFIN_URL`, `OIDC_{ISSUER,CLIENT_ID,CLIENT_SECRET,DISPLAY_NAME}`, `BACKUP_DB_PASSWORD` (≥12 chars), `BASE_PATH`, `AUTH_TRUSTED_ORIGIN`, `SYNC_INTERVAL`, `UPCOMING_SYNC_INTERVAL`, `RATINGS_SYNC_INTERVAL`, `PLAY_HISTORY_SYNC_INTERVAL`.

## Deployment

Multi-stage Docker: `node:22-alpine3.21` → standalone Next build, non-root `nextjs` user. Postgres 17-alpine sidecar with `postgres-data` volume. Internal port 3000 → host 3001. Volumes: `/data` (app) and `/app/.next/cache`. External `sync-cron` / `upcoming-cron` services POST to the API routes with `CRON_SECRET`.

## Releasing — version bump checklist

The project version is duplicated across four files. Drift is the default unless every bump touches all of them in the same commit. The Docker image tag (`v<X.Y.Z>`) is what users actually pull, so the README examples must agree with the package version or `SUMMONARR_VERSION=v0.9.2` (etc.) will point at an image that doesn't exist.

**ALWAYS** bump these together when cutting a release. `<X.Y.Z>` is the bare semver (no `v`); the docker tag form is `v<X.Y.Z>`.

1. [package.json](package.json) — `"version": "<X.Y.Z>"` (root field).
2. [package-lock.json](package-lock.json) — `"version": "<X.Y.Z>"` in **two** places only: the top-level field and `packages.""` (lockfile v3 keeps both, and `npm install` will rewrite either if they disagree). **Do not** global-find-replace the old version across this file — common SemVers like `0.1.0` appear inside transitive-dep entries (e.g. `node_modules/yocto-queue`, `node_modules/powershell-utils`) where the `version` field must match the `resolved` URL and `integrity` hash. Edit the two project entries individually.
3. [README.md](README.md) — `Status: v<X.Y.Z> beta` line and the `Summonarr v<X.Y.Z> is a beta release` line under Beta testing.
4. [docker-container/README.md](docker-container/README.md) — both `SUMMONARR_VERSION=v<X.Y.Z>` examples (env table row and the "Pin to a specific version" code block).
5. [README.md](README.md) `## Changelog` — **prepend** a new `### v<X.Y.Z>` block above the previous release. Group bullets under `**Added**` / `**Changed**` / `**Fixed**`. Source the entries from `git log v<previous>..HEAD --oneline`, surfacing only user-visible changes (skip `chore`, `refactor`, `deps`). Conventional-commit scopes (`feat(issues): …`, `fix(play-history): …`) translate cleanly.

Then tag and push:

```bash
git commit -am "chore(release): v<X.Y.Z>"
git tag v<X.Y.Z>
git push && git push --tags
```

The `v<X.Y.Z>` push triggers [.github/workflows/docker-publish.yml](.github/workflows/docker-publish.yml), which builds and publishes the GHCR image with `<X.Y.Z>`, `<X.Y>`, `<X>`, and `latest` tags. **Do not** push the tag before the README/package version edits land — users pulling `v<X.Y.Z>` will get an image whose `package.json` reports the previous version.

There is no version constant in `src/`. Don't add one to "fix" this — the package.json field plus the git tag is the source of truth, and adding a third copy just creates another place to forget.

## Guardrails

1. **Next.js 16 is not the Next.js in your training data.** Before editing routing, caching, metadata, `fetch`, server/client boundaries, or anything framework-shaped, read the relevant file under [node_modules/next/dist/docs/](node_modules/next/dist/docs/) (`01-app/`, `03-architecture/`). Do not pattern-match from Next 13/14/15 memory.

2. **Never remove the `?token=` webhook query param.** Sonarr and Radarr webhook UIs have no header field, and the Plex/Jellyfin handlers share the same code path. Keep the timing-safe compare. Do not "upgrade" to HMAC — the upstream services do not sign requests.

3. **Schema-first Prisma.** No migrations directory exists. Schema changes are applied with `prisma db push`, then `prisma generate`. Do not scaffold `prisma migrate` workflows.

4. **Bulk writes must use `batchCreateMany` + `BATCH_TX_TIMEOUT`.** Raw `createMany` on library-sized datasets blows transaction timeouts. Always chunk via `batchCreateMany` and pass `{ timeout: BATCH_TX_TIMEOUT }` to `$transaction`.

5. **Do not lower `ARR_FETCH_MAX_BYTES` (50 MB)** and do not bypass `arrFetch` with bare `fetch` for Radarr/Sonarr calls. The cap exists because large libraries silently truncated at 10 MB.

5a. **Pick the right `safe-fetch` helper.** Never call `fetch` directly for outbound HTTP. Hardcoded third-party URL → `safeFetchTrusted(url, { allowedHosts: [...] })`. URL persisted in `Setting` (Radarr/Sonarr/Jellyfin/Plex server) → `safeFetchAdminConfigured(url)`. URL from end-user input → `safeFetch(url)`. The `allowedHosts` arg on `safeFetchTrusted` is required and exists so a future code change can't accidentally fan that path out to user-controlled hosts.

6. **Route all cron/sync handlers through `isCronAuthorized`.** Do not re-implement `CRON_SECRET` checks inline.

6a. **User-session API routes must use `requireAuth` from [src/lib/api-auth.ts](src/lib/api-auth.ts).** Do not re-implement `auth() + isTokenExpired() + role` boilerplate inline. Callsite:
    ```ts
    const session = await requireAuth({ role: "ADMIN" });
    if (session instanceof NextResponse) return session;
    ```
    Semantics: 401 for missing/expired session, 403 only for wrong role. Options: omit `role` for any-authenticated-user; `role: "ADMIN"` requires ADMIN; `role: "ISSUE_ADMIN"` accepts ADMIN or ISSUE_ADMIN. Does not apply to cron/sync routes (use `isCronAuthorized`) or routes that return plain-text/binary responses (SSE, thumbnails) — those stay inline.

7. **No success logs.** `console.error` and `console.warn` only, namespaced with a `[scope]` prefix. Silent success is the convention. Do not add `console.log` for happy-path events.

8. **No tests, no typecheck script.** Do not fabricate either. If you need verification, run `npm run lint` and `npx tsc --noEmit` explicitly and say what you ran.

9. **Keep state management minimal.** Don't introduce Zustand/Jotai/Redux/TanStack Query to "clean up" components. URL search params + `useState` is the house style.

10. **Keep data fetching to REST + server components.** Don't introduce tRPC, server actions, or GraphQL without discussion. Client components use `fetch('/api/…')`; server components call Prisma directly.

11. **Conventional commits with scopes.** `type(scope): subject`. Types: `feat`, `fix`, `perf`, `refactor`, `chore`, `revert`. Scopes used in history: `plex`, `jellyfin`, `sonarr`, `arr`, `sync`, `logging`, `play-history`, `debug`, `admin`, `docker`, `deps`. Match the style when committing.

12. **Never edit [src/generated/prisma/](src/generated/prisma/).** It's Prisma client output. Regenerate with `prisma generate` instead. TODO/@deprecated comments in there are upstream noise — ignore them.

13. **Do not mix `recentOnly` and `full` semantics.** `recentOnly` is insert-only within the 2-hour window; `full` deletes + replaces inside a transaction. A `deleteMany` on the recentOnly path will nuke the library when the window is empty.

14. **Respect the `notifiedAvailable` CAS.** The sync orchestrator relies on a compare-and-swap to fire "now available" notifications exactly once when Plex and Jellyfin run concurrently. Don't replace it with a plain update.

15. **The `stillPending` snapshot is taken once per sync run.** If you add a third source to the orchestrator, remember that changes made by the Plex pass won't be visible to the Jellyfin pass within the same run — that's intentional.

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
1. Hit [GET /api/admin/debug/arr-state?tmdbId=<id>&type=movie|tv](src/app/api/admin/debug/) first — it dumps cache rows, live ARR check, `tvdb→tmdb` mapping, wanted-table counts, and the last `LIBRARY_SYNC` audit row. Built for exactly this (commit `81ee465`).
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
- `ActiveSession` — written by Plex *and* Jellyfin webhook handlers.

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

- `88c20c5` — success logs intentionally silenced.
- `3dcbd79` — Plex + Jellyfin sync parallelized; shared `stillPending` snapshot; `recentOnly` for Jellyfin.
- `c7902db` — `arrFetch` body cap raised to 50 MB.
- `803cd11` — activity calendar `$1` offset fix.

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
