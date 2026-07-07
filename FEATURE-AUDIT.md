# Summonarr — Missing Feature Audit

_Audit date: 2026-07-07. Scope: competitor parity, incomplete internals, UX/polish, ops/hardening. Evidence is `file:line` against the current tree; no code was changed by this audit._

## How to read this

Priority reflects user/operator impact and risk, not effort:

- **P1** — user-facing gap vs. peer apps, or a correctness/ops risk that can bite silently.
- **P2** — meaningful gap; noticeable but with a workaround or limited blast radius.
- **P3** — cleanup, polish, or nice-to-have.

Effort is a rough T-shirt size (S / M / L).

### Summary

| Area | P1 | P2 | P3 |
|---|---|---|---|
| Competitor parity | 2 | 2 | 2 |
| Incomplete internals | 1 | 4 | 3 |
| UX / polish | 1 | 3 | 3 |
| Ops / hardening | 2 | 4 | 3 |

**Top 6 to consider first:** watchlist + Plex-watchlist auto-request (parity), a real `/api/health` readiness probe (ops), a unit-test layer for the multi-writer sync logic (ops), a global toast + in-app notification inbox (UX), error monitoring + structured logs (ops), and retiring the inert `serverMachineId` scaffolding + dead NextAuth schema (internals).

### What's already at parity (so it isn't mistaken for missing)

Summonarr already matches most of the Overseerr/Jellyseerr core: request management, a granular permission system, **per-user request quotas** (`movieQuotaLimit` / `tvQuotaLimit` + rolling-window days + `QUOTA_UNLIMITED`, `src/lib/quota.ts`), separate **4K** Radarr/Sonarr instances, an **issues** system, Plex + Jellyfin library scan and play-history, similar/recommendations discovery, an admin **blacklist**, **trash-guides** custom-format management, OIDC/Plex/Jellyfin auth, and a native iOS app (bearer auth). Discovery lists are enriched via Trakt/MDBList/OMDB.

---

## 1. Competitor parity gaps (vs. Overseerr / Jellyseerr)

### P1

**1.1 — No watchlist / favorites / bookmarks.** `[M]`
There is no way to save a title for later without filing a request. Grep for `watchlist|favorite|bookmark` across `src/` (excluding generated code) returns zero hits. Both Overseerr and Jellyseerr expose a per-title watchlist/blacklist affordance on movie/TV pages. This is the single most conspicuous missing discovery affordance.

**1.2 — No Plex Watchlist auto-request sync.** `[L]`
Overseerr syncs users' Plex watchlists at randomized ~15–20 min intervals and auto-requests eligible titles. Summonarr's Trakt integration (`src/lib/trakt.ts`) only powers discovery lists (popular/trending), not a personal watchlist → auto-request pipeline. This is a headline "set it and forget it" feature for the app class.

### P2

**1.3 — Limited notification agents.** `[M per agent]`
Delivered channels: Email (`src/lib/email.ts`), Discord (`src/lib/discord-notify.ts`), Web Push + iOS APNS (`src/lib/push.ts`). Overseerr/Jellyseerr additionally ship **Telegram, Slack, Pushover, Pushbullet, Gotify, LunaSea, and a generic Webhook**. A generic outbound webhook and Telegram are the highest-leverage additions (a webhook alone lets power users bridge anything).

**1.4 — Only two ARR instances per service.** `[L]`
The ARR layer supports HD + one optional 4K instance per service (`src/lib/arr.ts:122-160`, settings keys `radarrUrl`/`radarr4kUrl`/`sonarrUrl`/`sonarr4kUrl` only). Overseerr supports multiple Radarr/Sonarr servers with default selection and tag-based routing. Users running per-genre or per-library instances can't model that here.

### P3

**1.5 — No per-request tagging in Radarr/Sonarr.** `[M]`
Overseerr tags each grabbed request with the requesting user, so admins can filter media by requester inside Radarr/Sonarr. Summonarr's add-to-ARR path (`src/lib/arr.ts`) sets no requester tag.

**1.6 — Blacklist is admin-global only.** `[M]`
`admin/blacklist` blocks titles globally; there's no user-facing "hide/block this title" control on media pages (Jellyseerr 2.x added a per-title blacklist button). Different scope than the admin tool.

---

## 2. Incomplete / half-built internals

### P1

**2.1 — `serverMachineId` cross-server verification is inert scaffolding.** `[S to remove / M to finish]`
`MediaServerMismatchError` and its verification branch (`src/lib/play-history.ts:124-136`, `:199-215`) never run: both poller call sites omit `serverMachineId` (`src/app/api/sync/play-history/route.ts:152,463`), so the field is always `null`. Worse, the schema doc still claims webhook handlers verify it (`prisma/schema.prisma:668-671`) — those webhook handlers were removed. Either finish the check or delete the scaffolding and fix the stale doc; today it reads as an active security control that does nothing.

