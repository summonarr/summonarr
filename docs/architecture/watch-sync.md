# Watch sync (Plex → Jellyfin)

**Watch sync** — [watch-sync.ts](../../src/lib/watch-sync.ts) (pure plan) + [watch-sync-data.ts](../../src/lib/watch-sync-data.ts) (run), page `/admin/watch-sync` behind `feature.admin.watchSync` (default OFF), ADMIN-only. Rules: guardrail 19e.

- **Pairs.** An admin pairs a Plex `MediaServerUser` (an account on one Plex server) with a Jellyfin `MediaServerUser` (a user on one Jellyfin server): `WatchSyncPair`. Identities already linked to the same Summonarr account are offered as suggestions; nothing is paired automatically. `GET/POST /api/admin/watch-sync`, `PATCH/DELETE /api/admin/watch-sync/[id]` (`enabled`, `rescan`), all audited as `SETTINGS_CHANGE` under `watch-sync:<pairId>`.
- **What counts as watched.** Plex's own history (`/status/sessions/history/all`, via `getPlexWatchHistory`). That is Plex's "played" threshold, not Summonarr's play-history one. Plays from before the pair was made, and before Summonarr was installed, are included.
- **The run** (`/api/cron/watch-sync`, every `WATCH_SYNC_INTERVAL` = 300s; "Run now" on the page is a background job on the same lock, 2081):
  1. *Plan*, per Plex server: one history read. The whole history if any pair on that server is new, otherwise back to the oldest pair's `historyReadTo` minus a 2-hour overlap (`stopBefore`). Each pair's plays resolve to a TMDB id through `PlexLibraryItem` (owner `"1"` → plex.tv id), then to Jellyfin item ids through `JellyfinLibraryItem` (every copy) and, for episodes, a per-series episode walk (`getJellyfinEpisodeIds`). New items are inserted `pending` in `WatchSyncMark`.
  2. *Apply*, per pair: up to 500 pending or retryable items. The user's `IsPlayed` list is read first (already played → `already`, no call). Then `markJellyfinPlayed` with Plex's `viewedAt` as `datePlayed`: `POST UserPlayedItems/{id}?userId=` (10.9+), falling back to `POST Users/{uid}/PlayedItems/{id}` (≤10.8). A 404 on both → `missing`; any other failure → `failed`, retried up to 5 times.
- **Known limits.**
  - A title that isn't on the Jellyfin server yet counts as "not in Jellyfin" and is skipped once the read point moves past it. Use **Re-scan history** on the pair after it arrives; the ledger keeps already-marked items from repeating.
  - Specials (season 0) and multi-episode numbering mismatches are never guessed.
  - The resume position isn't synced, and marking an item played resets Jellyfin's saved position for it.
  - Unverified live: the owner's `"1"` in Plex history, and the route your Jellyfin version accepts. Both are handled defensively.
