# Summonarr

Self-hosted media request aggregator. Browse TMDB (trending, popular, discover, upcoming), request movies and TV, vote on requests, and file issues. Admins approve requests and auto-fulfill via Radarr/Sonarr. Summonarr ingests Plex and Jellyfin libraries plus play history, so users see availability, active sessions, and watch activity in one place.

> **Status:** v0.23.0 beta — feature-complete for the initial release. **Beta testers wanted** — see [Beta testing](#beta-testing).

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
- Radarr and Sonarr webhooks for instant request fulfillment (Plex activity via a real-time SSE stream, Jellyfin via a 5-second poller — no Plex/Jellyfin webhook needed)
- Optional Discord (bot), SMTP/Resend email, and ratings providers (OMDb, MDBList, Trakt) — all configured in-app
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

The Dockerfile is a five-stage build (deps → prisma-gen → builder → migrate-deps → runner), produces a Next.js standalone bundle, runs as non-root `nextjs:nodejs` (UID 1001), and strips `npm`/`npx` from the final image to eliminate npm-bundled CVEs.

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
# Then fill in the boot-required secrets:
#   NEXTAUTH_SECRET       (≥ 32 chars)
#   CRON_SECRET           (≥ 32 chars)
#   TOKEN_ENCRYPTION_KEY  (exactly 64 hex chars — `openssl rand -hex 32`; the app
#                          exits at boot without it)
#   AUTH_URL, TMDB_READ_TOKEN, TRUST_PROXY
# Optional sign-in: OIDC_ISSUER / OIDC_CLIENT_ID / OIDC_CLIENT_SECRET (see
# docker-container/README.md → Connecting external services → OIDC / SSO).

npx prisma db push    # apply schema (no migrations folder)
npx prisma generate   # regenerate client (outputs to src/generated/prisma)
npm run dev
```

App runs at <http://localhost:3000> in dev mode.

Available scripts:

```bash
npm run dev                # next dev
npm run build              # next build
npm run start              # next start (production)
npm run lint               # eslint
npm run typecheck          # native TS 7 (tsgo) type-check
npm run typecheck:classic  # classic TS 6 — the compiler `next build` uses
npm test                   # node:test unit suite (tests/*.test.mts)
npm run audit:deps         # custom TypeScript dep audit
```

The unit suite (`npm test`) uses Node's built-in `node:test` runner and covers
the pure/in-memory surfaces of `src/lib` (auth, crypto, network policy, leaf
logic). It never touches a live database or the network — sync/webhook/DB/route
behaviour is exercised by the CI end-to-end crawl instead.

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
- For internet-facing deployments, follow the operational hardening checklist — proxy log redaction for webhook tokens, blocking `/api/setup/*` until first-run completes, `CRON_SECRET` / machine-session handling, APNs relay trust, and file-mounted secrets — in [`docker-container/README.md`](./docker-container/README.md#security-hardening-operational).

## Privacy

Summonarr is self-hosted: the developer operates no servers and collects no data. The iOS app talks only to the server you run and to TMDB's image CDN for artwork. See [`PRIVACY.md`](./PRIVACY.md) for the full policy (also used as the App Store privacy policy URL).

## Changelog

### v0.23.0

The remediation release: 102 verified findings from a full-tree review, closed across fifteen waves.

**Added**

- Jellyfin titles that appear in more than one library now keep every copy's item id, so a duplicated show no longer loses one copy's entire episode set.
- `/api/sync` reports `skippedSources` alongside `failedSources`, so a client can tell "this server was never configured" apart from "this server failed".
- Admin audit-log rows can be PII-scrubbed on demand, matching the scheduled scrub.

**Changed**

- Browse pages run the discover pipeline once per filter change instead of twice.
- `/popular` bounds its TMDB fan-out; the watch-activity ranking stays global across all servers by design.
- Database exports walk each table by keyset rather than LIMIT/OFFSET — roughly 14s to 0.5s on a 300k-row table, with byte-identical output.
- Bearer (native app) requests reuse the refreshed session token, halving their per-request session database cost.
- The OpenAPI document now matches the API: six undocumented operations added, and the audit-log, requests, votes, play-history, health and config entries corrected.

**Fixed**

- Database restores failed outright on any Jellyfin library row, because array columns were exported in the wrong format. The export looked successful and the restore rolled back everything.
- Email could hang forever against a silent SMTP relay, leaking the connection and permanently wedging the notification queue. Bare SMTP reply codes also cost a hidden 30 seconds per message while reporting success.
- A restart could mark a still-playing Plex stream as stopped and never show it again.
- Revoking one device's session no longer signs out every older native session.
- Deleting a grouped play now really removes it, instead of the play returning on reload with corrupted progress.
- Deactivated accounts no longer receive iOS push notifications.
- "Hide available" now hides only what you can actually watch, and agrees between the first page and every page after it.
- The play-history settings form could not be saved on a default install.
- Feature toggles no longer trip the admin rate limit and silently roll back.
- Failed actions in the UI surface an error instead of leaving a spinner.
- Sync buttons no longer report failure when a media server simply is not configured, nor success when a configured one genuinely fails.
- Discord's request flow matches the web routes; role sync no longer touches never-linked or deactivated accounts.
- Sonarr lookups no longer match the wrong series, and a large library no longer silently skips the episode-cache rewrite.
- Chart day labels no longer shift by a day for users east of UTC.
- Play-history search treats `%` and `_` as literal characters.
- Several UI elements lost a border or background to a class-merging bug.
- Security scanning can no longer pass green when the scanner itself fails.

### v0.22.1

**Fixed**

- **Now-playing failed for native clients.** The endpoint the iOS app reads for active sessions returned an error whenever anything was actually playing, which took the whole Activity dashboard down with it. The web dashboard was unaffected, so this only showed up in the app.

### v0.22.0

**Added**

- **A personalized "For You" page.** A dedicated browse page (and a home-screen rail) of recommendations built from your own watch history and watchlist, with a filter to show only titles already on your server — or only the ones that aren't yet. It's **off by default**: turn it on in Admin → Settings → Features, and the picks fill in over the first day as the background job builds them. Native apps get the same set through the API.
- **Per-instance Radarr minimum availability and Sonarr v3 language profiles.** Each named Radarr/Sonarr instance can now carry its own minimum-availability setting, and named Sonarr v3 instances their own language profile.
- **Per-server path-strip prefixes for named media instances.** Each named Plex/Jellyfin server can define its own movie/TV path-strip prefix from the media-instances manager.
- **Audit-log privacy controls.** A one-click scrub button, a configurable PII-retention window, and fuller human-readable detail summaries on each entry.
- **An optional reason field when blacklisting a title.**
- **A recurring library-cache warm.** A daily background job keeps the browse/library cache warm on long-uptime servers instead of letting it decay between restarts (tunable via `WARM_LIBRARY_INTERVAL`).

**Changed**

- **"For You" recommendations are sharper.** Suggestions come from TMDB's behavioral recommendations engine rather than keyword-similar titles, seeded from a wider slice of your recent watching plus your watchlist — so even a few-watches-a-month viewer gets a full, relevant set.

**Fixed**

A large reliability pass across the Radarr/Sonarr and Plex/Jellyfin integrations, including:

- **Ended TV series with unmonitored episodes or specials now flip to Available correctly** (they could previously stay stuck "requested" forever).
- **The Jellyfin "is this on the server yet?" check works again** — it was effectively always answering "yes", so Jellyfin-only setups notified before an import had actually landed.
- **Jellyfin sign-in and sync keep working on Jellyfin 10.12**, which disables the legacy auth headers Summonarr had been using.
- **The Plex server owner's watch history is attributed to their account** instead of going unlinked.
- **Resumed, pause-heavy playback records accurate watch and pause time** instead of over-counting.
- **Movie "awaiting release" vs "download pending" messaging uses the real digital/physical release dates** rather than the theatrical date.
- **Approving a title already present in Radarr/Sonarr re-monitors and searches it** instead of leaving the request stuck.
- **Radarr/Sonarr delete webhooks clear stale availability immediately** instead of waiting for the next full sync.
- **The Jellyfin "Sync Library" button in settings runs a full resync.**
- **Metadata ratings**: closed an OMDB rate-limit lockout gap and cut a large amount of redundant upstream traffic (TMDB / OMDB / MDBList / Trakt).
- **The Discord `/link` command self-heals.** Slash commands now re-register automatically on the first boot after an upgrade that changed them (hash-guarded, so an unchanged schema makes no Discord call) — so a fix like the `/link` token's 20→32 character limit takes effect without a manual "Register commands" click. If your server still shows the old 20-char limit after upgrading, set a **Server (Guild) ID** in Discord settings for instant per-server registration, or restart the Discord client to clear its cached command list.
- Plus many more correctness and efficiency fixes across library sync, the play-history poller, webhooks, TRaSH-Guides sync, connection tests, and fix-match.

**Dependencies**

- Bumped the Node base image, several GitHub Actions (CodeQL, zizmor, docker/login), and a group of patch-level app dependencies (Prisma, React, jose, and type definitions).

### v0.21.0

**Changed**

- **Action required before upgrading if you run without a reverse proxy.** Add `SUMMONARR_ALLOW_LOCAL_ONLY=true` to your `.env` if `TRUST_PROXY` is unset or `false` — the app now refuses to start in local-only mode without it, and the startup log names the same variable if you hit it. The reason: local-only mode is guarded solely by the `Host` header the *client* sends, and `Host` is trivially spoofed, so it was never a real barrier — anything that can reach the port can claim a private `Host` and be served. Setting the variable is you confirming the host is genuinely private (LAN-only, bound to loopback, or firewalled), with your network providing the access control. **If Summonarr is reachable from the internet, put it behind a reverse proxy and set `TRUST_PROXY=true` instead** — that is the supported shape, and it cannot be substituted with the new opt-in. **Deployments already running `TRUST_PROXY=true` are unaffected and need no change.**

**Fixed**

- **The Discord `/link` command accepts your token again.** Saving anything in Admin → Settings re-registered the slash commands with a 20-character limit on the link token, while the tokens minted on your Profile page are 32 characters — so Discord rejected every token before the command even ran, and the fix applied by the **Register commands** button was undone by the next settings save. After upgrading, hit **Register commands** once (or save any Discord setting) to publish the corrected command.
- **Pinning a Docker image version works.** The documented `SUMMONARR_VERSION=v0.20.2` spelling pointed at a tag that does not exist — published tags are bare semver — so the pull failed with `manifest unknown`. Drop the `v`: `SUMMONARR_VERSION=0.21.0`.
- **Large libraries no longer re-sync every five minutes.** If a full library sync took longer than five minutes — normal once a library gets big — the internal cron scored it as *failed* even though it had completed, and retried it five minutes later. It then failed the same way every time, so the hourly sync silently became a permanent every-five-minutes cycle, each one deleting and re-inserting the whole library. Symptoms were constant database write activity, a container log dominated by sync output, and Plex/Jellyfin being polled far more than intended. The sync now waits for the run to actually finish, so it returns to the hourly schedule; a genuinely stuck run is still caught and retried. No configuration change is needed, and the timeout is adjustable with `CRON_CALL_TIMEOUT` if you need to.
- **Quieter, more honest sync logs.** `full sync trigger failed: This operation was aborted` was logged whenever a Plex-triggered sync ran past the trigger's 30-second wait — but nothing had failed; the sync was still running and completed normally. It now says so instead of reporting a failure. Separately, titles whose Plex entry maps to more than one TMDB record were logged once per title on every sync; they are now summarised in a single line.

### v0.20.2

**Fixed**

- **"Remember me" now actually keeps you signed in.** Non-admin sessions were only ever shortened and never re-extended, so a browser session expired about an hour after sign-in no matter how much you were using it — the longer session lengths in settings were unreachable.
- **The admin Library page no longer invents TV mismatches, or hides real ones.** With the usual `/data/movies` + `/data/tv` layout every TV row collapsed onto a single entry, so at most one TV title was ever compared. Genuine mismatches were invisible, and two correctly-matched libraries could produce a false mismatch pairing two unrelated shows — which, if acted on, re-pointed a correct show at the wrong TMDB entry.
- **TV rows on the admin Library page now show their Sonarr status.** The lookup checked the season folder against Sonarr's series path, so a TV row never resolved a verdict at all.
- **Plex sign-in returns you to the page you started from** instead of always landing on the home page.
- **Requests are no longer starved on a server that has never synced cleanly.** The 24-hour fallback meant to notify you anyway could never engage.
- **Requests no longer stay stuck as Available** on deployments where a registered media server was never configured — that permanently blocked the change back to Approved.
- **A request Sonarr has already accepted is no longer rolled back to Pending** by a failure in the bookkeeping write that follows it.
- **Rating badges survive a provider outage.** The hourly cache clean-up was deleting the very rows the fallback relies on.
- **A frozen Plex stream is detected again.** A small playback-position correction counted as movement, so the stall detector never fired and a dead session could sit on the now-playing card indefinitely.
- **Completion-rate stats no longer merge unrelated unmatched titles** into a single viewing arc.
- **Deactivated accounts no longer receive "download pending" Discord messages.**
- **Notification-email verification works when signed in on a named Jellyfin server** — it always checked the default server.
- **Quality-profile lists respect per-user instance access**, which also stops them revealing which named instances exist.
- **Movie and TV detail pages check your session before fetching**, so an unauthenticated request cannot consume TMDB or OMDB quota.
- **Removing a media server no longer carries its library selection onto the next server** in the list.
- **The user-search box no longer bounces you back** to the list you just navigated away from.
- **Posters no longer occasionally show a film's artwork on a TV row** that shares its TMDB id.
- Smaller fixes: a malformed request token returned a server error instead of a permission error, a vote-cleanup write could silently never run, and season views issued one unbounded database write per episode.

**Changed**

- **The Top page no longer waits on missing ratings before rendering.** Titles whose ratings are not cached yet drop out of a minimum-IMDb filter on the first load and appear on the next — matching how the mobile app already behaves.
- **External ratings refresh shortly before they expire** rather than only after, so a rating is less often missing on first view. This uses somewhat more of the daily OMDB quota.

### v0.20.1

**Fixed**

- **The admin Activity page lost the title on every now-playing session.** A key mismatch introduced in v0.20.0 meant the resolved TMDB id was never found, so sessions fell back to a title-only match — which can match the wrong media type, and that wrong id was then saved permanently.
- **Turning off play-history tracking now actually stops it.** The Plex event stream stayed open after the setting was disabled and kept recording watch history.
- **High-bitrate streams no longer vanish from the bandwidth stats.** Anything above 100 Mbps — a 4K remux, typically — was recorded at a thousandth of its real bitrate, so the heaviest sessions were missing from the figures meant to show them. Bandwidth totals are also now exact rather than ~2% out.
- **An admin unlinking a server identity now actually hides that watch history.** The unlink appeared to do nothing because the history was still resolved through the provider id.
- **Requests are no longer wrongly marked unavailable** when a media server is registered but its connection details have been cleared — its library was silently left out of the check.
- **"Now available" emails are no longer dropped** when several land at once. They were opened faster than mail relays accept connections, and the notification is only sent once, so those emails were lost for good.
- **Users with the Manage Issues permission can see fix-match thumbnails.** Every thumbnail returned an error unless the account also had the Issue Admin role.
- **Admins are no longer notified about their own issue resolutions** over Discord and push.
- **Watch-history detail no longer merges two servers' items** that happen to share an id, and completion-rate stats no longer merge unrelated unmatched titles into one.
- **The "busiest day" figure now matches the chart above it** — it was counting abandoned starts the chart excludes.
- Several smaller hardening fixes: rate limits that could be widened by changing a browser header, an unbounded Plex library fetch, a stats cache key that could return another filter's data, and a migration script that pointed at a recovery flow which does not exist.

### v0.20.0

**Added**

- **Resync a single named media server.** The admin Resync buttons can now target any registered Plex/Jellyfin server rather than only the default one. Previously a named server could only be synced by waiting for the full orchestrator run.
- **Per-server Plex reachability.** The connection badge reports each configured Plex server independently, so one unreachable server no longer makes the whole integration look down.

**Fixed**

- **A TMDB outage no longer wipes everyone's recommendations.** The warm job replaces each user's stored list, and an outage produced an empty result that looked identical to "nothing to recommend" — so the list was cleared and the run reported success. An inconclusive result now keeps the existing recommendations.
- **Restricted servers no longer leak through a named resync.** Resyncing a named server re-filed its entire library under the default server, which is visible to everyone — exposing a restricted server's catalogue to users with no grant, and leaving the named server with no library rows until the next full sync.
- **Requests are no longer marked available from a server you cannot see.** A restricted server could flip a request to Available and send the "ready to watch" notification to users without access, and the once-only notification was consumed so the legitimate one never arrived.
- **A dropped database connection no longer takes the app down.** Any scheduled job holding the coordination lock crashed the whole process if PostgreSQL restarted or the connection was reaped mid-run.
- **Library selection is applied per server.** One server's selected libraries were being applied to every configured server.
- **The shared TV episode cache is rebuilt from every server.** A resync or episode refresh could wipe another server's episode data until the next full sync.
- **Clearing a webhook secret now works.** The settings page reported "Saved" while the old secret stayed valid, so revoking or rotating one silently did nothing. The field's description was also wrong: leaving it blank turns the webhook off, it does not disable authentication.
- **Issue "Refetch" searches the right Radarr/Sonarr instance.** An issue filed against the 4K copy re-grabbed the HD one and left the reported problem untouched.
- **Removed accounts stop receiving Discord messages.** Disabled accounts still got "awaiting release" and "download pending" notifications.
- **Deleting your data now removes your recommendation profile.** The admin purge left behind the per-user taste profile built from watch history and watchlist.
- **Watch history no longer merges titles across two servers.** Unmatched items from different servers could collapse into one entry with combined play counts and watch time.
- **A permission or role change no longer signs you out.** Editing a user's permissions could invalidate their session on the next page load and bounce them to the login screen.
- **The admin "send test notification" button works with a display-name email address.** It failed on exactly the setups where real notifications worked.
- **Bulk download-policy changes reach the right Jellyfin server**, and the admin Activity page no longer mixes up items with the same id on different servers.
- Several smaller hardening fixes: the machine-session IP allowlist is enforced on every endpoint, malformed request bodies are rejected rather than causing an error, and a stale role could previously let the last admin remove their own account.

### v0.19.0

**Added**

- **API Docs in the admin nav.** The OpenAPI reference at `/admin/api-docs` already existed but nothing linked to it, so it was reachable only by typing the URL. It now appears under Admin, and can be hidden with the new "API Docs page" toggle in Admin → Settings → Features.
- **Jellyfin server picker for the iOS app.** A user whose Jellyfin account lives on a named (non-default) server could not sign in from the app at all — the web login page built its picker in a way native clients had no access to. The app can now list the configured servers and pick one.

**Fixed**

- **Delegated admins were shown pages they cannot open.** Anyone granted Manage Users or Manage Requests received the *whole* admin menu, but 8 of its 11 destinations require full admin and simply bounced them back to the home page. Each entry is now shown only to someone who can actually open it, across the sidebar, the mobile tab bar and the mobile drawer.
- **The Settings link appeared for everyone.** The avatar menu offered Settings to every signed-in user, and it redirected all non-admins home. It is now shown only to admins.
- **The "For You" carousel could never be switched on.** Its toggle was missing from the settings write allowlist, so flipping it reported success, saved nothing and reverted on reload — and since the feature defaults to off, there was no way to enable it at all.
- **An admin could lose the entire admin menu.** An admin account whose permissions had been edited by hand to any other value resolved without the admin capability and saw no admin nav.
- **Admin "new request" push notifications** now open the request itself, where it can be approved or declined, instead of the title's detail page.
- **Fix Match could return the wrong server's result** on a multi-server setup, and Jellyfin sign-in did not validate the server name it was given — a differently-capitalised name resolved one server's connection while checking another's membership, refusing a legitimate first-time user.

### v0.18.0

**Added**

- **Multiple Plex and Jellyfin servers.** Summonarr is no longer limited to one Plex server and one Jellyfin server — you can register as many of each as you like under Admin → Settings → Media → "Additional media servers". Library sync, "now playing", watch history, request fulfilment and sign-in all work across every configured server. A title counts as available if it's on *any* of them, and the admin surfaces label which server each library item, session, watch and server-user came from.
- **Sign in against any of your servers.** Jellyfin's login screen gains a server picker when you've configured more than one; Plex sign-in needs no picker (Plex accounts are global) and now admits anyone who is a friend on *any* of your servers. Each server has its own admin token, its own "restrict sign-in to synced members" setting, and its own membership list.
- **Restricted servers with per-user access.** A named server can be marked **Restricted**, and its library then counts only for users you grant access to (Admin → Users → Permissions → "Media server access"). Ungranted users don't see its titles as available, aren't blocked from requesting them, and their requests are only marked Available — and only notified — once the title is on a server they can actually see. Admins always see everything, and a server left unrestricted behaves exactly as before.
- **A personalized "For You" row** on the home page, built from your own watch history and watchlist. Off by default — enable `feature.page.forYou` in Admin → Settings → Features, and give the background job a cycle or two to warm up first.
- Two admin diagnostics for when something looks wrong: one that explains why an account's watch history is empty, and one that dumps the whole ratings pipeline for a title.

**Changed**

- **Removing an account now disables it instead of erasing it.** Previously, removal scrubbed the account in place, which permanently detached that person's watch history — including anything they kept watching afterwards. Removal now switches the account off (all devices signed out, sign-in refused) while leaving history attributed. Permanent erasure — for a genuine "delete my data" request — is a separate, admin-only, two-step action under Admin → Users.
- De-registering a media server now cleans up the library rows it left behind. Previously those rows lingered forever, so a removed server's entire catalogue kept reading as "in library" everywhere.

**Fixed**

- Fixing a bad Plex/Jellyfin match from the admin library page could rewrite the *wrong* server's library once more than one was configured. Bad-match detection also went silently empty in that situation, reporting "no problems found" when it had simply failed to compare anything.
- Assorted account and notification correctness: accounts removed before this release could be re-enabled into an unusable state; removed and disabled accounts could still receive request and issue notifications; and a purge racing a reactivation could leave an account in an inconsistent state.
- Watch history: rewatches chained incorrectly, a play's group-wide flags were computed over only part of the group, and poster lookups could pick the wrong artwork for a title that exists as both a film and a series.
- Sign-in reliability: a rotated session token wasn't forwarded to the downstream verifier, and Plex sign-in could stall for over a minute per unreachable server.
- Radarr/Sonarr: an empty root folder broke every add on that instance, candidate releases sorted by date as text rather than chronologically, and a failed lookup could be cached as though it had succeeded.
- Docker: a malformed cron interval could silently stop the background jobs, and the health check was wrong when hosting under a subpath.
- Search boxes across the app mishandled `%` and `_`, treating them as wildcards instead of literal characters.
- Security hardening across search inputs, request bodies, URL handling, DNS caching, admin privilege checks and a dependency advisory.

### v0.17.3

**Fixed**

- Machine sessions (Admin → Settings → "Machine session API") were both broken and destructive: the very first request using one failed, and it silently signed the admin it impersonates out of every device. Minting one is now safe.
- Bulk "Request all" could be used to escalate privileges. A user granted "request on behalf of" — without being an admin — could file requests as an admin and thereby skip the approval queue, reach 4K and other restricted instances, and bypass their own content-rating cap and request quota. On-behalf requests are now limited to users no more privileged than the requester.
- A Sonarr "Download" webhook whose two ids disagreed could mark the wrong request Available, notifying a user their show was ready when nothing had downloaded.
- Database backups could silently come out incomplete: a single table the backup couldn't read made every remaining table export as empty, while the download still looked successful. Restoring such a file would have lost data. A backup that can't be taken completely now fails loudly instead.
- Hardened the encrypted-backup restore against a tampered backup file.
- Plex, Jellyfin QuickConnect and OIDC sign-in were all impossible when Summonarr is hosted under a subpath (`BASE_PATH`), along with the notification-email confirmation link and several post-login redirects.
- Setting a user's request quota to `0` silently meant "unlimited" and also removed the global quota for them. It's now rejected with an explanation — clear the user's request permission to stop them requesting.
- An admin declining a request while a library sync was running could have that decline silently reverted.
- Saving Settings when a connection test failed could leave the Discord bot using a rolled-back public key until the app restarted.
- An auto-approved request whose push to Radarr/Sonarr failed no longer goes silently missing — admins are notified so it can be picked up.
- Assorted fixes to ratings caching, notification delivery, per-instance scoping, and rate limiting.

### v0.17.2

**Fixed**

- Completed the log-hardening started in v0.17.1: line breaks in values coming back from Plex, Jellyfin, Radarr, Sonarr or Discord are now removed from server log output rather than turned into spaces, which is what actually prevents a forged log line. v0.17.1 tightened the surrounding cases but left this one open.

### v0.17.1

**Fixed**

- **Security hardening — upgrading is recommended.** Patched two vulnerable dependencies that ship inside the container image: a path-traversal issue in the CSS build toolchain, and a validation bug in a Prisma dependency that is loaded during container startup. Also hardened server-side logging so a value coming back from Plex, Jellyfin, Radarr, Sonarr or Discord can no longer forge extra log lines, smuggle terminal escape sequences into an operator's console, or reverse displayed text.

### v0.17.0

**Added**

- Watch stats: a personal **My Stats** page showing your own viewing at a glance — total plays and watch time, your most-watched titles, a 365-day activity calendar, a day-by-hour viewing heatmap, and your platform and device breakdowns. Every user sees only their own history; requires play-history tracking to be enabled.
- Year in Review: a personal "Wrapped"-style recap linked from **My Stats** — your headline hours, plays and titles for the year, your #1 title, biggest binge day, prime-time day and hour, longest single sitting, finish rate, busiest month, and go-to device, with a year picker to revisit previous years.
- iOS: your personal watch stats are now available to the Summonarr iOS app.
- Cast & people: tapping a cast member now opens a full, shareable **person page** — their photo, bio, and filmography with availability badges and one-tap requesting — replacing the old in-place popup.

**Fixed**

- Plex sign-in errors now show the real cause — an expired sign-in flow, a server error, or a Plex connection that needs re-authorizing — instead of a blanket "you don't have access". A network failure while finishing sign-in also no longer leaves the page stuck on a spinner.

### v0.16.4

**Fixed**

- **Security hardening — upgrading is recommended.** Closed an authentication bypass that could expose the browse/discovery pages to an unauthenticated visitor, an open redirect in the login/OIDC sign-in flow, a server-side request forgery in the admin fix-match thumbnail proxy, and a request-permission check that could be sidestepped by leaving the target instance unspecified. Also tightened admin session lifetime and machine-session IP enforcement, escaped several notification/email/CSV/link output paths, blocked a crafted backup from running arbitrary SQL during a restore, and bounded a number of reads and fan-outs against denial-of-service.
- MDBList ratings populate again — bulk lookups were matched against MDBList's internal id instead of the TMDB id, so no MDBList ratings were being cached.
- The mobile **More** navigation menu no longer crashes the app when opened.

### v0.16.3

**Changed**

- Docker: the runtime image is ~34% smaller (705 MB → 468 MB). The Prisma migrate tooling and unused glibc image binaries are pruned from the shipped container, so pulls and cold starts are faster with no change in behavior.
- Performance: the admin activity page loads disk-space stats in parallel with its other data, live refresh and the admin request list debounce their refresh bursts, and the toast context is memoized.

**Fixed**

- Availability badges: an availability check no longer poisons the cached Radarr/Sonarr verdict for six hours (the two now use separate cache keys).
- Ratings: newly released titles pick up the short "fresh" ratings refresh window, and MDBList list handling tolerates error-bodied 200 responses and no longer mismatches foreign-ID batch lookups.
- Base path: fixed roughly nine links and redirects that ignored a configured `BASE_PATH` (search, cron run-now, cache warm, session terminate, audit export, fix-match thumbnails, the Plex sign-in redirect, and heatmap links).
- Jellyfin QuickConnect: sign-in polling now cancels cleanly and backs off between attempts.
- Auth & sync: settings connection checks return 422 on a bad token, and the Radarr/Sonarr sync routes return 403 to match the rest of the API.

### v0.16.2

**Changed**

- Accessibility: screen-reader announcements for asynchronous actions, focus traps in dialogs, correct menu/ARIA roles, AA-contrast fixes throughout, and a fully keyboard-navigable appearance menu.
- Performance: faster admin request/vote and activity pages and quicker cold discovery loads — new database indexes (admin scans, TmdbCache prefix lookups, Notification unread counts), stabilized play-history pagination, and server pages that no longer wait on serial data fetches (loading skeletons added).

**Fixed**

- Plex/Jellyfin: raised the library-fetch cap to 50 MB so large libraries (over ~3k items) no longer truncate silently.
- Live activity: the Plex event stream recovers the client feed after a permanent failure and only resets its reconnect backoff after staying connected.
- Sync & auth: gate a request's revert/re-push on its own synced instance, stop a dual-library "now available" notification from being skipped, and fix a session-rotation cutoff off-by-one.
- Ratings: the discovery grid's OMDB fallback now matches the detail page, and TMDB detail rows self-heal when cached data is corrupted while preserving certification.
- Requests & instances: reject the reserved "4k" slug from the instance registry, and unify handling when an auto-routed request lands on an instance the user can't access.
- Backup: refuse empty restores and gate chunked setup uploads at chunk 0.
- Admin: a concurrent trash-guides application delete now returns 404 instead of a 500.
- Notifications: web-push messages expire after 24 hours, and SMTP AUTH is refused on unencrypted connections.
- Security: redact Discord tokens that appear in URL paths from logs, and NFKC-normalize new usernames.
- Docker: guard the play-history loop against crashes, honor `.env.local` interval overrides, and drain in-flight work fully on shutdown.

### v0.16.1

**Changed**

- Build toolchain: the codebase is now typechecked by both the classic TypeScript 6 compiler (used by `next build`) and the native TypeScript 7 compiler (`tsgo`), side-by-side. No runtime changes — the shipped app is identical to v0.16.0.

### v0.16.0

**Added**

- Named-instance request surfaces: "Request on ⟨instance⟩" buttons on movie/TV pages, per-user instance access grants in the admin user editor (Permissions & Quota → Instance access), instance chips in the admin request queue, and an approve-time quality-profile picker that reads the request's actual instance.
- Collection "Request all" and Discord `/request` now auto-route to named instances (e.g. anime) the same way single requests do.
- TRaSH Guides can manage every configured Radarr/Sonarr instance — the HD/4K toggle is now an instance picker.
- Jellyfin community-rating badge on detail pages, plus admin toggles to hide any rating source everywhere (Settings → External Ratings → Visible rating badges).
- The issue "Replace" release browser can target any instance, and grab-completion notifications match the instance that grabbed.
- Admin: disk-space stats for every instance, library-diff arr verdicts merged across all instances, and a ratings-state debug endpoint.

**Changed**

- Ratings pipeline overhaul: detail pages now show the full rating set (Letterboxd, MDBList, MyAnimeList, Roger Ebert) on every path, stale ratings serve instantly and refresh in the background, and OMDB daily-quota exhaustion backs off for an hour instead of retrying every request.

**Fixed**

- Top Rated no longer drops Trakt/MDBList-sourced titles that carry no TMDB vote count.
- Most Rewatched on the admin activity dashboard shows posters again.

### v0.15.0

**Added**

- Multiple Radarr/Sonarr instances: run named instances beyond the default and 4K — for example a dedicated **anime** instance. Requests auto-route by content (anime, detected from TMDB, lands on the anime instance) or can target a specific instance explicitly, and access to a named instance can be granted per user.
- Named-instance setup mirrors the main Radarr/Sonarr config: an auto-generated webhook secret with a copyable webhook URL, plus root-folder and quality-profile pickers loaded live from that instance.

**Fixed**

- Backup: fixed a restore stall when an encrypted chunk was smaller than the GCM auth tag, and prevented an in-progress import from being reclaimed on a same-id retry.
- Email: strip CR/LF/NUL characters from notification sender/recipient addresses (header-injection hardening).

### v0.14.0

**Added**

- Watchlist: a personal watchlist — add titles from any detail page and browse them on the new **Watchlist** page.
- "Not interested": hide titles you don't want to see and they drop off every discovery surface (home, movies, TV, search, upcoming, top). Manage them on the new **Hidden** page.
- Title blacklist: admins can blacklist a title, which then shows as unrequestable everywhere — web and Discord — instead of being silently hidden.
- Parental controls: a per-user content-rating cap that blocks requests for titles above a chosen maturity rating, enforced on both the web and Discord request paths.
- Quality profiles: users with the advanced-request permission can pick a Radarr/Sonarr quality profile at request time.
- Requester tags: Radarr/Sonarr adds are tagged with the requesting user, so admins can see who asked for a title.
- Notifications: an in-app notification inbox with a real-time bell and unread badge, a full **Notifications** page (mark-read and clear), and success toasts for actions like watchlisting, hiding, requesting in 4K, and reporting an issue.
- Email notifications: Jellyfin users can add and verify their own notification email address from their profile.

**Fixed**

- Requests: a second user can again request a title that is already queued for someone else (the web UI was incorrectly blocking it).
- Email: the notification-email preference now gates every notification send.
- API: rate-limited responses now include a `Retry-After` header so clients back off correctly.
- Hardening: bounded async fan-outs and added request-size caps, input validation, and admin-account guards across the admin, requests, and sync paths.

## Beta testing

Summonarr v0.23.0 is a beta release and real-world feedback is needed before a stable 1.0. If you run Plex or Jellyfin at home and want to help:

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
