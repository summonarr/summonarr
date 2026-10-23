# Watch sync (Plex ⇄ Jellyfin)

**Watch sync** — [watch-sync.ts](../../src/lib/watch-sync.ts) (pure plan) + [watch-sync-data.ts](../../src/lib/watch-sync-data.ts) (run), page `/admin/watch-sync` behind `feature.admin.watchSync` (default OFF), ADMIN-only. Rules: guardrail 19e.

- **Pairs.** An admin pairs a Plex `MediaServerUser` (an account on one Plex server) with a Jellyfin `MediaServerUser` (a user on one Jellyfin server) and picks a `direction`: `both` (default), `toJellyfin` or `toPlex` (`WatchSyncPair`). Identities already linked to the same Summonarr account are offered as suggestions; nothing is paired automatically. `GET/POST /api/admin/watch-sync`, `PATCH/DELETE /api/admin/watch-sync/[id]` (`enabled`, `direction`, `rescan`), all audited as `SETTINGS_CHANGE` under `watch-sync:<pairId>`.
- **What counts as watched.**
  - Plex → Jellyfin: Plex's own history (`/status/sessions/history/all`, `getPlexWatchHistory`) — Plex's "played" threshold, not Summonarr's.
  - Jellyfin → Plex: the Jellyfin user's own played flag (`getJellyfinPlayedSince`, newest play first).
  - Either way plays from before the pair (and before Summonarr) are included on the first run.
- **The run** (`/api/cron/watch-sync`, every `WATCH_SYNC_INTERVAL` = 300s; "Run now" is a background job on the same lock, 2081):
  1. *Plan.* Plex → Jellyfin: one history read per Plex server — the whole history if any pair on it is new, otherwise back to the oldest `historyReadTo` minus a 2-hour overlap. Jellyfin → Plex: per pair, the played list back to `jellyfinReadTo` minus the overlap. Plays resolve to a TMDB id through the source server's library cache, then to every copy on the target (Jellyfin item ids, or Plex ratingKeys; episodes via a per-show episode walk). New items go into `WatchSyncMark` / `WatchSyncPlexMark` as `pending`. An item this sync marked on the source side is skipped (no echo).
  2. *Apply*, per pair and direction: up to 500 pending or retryable items, after reading the target's own played state (already played → `already`, no write).
     - Jellyfin: `markJellyfinPlayed` with the source's play date — `POST UserPlayedItems/{id}?userId=` (10.9+), falling back to `POST Users/{uid}/PlayedItems/{id}` (≤10.8). 404 on both → `missing`.
     - Plex: `scrobblePlexItem` (`/:/scrobble`) with the **Plex account's own token**, after reading its `viewCount` as that user. The owner's token is the admin token; a shared user's comes from plex.tv `shared_servers`; a managed home user's from the home-user switch. No token → the direction errors; never the admin token instead. A key the server no longer returns → `missing`.
     - Failures are `failed`, retried up to 5 times.
- **Resume points** (per pair, `syncProgress`, default off). Titles in progress on either side — the Jellyfin user's resumable list and the Plex account's On Deck (`/library/onDeck`, falling back to the Continue Watching hub), both read as the user — have their state read on both sides for every copy (`getPlexUserStates`, `getJellyfinUserStates`), and `decideProgress` copies the newer resume point (≥ 60 s, < 95% in) unless it's within 30 s of the other side's, the target saw newer activity, or the target is watched. Writes: `setJellyfinPosition` (`POST UserItems/{id}/UserData` with `PlaybackPositionTicks` — user data only, no session) and `setPlexProgress` (`/:/progress?…&state=stopped` with the user's token). Up to 200 titles per pair per run.
- **Known limits.**
  - Plex can't take a play date: items marked on Plex carry the time of the sync.
  - A PIN-protected managed home user can't be written to on Plex (the switch needs the PIN); the direction reports it.
  - A title that isn't on the target yet counts as "not in Jellyfin/Plex" and is skipped once the read point moves past it. Use **Re-scan history** after it arrives (both read points reset; the ledgers keep already-marked items from repeating).
  - Specials (season 0) are never matched. Resume positions aren't synced, and a Jellyfin mark resets that item's saved position.
  - Resume points are copied on the 5-minute schedule, not live. Jellyfin needs 10.9+ for the user-data route (12.2 here).
  - Unverified live: the plex.tv `shared_servers` / home-switch answers, `/:/scrobble`, `/:/progress` (including whether it ever shows as a playback session — hence the per-pair switch, off by default), `/library/onDeck`, the owner's `"1"` in Plex history, and the Jellyfin route your version accepts. All are handled defensively.