### P2

**2.2 — Jellyfin self-service notification-email verification is missing.** `[M]`
The only genuine `TODO` in hand-written `src/`: `src/app/api/profile/notifications/route.ts:111-118`. A Jellyfin user whose server account has no email gets a `403` and simply cannot set a notification address — the verification flow to bind a self-supplied email was deferred pending outbound-mail infra.

**2.3 — Native refresh-token grant deferred (Phase 3).** `[M]`
No refresh-token endpoint exists; bearer/native clients ride a fixed-lifetime session JWT to expiry then must re-authenticate (CLAUDE.md guardrail 6b). The one Phase-N item that is genuinely still unbuilt in code.

**2.4 — Native API surface under-documented / OpenAPI drift.** `[M]`
~8 routes that serve the iOS app are absent from the hand-maintained OpenAPI spec: `admin/library/bad-matches`, `discord/status`, `discord/unlink`, `media/[type]/[tmdbId]`, `play-history/calendar`, `play-history/transcode-offenders`, `config/public`, `report`. Because `src/app/api/openapi/route.ts` is hand-written (not generated), it can silently diverge from the ~131 real handlers — no CI check enforces parity.

**2.5 — Debug `arr-state` endpoint is HD-only.** `[S]`
`src/app/api/admin/debug/arr-state/route.ts:35` — the pipeline-dump diagnostic can't inspect the 4K variant, even though 4K requests are live end-to-end. Directly weakens the "query real API responses before diagnosing" workflow for 4K badges.

### P3

**2.6 — Two 4K auto-approve permission bits have no UI.** `[S]`
`AUTO_APPROVE_4K_MOVIE` / `AUTO_APPROVE_4K_TV` (`src/lib/permissions.ts:53-54`) are defined but the admin permission editor's 4K group only renders 4 of 6 bits (`src/components/admin/user-table.tsx:290-298`) — those two granular auto-approvals can't be set from the UI.

