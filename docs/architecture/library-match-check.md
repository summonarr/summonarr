# Library match check

_Moved verbatim from CLAUDE.md "Core architecture"._

**Library match check** — [library-match.ts](../../src/lib/library-match.ts) (pure rules) + [library-match-data.ts](../../src/lib/library-match-data.ts), the "Match check" section of Admin → Library (ADMIN; it renders on a one-server deployment too, unlike the Plex↔Jellyfin diff below it).
- Every Plex/Jellyfin item — every copy and every unmatched one, listed live (`listPlexMatchEntries`, `listJellyfinMatchEntries`), not the sync's one row per TMDB id — judged against the folder Radarr/Sonarr say it sits in. Flags: `wrongMatch` (shares NO id with the folder's title), `noTmdbId` (the sync can't place it), `yearMismatch` (only in a folder no Radarr/Sonarr manages: a "Name (YYYY)" folder more than `YEAR_TOLERANCE` (2) years from its match — informational, never fixable). An item in a folder another item already agrees with is `sibling` (an extra or a second part) and is never offered a fix.
- On demand only: `POST /api/admin/library/match-check` (`async: true` → 202 `{ job }`, poll `GET ?job=` — the 37a pattern; lock `LIBRARY_MATCH_CHECK_LOCK_ID` 2071), read-only towards every server. The report lives in the `libraryMatchCheck:report` Setting (flags capped at `MAX_STORED_FLAGS`), written under the two-key xact lock (2071, 1). A source that can't be read is named in `sources` and referees nothing.
- A flag's Fix is fix-match's ITEM mode (guardrail 37e).