**2.7 — Dead schema + stale "Phase 3 / dormant" comments to prune.** `[S]`
NextAuth legacy models `Session` and `VerificationToken` are never created (only defensively `deleteMany`'d). Columns `User.autoApprove`, `User.quotaExempt`, `User.emailVerified` are effectively dead (superseded by permission bits; only read by the schema-drift checker/migration). `FeatureDefinition.note` is declared but never set. Multiple comments still call 4K "dormant/deferred until Phase 3" though it's fully shipped (`src/lib/permissions.ts:46-48,128`, `src/components/admin/user-table.tsx:288-289`, CLAUDE.md).

**2.8 — Possibly-orphaned ops routes.** `[S]`
`src/app/api/admin/server-users/diagnose/route.ts` and `src/app/api/cron/trash-diagnostic/route.ts` have no UI trigger and (for the latter) no wiring into the docker `_cron_loop`, unlike `trash-sync`. Either wire them up or document them as operator-curl-only.

---

## 3. UX / polish gaps

### P1

**3.1 — No global toast and no in-app notification center.** `[M]`
There is no toast system anywhere (`sonner`/`toast` unused); all feedback is component-local inline text (e.g. `src/components/media/request-button.tsx:149-163`), so it's inconsistent and can be lost when a component optimistically mutates and re-renders. There is also no persistent in-app inbox of "your request was approved/available" events — a user who misses the push/email has no history surface (`push-notifications.tsx` is enable/disable only). Peer apps surface request status in-app.

### P2

**3.2 — Missing loading skeletons on the heaviest pages.** `[M]`
The `movies` and `tv` list pages (cold TMDB multi-page fan-out) have neither `loading.tsx` nor `<Suspense>` — first load blocks navigation with no feedback. 20 admin route dirs also lack `loading.tsx` (incl. `admin/library`, `admin/audit-log`, `admin/stats`, `admin/users`, `admin/backup`, `admin/trash-guides/*`).

**3.3 — Coarse error boundaries.** `[S]`
Only `src/app/(app)/error.tsx` and `src/app/global-error.tsx` exist. A render error in any admin page unmounts the whole `(app)` subtree to the generic boundary; a per-section `admin/error.tsx` would isolate failures.

**3.4 — Notification reachability on a default install.** `[S]`
The email opt-in section is hidden unless the operator enables the feature and configures a transport (`src/components/profile/notification-prefs.tsx:9-12`). On a fresh install users effectively have only Web Push (browser-permission-gated, and iOS-Safari-limited) and Discord (requires linking). Worth reconsidering defaults or surfacing setup guidance to users.

### P3

**3.5 — No shared `EmptyState` component.** `[S]` Empty states are good but hand-rolled per page (e.g. `src/app/(app)/requests/page.tsx:167-185`), so treatment drifts subtly.

**3.6 — One unwrapped table on mobile.** `[S]` `src/components/admin/activity-history-table.tsx:1039` renders a `<table>` without the `overflow-x-auto` wrapper the other tables use (`audit-log-table.tsx:495`, `cron-job-table.tsx:66`) — likely to overflow narrow viewports.

**3.7 — No internationalization.** `[L]` No i18n library or message catalogs; every user-facing string is hardcoded English inline. Full localization would be a from-scratch effort.

---

## 4. Ops / hardening gaps

### P1

**4.1 — `/api/health` is trivial and is the container healthcheck.** `[S]`
`src/app/api/health/route.ts:3-5` returns `{ ok: true }` with no DB ping or upstream probe, and it's exactly what the Docker/compose `HEALTHCHECK` targets (`Dockerfile:176-177`, `docker-compose.yml:66-67`). A container whose Postgres connection is dead still reports **healthy**. Add a real readiness check (DB ping at minimum; optional upstream reachability), ideally split liveness vs. readiness.

**4.2 — No unit/integration test suite.** `[L]`
Zero `*.test.ts`/`*.spec.ts`; the only automated coverage is the headless E2E route crawl (hydration smoke) + a security smoke test. The correctness-critical, multi-writer logic that CLAUDE.md guardrails 13–21 are entirely about — `recentOnly`/`full` sync, the `notifiedAvailable` CAS, stall detection, boot re-anchor, the vote/request transaction rules — has no assertion-level tests. CI stays green while this logic regresses.

### P2

**4.3 — No error monitoring; unstructured logs.** `[M]`
No Sentry/Bugsnag/Rollbar/Datadog integration. Logging is namespaced `console.error`/`console.warn` (not JSON, no request/correlation IDs, no levels beyond error/warn, success intentionally silent). Runtime exceptions surface only to container stderr with no aggregation, grouping, or alerting.

**4.4 — No metrics / tracing.** `[M]`
No Prometheus `/metrics` endpoint and no OpenTelemetry tracing (`instrumentation.ts` only validates env). Cron run stats live in `Setting` rows shown in the admin UI, not machine-scrapeable.

**4.5 — Rate limiting is in-memory, single-process.** `[M]`
`src/lib/rate-limit.ts:16` uses a per-process `Map` — it resets on every restart/redeploy and does not coordinate across replicas. Without `TRUST_PROXY=true`, per-IP limiting degrades to one shared UA-hash bucket. Fine for the single-container default; silently ineffective if ever scaled horizontally.

**4.6 — Backups are manual-only, untested round-trip.** `[M]`
Export/restore is complete and encrypted (`src/app/api/admin/backup/*`) and includes settings (they live in the `Setting` table), but it's admin-triggered only — no scheduled/automated backup, no off-box destination, and no restore round-trip test in CI. Recovery depends on an operator remembering to download.

### P3

**4.7 — No admin-editable notification templates.** `[M]` Email subjects/bodies are hardcoded (`src/lib/email.ts:412,458,571,…`); admins can't customize wording/branding beyond the site title.

**4.8 — Thin admin operations surface.** `[M]` No runtime/application log viewer (the audit log tracks user actions, not `console.error`); cron monitoring is display-only with no "run now"/retry for most jobs; no admin-side per-user notification test/resend.

**4.9 — CI coverage gaps.** `[S]` CI is broad (lint, `tsc --noEmit`, route-auth audit, license check, CodeQL, Trivy, gitleaks, scorecard, zizmor) but has no accessibility/Lighthouse check and no OpenAPI-spec ↔ route parity check (feeds 2.4).

---

## Sources

Competitor feature references:

- [Overseerr — GitHub](https://github.com/sct/overseerr) · [Seerr docs](https://docs.seerr.dev/) · [Seerr](https://seerr.dev/)
- [Watchlist Auto Request — Seerr docs](https://docs.seerr.dev/using-seerr/plex/watchlist-auto-request/) · [Auto-request 4K from watchlist (#3849)](https://github.com/sct/overseerr/issues/3849)
- [Jellyseerr / seerr-team releases](https://github.com/seerr-team/seerr/releases) · [Tag-based blacklist filtering (#1076)](https://github.com/seerr-team/seerr/issues/1076)
- [Overseerr guide & Jellyseerr comparison — RapidSeedbox](https://www.rapidseedbox.com/blog/overseerr-guide)

Codebase evidence: `file:line` references throughout are against the working tree as of the audit date.
