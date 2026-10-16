# /admin/queue revamp: full parity with Radarr and Sonarr

**Status:** plan (2026-10-13, branch `build` @ 7172b3d). Nothing implemented yet.

## How this plan was researched

- **Summonarr today:** every file behind the page was read in full:
  - the page and `src/components/admin/download-queue.tsx`
  - `queue-import-dialog.tsx`, `queue-format.ts`, `arr-health-panel.tsx`
  - all eight `/api/admin/queue/*` routes
  - `src/lib/arr-queue{,-data,-http}.ts` and `arr-health*.ts`
  - the snapshot, nav-badge and link-filter plumbing
  - the tests that pin them
- **Upstream source**, read from git:
  - Radarr `develop` (queue code identical to v6.4.4), diffed against v3.2–v6.4 tags.
  - Sonarr `develop` (v5-dev, `/api/v5`), v4.0.19.3011 (stable) and the `v3` branch.
  - Covered for each: the Activity → Queue frontend, Interactive Import, the Queue/QueueStatus/QueueDetails/QueueAction controllers, the tracked-download state machine, pending releases and the SignalR broadcasts.

**Native consumers:** none. Neither the iOS app nor the Activity app calls any `/api/admin/queue*` route. The web page is the only consumer, so these wire shapes can change freely. The OpenAPI entries in `src/app/api/openapi/route.ts` must follow the changes.

---

## 1. Goal and non-negotiables

**Goal:** an admin should never need to open Radarr's or Sonarr's own queue to see what a download is doing, find it, or do anything those UIs offer for it. That covers:
- listing, sorting, filtering, paging and column choice
- status detail
- single and bulk remove / blocklist / ignore / change category / grab
- the full Interactive Import
- live freshness, the nav badge
- the same status where a title is shown elsewhere

The work must stay inside the existing rules:

| Guardrail | What it means for this work |
|---|---|
| 5 / 5a | Every upstream call goes through `arrFetch`. Never use bare `fetch`. |
| 5c | A removal sends ONE record id per download, with every flag explicit. This extends to held (pending) Sonarr releases, which are currently not folded. |
| 5d | Import commands are built only from the arr's own `manualimport` rows. Corrections name ids, and the objects come from the instance. |
| 5e | Every write is checked against a FRESH read. Projections are explicit. Messages pass through `safeMessage`. Writes are audited after the arr accepts them. |
| 5h | Snapshots are display-only. No write ever reads one. |
| 7b / 7c | Unchanged conditions are logged once. The nav badge has one poll and comes from arr-watch. |
| 16 | No clock reads in render. Relative times are computed after mount. |
| 32 | Every instance is named, and a failed instance is never read as "nothing there". |
| 37a | Anything that can outlast a reverse proxy runs as a background job. |
| 42 | Colours come from DS tokens and work in both themes and all six accents. |

---

## 2. Parity matrix

Legend: ✅ have · ◐ partial · ❌ missing · ⛔ deliberately not doing (section 7).

### 2.1 Listing, table and filters

| Feature | Radarr | Sonarr | Summonarr now | Phase |
|---|---|---|---|---|
| Every instance in one view | n/a | n/a | ✅ | keep |
| Server-side paging (5–200 per page, pager, page jump, total) | ✅ | ✅ | ❌ renders every row | 3 |
| Sort by any column (14–19 keys), direction toggle | ✅ | ✅ | ❌ fixed server order | 3 |
| Columns: show/hide | ✅ | ✅ | ✅ | keep |
| Columns: reorder | ✅ | ✅ | ❌ | 3 |
| Columns: episode, episode title, air date (Sonarr) | — | ✅ | ◐ summary only; titles and air dates never read | 1, 3 |
| Columns: year, protocol, release title, output path as real columns | ✅ | ✅ | ◐ details panel only | 3 |
| Separate custom-format score column | ✅ | ✅ | ◐ merged with formats | 3 |
| "Show unknown items" toggle | ✅ | ✅ | ❌ always shown, never marked | 1, 3 |
| Filter by title/series | ✅ | ✅ | ◐ substring and title-link chip | 3 |
| Filter by quality | ✅ | ✅ | ❌ | 3 |
| Filter by language | ✅ | ✅ | ❌ | 3 |
| Filter by protocol | ✅ | ✅ | ❌ | 3 |
| Filter by status (9 values) | ✅ | ✅ | ◐ "Needs attention" only | 3 |
| Filter by client, indexer, instance | ❌ | ❌ | ◐ instance only | 3 |
| Saved custom filters | ✅ server-side | ✅ server-side | ❌ | 3 |
| View state survives reload and is shareable | ✅ persisted | ✅ persisted | ❌ only the link filters are in the URL | 3 |
| Empty, error and filtered-empty states | ✅ | ✅ | ✅ | 3 |
| Table frozen while a dialog is open | ✅ | ✅ | ✅ polling pauses | keep |

### 2.2 Row rendering

| Feature | Radarr | Sonarr | Summonarr now | Phase |
|---|---|---|---|---|
| Status icon matrix (10 ordered rules) with a popover of grouped `statusMessages` | ✅ | ✅ | ◐ phase chip and a flat message list; per-file message titles are dropped | 1, 3 |
| "Import failed: release" vs "Download failed" vs "Download warning: msg" wording | ✅ | ✅ | ❌ | 1, 3 |
| Episode cell: SxxEyy, absolute numbers for anime, ranges, multi-episode popover | — | ✅ | ◐ codes only | 1, 3 |
| Quality label with PROPER / REAL / REPACK | ✅ | ✅ | ✅ | keep |
| Languages with a "Multi" popover | ✅ | ✅ | ◐ hidden column, flat list | 3 |
| Time left for pending items ("Delaying until …" / "Retrying at …") | ✅ | ✅ | ❌ "—" | 1, 3 |
| Remaining/total size tooltip | ✅ | ✅ | ◐ | 3 |
| Sizes in binary units (match the arrs) | ✅ | ✅ | ❌ decimal | 3 (decision) |
| Progress bar hidden at 0 | ✅ | ✅ | ◐ | 3 |
| Unknown items shown with the raw release title | ✅ | ✅ | ◐ no marker | 1, 3 |
| Held Sonarr pack as ONE row | n/a (Sonarr shows per episode) | v5 only | ❌ one row per episode | 1 |
| Mobile layout | responsive | responsive | ❌ 760 px table, scrolls sideways | 3 |

### 2.3 Actions

| Feature | Radarr | Sonarr | Summonarr now | Phase |
|---|---|---|---|---|
| Row selection, select page, shift-range select | ✅ | ✅ | ❌ | 3 |
| Bulk Remove (one dialog, flags must hold for every selected row) | ✅ | ✅ | ❌ | 2, 4 |
| Bulk Grab (held releases) | ✅ | ✅ | ❌ | 2, 4 |
| Bulk Import across downloads | ❌ | v5 only | ❌ | 5 |
| Remove dialog: method select (remove / change category / ignore) with hints and disabled reasons | ✅ | ✅ | ◐ radios; no disabled reasons | 4 |
| Remove dialog: blocklist select (none / and search / only) | ✅ | ✅ | ✅ | 4 polish |
| Refuse change-category where the client has no post-import category | ✅ disabled (Radarr 500s if forced) | ✅ disabled | ◐ hidden in the UI, not checked on the server | 2 |
| Refuse ignore for unknown titles (500 or no-op upstream) | ✅ disabled | ✅ disabled | ❌ | 2 |
| Tell the admin that blocklist does nothing for a release the arr didn't grab | ❌ silent | ❌ silent (v4) / 400 (dev) | ❌ | 2, 4 |
| Writes re-read the queue first (stale ids) | n/a | n/a | ❌ relies on the arr's 404; v4 and Radarr bulk are all-or-nothing, v3 partial | 2 |
| Grab audit records the release name (5e) | n/a | n/a | ❌ ids only | 0 |
| Refresh = RefreshMonitoredDownloads, spinner until the command ends | ✅ | ✅ | ◐ fixed 5 s timer | 2, 6 |

### 2.4 Interactive Import

| Feature | Radarr | Sonarr | Summonarr now | Phase |
|---|---|---|---|---|
| Import mode forced to Auto for downloads | ✅ | ✅ | ❌ offers Move/Copy (defect) | 0 |
| Import gate = completed + warning | ✅ | ✅ | ◐ broader: races the arr's own import | 0 |
| One season per file | ✅ server rejects | ✅ server rejects | ❌ (defect) | 0 |
| Quality Proper/Real kept and editable | ✅ | ✅ | ❌ stripped (defect) | 0 |
| Release type editable only where it has an effect | n/a | v5 uses it; v4 ignores it for downloads | ◐ offered on v4, where it does nothing | 0 |
| "Any" / "Original" hidden from languages | ✅ | ✅ | ❌ | 0 |
| Bulk "Select …" editors across files | ✅ | ✅ | ❌ | 5 |
| Library title picker (title, year, ids) | ✅ | ✅ | ◐ remote lookup, ≤25 results | 5 |
| Series-only correction (the arr maps the episodes) | — | ✅ | ❌ 400 | 5 |
| Episode picker: filter, air date, absolute number, select-all, split across files | — | ✅ | ◐ checklist | 5 |
| Columns: custom formats and score, season, release type, indexer flags (display), rejection type; sortable | ✅ | ✅ | ◐ | 5 |
| Sonarr v3 language editing | — | ✅ | ❌ 400 | 5 |
| Duplicate-episode refusal across files | — | v5 | ❌ (the server silently keeps one) | 5 |
| Command progress and outcome, then queue refresh | ✅ | ✅ | ❌ fixed 3 s timer, failures unseen | 5 |
| Folder or filesystem-browse import | ✅ | ✅ | ⛔ (5d) | — |

### 2.5 Freshness and elsewhere

| Feature | Radarr | Sonarr | Summonarr now | Phase |
|---|---|---|---|---|
| Live updates | SignalR | SignalR | ◐ 20 s poll, no refresh on tab return | 6 |
| Nav badge agrees with the page | ✅ | ✅ | ❌ comes from a 15-minute cron | 6 |
| Badge colour by severity | ✅ | ✅ | ❌ always amber | 6 (decision) |
| Silent 10k-record truncation reported | n/a | n/a | ❌ | 0 |
| Queue status on the title's own page (QueueDetails) | ✅ | ✅ | ❌ | 7 |
| Deep links from the `arr.queue_attention` notification and the request "Why?" panel land filtered | n/a | n/a | ❌ unfiltered | 6 |
| Download-handling context (CDH on/off, redownload-failed switches, client remove completed/failed) | in Settings | in Settings | ❌ | 8 (optional) |

---

## 3. Defects found during the audit (Phase 0, ship first)

These are wrong today, independent of the redesign.

1. **Import offers Move/Copy for a tracked download.**
   - Both arrs force `importMode:auto` for a `downloadId` and hide the picker.
   - Move sets `copyOnly=false` even when the client can't release the files yet (a seeding torrent).
   - Where: `queue-import-dialog.tsx:345-352`. "Auto (the instance's setting)" also misdescribes Auto.
2. **A file can be mapped to episodes from two seasons.**
   - The season dropdown keeps ticked episodes (`queue-import-dialog.tsx:544`), and `applyImportOverride` (`arr-queue.ts:775-816`) has no single-season check.
   - Sonarr throws `InvalidSeasonException` and the command still "succeeds".
3. **Changing a file's quality strips PROPER/REAL**: the revision is hard-coded to `{version:1, real:0}` (`arr-queue.ts:799`).
4. **The release-type correction is a no-op on Sonarr v4 download imports.** v4 takes the type from the grab history or the parsed name. It is offered anyway.
5. **The Import gate is broader than upstream.** `canImport` (`download-queue.tsx:146`) also covers a plain `importPending` with no warning, i.e. the arr's own import is about to run. Upstream offers Import only for `completed` + `trackedDownloadStatus=warning`.
6. **"Any" (-1) and "Original" (-2) are offered as file languages.**
7. **The queue Grab's `ARR_RELEASE_GRAB` audit has ids only**, no release name. Guardrail 5e says it records the name.
8. **Truncation is silent.** `MAX_PAGES` × 250 = 10,000 records per instance are read, and a larger queue drops the rest without saying so.
9. **Stale strings.**
   - `apiAdmin.queue.removeBodyInvalid` says "ids 1–500" and omits `method`.
   - `importBodyInvalid` names only the legacy `paths`.
   - The OpenAPI `errors[]` lacks `kind`.
10. **`filterExistingFiles` is never sent.** The server default is `true`. Upstream sends `false`, so files already in the title's folder are listed.

---

## 4. Architecture decisions

**D1. Read everything; sort, filter and page in the browser.**

The server keeps today's model:
- every enabled instance read in full (`includeUnknown*=true`)
- folded per download
- requesters attached

The page then sorts, filters and pages the folded list itself, with the view in the URL.

Why:
- Merging instances can't be paged honestly upstream; the Download History page made the same call.
- Counts, facets and stat cards need the whole list.
- Upstream's own queue is an in-memory list rebuilt every minute, so a full read is cheap.
- **Every filter then works the same on every version.** Upstream's server-side filters don't:
  - Radarr gained them in v5.1, and `status[]`/`quality[]` only in v5.15.
  - Sonarr v3 has none.
  - An omitted `sortDirection` silently means descending on v4+/v5.1+.
- This matches the Missing page: 100-row client pages, with selection that survives page turns.

Guards:
- explicit projection of the payload
- client page sizes 25/50/100/200, so the DOM stays bounded
- the truncation flag
- a measured payload ceiling (target under 4 MB, the snapshot per-answer cap, for a 1,000-download queue)

Rejected: upstream server-side paging per instance, which is unorderable across instances and version-dependent.

**D2. No SignalR client. Smarter polling plus a webhook nudge.**

- The arr rebuilds its queue once per `CheckForFinishedDownloadInterval` (default 1 minute), plus a 5 s debounce after a grab or import. Its `queue` SignalR message is a content-free `sync` that fires on every rebuild, so subscribing would buy almost nothing over polling.
- It would also cost:
  - a persistent websocket per instance carrying the API key in the URL (`?access_token=`), outside the safe-fetch SSRF layer
  - a new dependency (`@microsoft/signalr`)
- Instead (Phase 6):
  - adaptive polling
  - immediate re-read on tab return
  - command-watched refreshes after our own actions
  - an admin-only SSE nudge when a Radarr/Sonarr webhook we already receive implies a queue change

**D3. Queue model v2 is ONE pure module.** Folding, status display, the flags that decide which actions a row offers, and sort/filter keys all live in pure functions in `src/lib/arr-queue.ts` (or a split `arr-queue-view.ts`), each table-tested. The row, the mobile card, the details drawer and the title-manager tab all read the same view object, so nothing is computed twice.

**D4. Every write resolves its targets on a FRESH read.**
- Remove, grab and import first list the instance's queue again (never a snapshot, 5h).
- They match each requested download by its record ids, and report the ones that have gone.
- They gate each method and blocklist choice on the fresh row.
- Then they send one id per download, grouped per instance.
- This closes three upstream traps:
  - Radarr and Sonarr v4 bulk removals are all-or-nothing on one stale id.
  - Sonarr v3 is partial.
  - Bulk grab is sequential and partial.

**D5. Bulk work is grouped per instance and reported per instance.**
- One upstream call per instance.
- Up to 2 instances at a time.
- Per-instance outcomes: done, gone, refused-with-reason, unknown-outcome.
- On an unknown outcome (timeout, 502/504), the instance is re-read and every download that disappeared is counted and audited. This is the `deletedAfterFailure` pattern.

**D6. The 1,121-line `download-queue.tsx` is split** into `src/components/admin/queue/` (Phase 3.1). Each piece stays reviewable, and the title manager can reuse the row, card and dialogs.

**D7. Sonarr `/api/v5` gets a seam now and an implementation when v5 ships** (Phase 9).
- Sonarr develop's `/api/v3` grab and remove 404 on pending items: they look them up by the new per-download id, while the v3 list hands out per-episode ids.
- That build is unreleased, but the adapter must exist before anyone runs it.
- Version detection uses the instance version (Phase 1.7).

---

## 5. Phases

Each phase names its files, its tests, and its "done when". Every new rule gets a test that is **mutation-verified** (break the rule, watch a named test fail), per the project's practice.

### Phase 0: correctness fixes (small, ships alone)

| # | Change | Where |
|---|---|---|
| 0.1 | Download imports send `importMode:"auto"` only. Remove the mode picker from the dialog. The route answers 400 for any other mode with a `downloadId`. The help text says what Auto does. | `queue-import-dialog.tsx`, `import/route.ts`, `arr-queue-http.ts` |
| 0.2 | One season per file: `applyImportOverride` refuses episode ids from more than one season (400, nothing sent). The editor clears ticked episodes when the series or season changes (upstream behaviour). | `arr-queue.ts`, `queue-import-dialog.tsx` |
| 0.3 | Quality corrections keep the row's own revision unless the admin sets `proper`/`real` (new booleans). The server builds `{version: proper?2:1, real: real?1:0, isRepack}`. Never take a revision object from the body. | `arr-queue.ts` (`applyImportOverride`, `parseImportSelection`) |
| 0.4 | Release-type editor: shown only where it has an effect. Sonarr v5+ yes, Sonarr v4 download imports no, with a note that v4 reads the type from the grab. Needs the instance version (1.7, or a cached `/system/status` read). | dialog, import routes |
| 0.5 | Import gate = `status==="completed" && trackedDownloadStatus==="warning"` (upstream rule). An `importPending` row without a warning reads "Radarr/Sonarr is importing this now". | `arr-queue.ts` (`canImport` moves server-side as a row flag) |
| 0.6 | `filterExistingFiles=false` on every `manualimport` listing. | `arr-queue-data.ts:245,292` |
| 0.7 | Filter languages `-1` (Any) and `-2` (Original) out of the catalog. A correction naming either is a 400. | `arr-queue-data.ts:266-274`, `arr-queue.ts` |
| 0.8 | The queue Grab's `ARR_RELEASE_GRAB` audit records each release name, read from the fresh queue row (the 2.5 fresh read lands here early). | `grab/route.ts` |
| 0.9 | Per-instance `truncated: true` (and `records`) when `MAX_PAGES` is hit. The page shows an amber line naming the instance. | `arr-queue-data.ts:readQueuePages`, `download-queue.tsx` |
| 0.10 | Fix the stale `removeBodyInvalid` / `importBodyInvalid` strings in all 7 locales. Add OpenAPI `errors[].kind`. | `src/lib/i18n/messages/*/apiAdmin.json`, `openapi/route.ts` |

**Tests:** extend `tests/arr-ops.test.mts` and `tests/arr-ops-routes.test.mts`:
- move refused for a download import
- two-season refusal, with nothing sent
- revision kept, and set by the booleans; an injected revision object ignored
- Any/Original refused
- gate matrix
- `filterExistingFiles=false` on the wire
- grab audit carries names
- truncation flag at exactly `MAX_PAGES`

**Done when:** all 10 are pinned and mutation-verified, and lint, both typechecks and `npm test` are green.

### Phase 1: queue model v2 (server, pure plus one data change)

**1.1 Read more of what the arr already sends.**
- `includeEpisode=true` is already on, but `episode.title`, `airDateUtc`, `absoluteEpisodeNumber` and the series' `seriesType` are discarded.
- Also parse:
  - `quality.quality.{id,resolution,source}` and the full `revision`
  - language ids
  - raw `status`, `trackedDownloadState` and `trackedDownloadStatus`
  - `statusMessages` as `{title, messages[]}` (keep the titles; they name the file)
  - `errorMessage` separately
  - `estimatedCompletionTime` for pending rows
  - `added`, `indexer`, the movie's `sortTitle`, and the series' `sortTitle`
- The bounds stay: 6 message groups, 300 chars per line, 20 labels.

**1.2 Fields added to `QueueItem`:**

| Field | Meaning |
|---|---|
| `key` | Stable: `service:instance:downloadId`, or a pending key (1.3). Replaces the `ids[0]` keying for expansion and selection. |
| `unknown` | No movie/series id. Shown with the raw release title. |
| `status`, `trackedState`, `trackedStatus` | Raw values. |
| `pendingReason` | `delay` / `clientUnavailable` / null. |
| `episodes[]` | `{season, episode, absolute?, title?, airDate?}` |
| `seriesType`, `sortTitle` | |
| `qualityId`, `revision{version,real,isRepack}`, `languageIds[]` | |
| `statusGroups[]` | Grouped messages. |
| `errorMessage` | |
| `grabbedByArr` | `yes` / `no` / `unknown`. "no" only when the version reports `added` (Radarr ≥5.3, Sonarr ≥4) and both `added` and `indexer` are absent. Both come from the grab history event (`TrackedDownloadService.cs:145-146`). |
| `actions` | `{canImport, canGrab, canRemove, canIgnore, canChangeCategory, canBlocklist, canBlocklistSearch}`. The single source for every surface (D3). |

The `actions` rules:
- `canIgnore`: a known, parsed title. Upstream disables Ignore otherwise; forced, Sonarr 500s or the row returns a minute later.
- `canChangeCategory`: `downloadClientHasPostImportCategory`. Never on Sonarr v3 or Radarr <5.3.
- `canBlocklistSearch`: not pending (pending blocklists never search).
- `canBlocklist`: `grabbedByArr !== "no"`.

**1.3 Fold v2.**
- Tracked downloads are folded as today: `downloadId:arrMediaId`, Sonarr only.
- **Held Sonarr releases also fold**, keyed `pending:<seriesId>:<release title>`, so a held pack is one row.
  - Grab or remove with ANY one of its ids acts on the whole release. Upstream looks up the pending release by id; grab downloads its full RemoteEpisode; remove deletes every pending release for those episodes. Pin this with a source citation.
- The merge becomes deterministic:
  - phase = most urgent (`PHASE_ORDER`)
  - `timeLeft` / ETA = max
  - `added` = min
  - status groups unioned with their titles
  - `trackedStatus` escalates as today

**1.4 Status view `queueStatusView(item)`.** Upstream's precedence, reproduced exactly (`QueueStatus.tsx:47-155`, same in both arrs; a missing tracked field defaults to ok/downloading). It returns `{icon, tone, labelKey, params, popover: groups | releaseTitle}`. The rules, in order:
1. downloading
2. paused / queued
3. completed, refined by tracked state: importBlocked (warning), importPending (purple), importing (primary), failedPending (danger)
4. tracked warning → warning tone
5. delay → pending
6. downloadClientUnavailable → warning
7. failed → danger
8. client warning → "Download warning: {msg}"
9. tracked error → "Import failed: {release}" when completed, else "Download failed"

Label keys go in a literal map (the i18n dead-string check). The tones map onto DS tokens (guardrail 42).

**1.5 Requesters:** unchanged (`attachRequesters`).

**1.6 Sort and filter keys** are pure functions over `QueueItem`. They are listed in 3.4/3.3 and exported for the page and for tests.

**1.7 Instance version in the GET.**
- `instances[].version` comes from a cached `/api/v3/system/status` read: 10-minute TTL per instance, failure gives `null`, read through `arrFetch` with `quietErrors`.
- The dialogs' version-dependent wording (5c's Sonarr v3 rule, 0.4, change category) then needs no second health read. Drop the per-session `GET /api/admin/arr-health` call in `openRemove`.

**1.8 Payload.**
- Measure the projected JSON for 1,000 downloads and for a 3,000-record Sonarr pack mix.
- If `includeSeries=true` dominates (it embeds the whole series resource per episode record), replace it with titles from the shared `getCachedArrLibraryIndex` (title, ids) plus a cached per-instance `/series` year map, and keep `includeEpisode`.
- Decide by measurement, not by guess.

**Tests** (new `tests/arr-queue-view.test.mts`, plus `tests/arr-ops.test.mts`):
- the 10-rule status matrix, table-driven, plus every precedence pair
- held-pack fold (one row; one id sent)
- deterministic merge
- `grabbedByArr` per version
- each `actions` flag
- unknown rows
- episode parsing including anime absolute numbers
- version cache TTL and failure

### Phase 2: write paths v2 (server)

**2.1 `resolveQueueTargets(service, instance, requested)`** (new, `arr-queue-data.ts`):
- A fresh `readQueuePages` of that instance only, then fold v2.
- Each requested download is matched by any overlap of its record ids.
- Returns `{found: QueueItem[], gone: string[]}`. Snapshots are never read (5h).

**2.2 `POST /api/admin/queue/remove` v2.**
- Body: `{items:[{service, instance, ids:number[]}] (≤500 downloads, ≤5000 ids), method: removeFromClient|changeCategory|ignore, blocklist: none|search|only}`.
- The legacy single-instance `{service, instance, ids, action, method?}` body stays accepted, mapped onto the new one, for curl users.
- Per instance:
  - resolve on a fresh read
  - gate on the fresh rows
  - `DELETE /api/v3/queue/bulk` with `removalIds` (one id per download, 5c) and all four flags explicit
- Gates. A refused download is reported, never sent:

  | Requested | Refused when |
  |---|---|
  | `changeCategory` | the fresh row's `canChangeCategory` is false. This prevents Radarr's 500 (`NotSupportedException`) and Sonarr v3's silent stop-tracking. |
  | `ignore` | the row is `unknown` or unparsed |
  | blocklist `search` on a held release | sent as blocklist; the arr never searches for pending releases, and the result says so |
  | `blocklist` where `grabbedByArr==="no"` | still removed, reported as `notBlocklisted` (upstream is silent on Radarr and Sonarr v4, 400 on develop) |
  | Sonarr v3 | `changeCategory` is 400 |

  Held releases ignore the method (the arr does too).
- Response:
  ```
  { results: [ { service, instance,
                 removed, gone, notBlocklisted,
                 refused: [{key, reason}],
                 failed?: {kind, message}, uncertain? } ] }
  ```
  It answers 200 when anything was done, 409 when nothing was left, and 400 on validation.
- An unknown outcome (timeout, 502/504, `arrWriteOutcomeUnknown`): re-read the instance, count what left, audit that, and set `uncertain:true`.
- Audit `ARR_QUEUE_REMOVE` once per instance, after the arr accepts. It records `downloads[{downloadId, release, media}]`, the method and the blocklist choice. No paths.

**2.3 `POST /api/admin/queue/grab` v2.**
- Same `items` shape.
- Fresh read; only held releases (`delay` / `downloadClientUnavailable`), one id per release, sent with `POST /queue/grab/bulk`.
- Upstream bulk grab is sequential: a mid-list failure leaves the earlier ones grabbed. On any failure, re-read and count which releases left the held set.
- Audit `ARR_RELEASE_GRAB` with each release name and `source:"queue"`.
- Response per instance: `{grabbed, gone, notPending, failed?}`.

**2.4 `POST /api/admin/queue/recheck`** additively returns `commandIds` per instance. The page follows them with `useArrCommandWatch`, one key per instance, and re-reads when all have ended. This replaces the 5 s timer, per the "never put a fixed re-read timer back" rule.

**2.5 Rate limits:** queue writes (remove + grab + import) share `queue-write:<userId>` at 60/min. Re-check stays at 6/min.

**2.6 Body caps:** remove/grab 128 KB.

**Tests** (extend `tests/arr-ops-routes.test.mts`):
- a stale id is reported `gone` and never sent
- a gate refusal sends nothing for that download
- Sonarr v3 change category is 400
- one id per download, including a held pack
- two instances give two calls
- unknown outcome triggers the re-read, and only what left is audited
- the audit is never written before acceptance (moving it fails a test)
- grab refuses non-pending rows, and partial-failure reconciliation works
- shared rate limit
- legacy body mapping

### Phase 3: page rebuild (table, filters, selection, mobile)

**3.1 Split into `src/components/admin/queue/`:**

| File | Role |
|---|---|
| `queue-page.tsx` | State and composition |
| `use-queue-data.ts` | Load gate, snapshot, polling |
| `queue-url-state.ts` | Pure parse and serialize |
| `queue-view-model.ts` | Pure sort, filter, facets, paging |
| `queue-selection.ts` | Pure |
| `queue-columns.ts` | Registry: id, label key, default visibility, sort key, cell renderer |
| `queue-toolbar.tsx` | |
| `queue-filters.tsx` | |
| `queue-table.tsx` | |
| `queue-row.tsx` | |
| `queue-card.tsx` | Mobile |
| `queue-status.tsx` | Icon and popover from `queueStatusView` |
| `queue-details.tsx` | Drawer/panel |
| `queue-bulk-bar.tsx` | |

`download-queue.tsx` goes away. The existing source-scan tests move with it: snapshot wiring, load gate, `removalIds`, versions.

**3.2 URL state** via `history.replaceState`, parsed by the server page for the first paint:

| Parameter | Meaning |
|---|---|
| `q` | text search: title, release, episode title, download id |
| `phase=` | multi |
| `service`, `instance`, `arrId` | existing title link; stays all-or-nothing |
| `inst=` | multi |
| `proto`, `client`, `indexer`, `quality`, `lang`, `cf` | |
| `attention=1` | |
| `unknown=show\|hide\|only` | default `show`, as both arrs default |
| `sort`, `dir` | |
| `page`, `size` | |

Each part is validated on its own; an invalid part is dropped alone.

**3.3 Filters.**
- Quick segments: All · Needs attention · Downloading · Held · Import issues · Failed, each with a count.
- A "Filters" popover, or a Drawer on mobile, with multi-selects whose options come from the current data with counts: phase/status, service, instance, protocol, download client, indexer, quality, language, custom format, has-requester, unknown items.
- Active filters show as removable chips; "Clear all".
- **Saved filters**: named presets of the URL state, kept in the browser (decision 7.2).
- The stat cards and segment counts follow the active filters (today they ignore them).

**3.4 Sorting.**
- Clickable headers with `aria-sort`.
- Keys: attention (the default, today's urgency order), status, title (sortTitle), year, episode, episode title, air date, languages, quality, CF score, protocol, indexer, client, release title, size, size left, progress, time left, ETA, added, requested by, instance.
- Quality sorts by the instance's quality-definition weight (one cached `/qualitydefinition` per instance, already read for Import), falling back to name.
- Tie-break: progress descending (upstream), then title.

**3.5 Paging.**
- Page sizes 25/50/100/200, default 50.
- First/prev/next/last, page jump, "N downloads · M records".
- Reset to page 1 on any filter or sort change; clamp when rows vanish.

**3.6 Columns.**
- The registry covers every upstream column plus Summonarr's own: instance, requested by, size left.
- Show/hide and **reorder** (move up/down in the menu, keyboard-accessible), with reset.
- Persisted in localStorage, read after mount, inside try/catch.
- Defaults:
  - Visible: status, title, episode (Sonarr), quality, formats, progress, time left, actions.
  - Hidden: the rest, as upstream.

**3.7 Selection.**
- A checkbox on every row, including held and unknown ones.
- Header select-all for the page, then a "Select all N matching" bar.
- Shift-click range; Escape clears.
- Keyed by `QueueItem.key`, pruned when a row leaves, kept across page, sort and filter changes. Hidden selected rows are counted, as on the Missing page.
- Bulk bar actions:
  - Remove…
  - Blocklist & search…
  - Grab (n held)
  - Import (n importable, Phase 5)
  - Clear

**3.8 Cells.**

| Cell | Content |
|---|---|
| Status | Icon plus an accessible popover button showing the grouped status messages, or the release title. |
| Title | Summonarr link, raw release for unknown rows (muted mono), year, "Open in", episode summary. |
| Episode | SxxEyy, or absolute number for anime; ranges; a "Multiple episodes" popover with titles and air dates. |
| Quality | Label with PROPER/REAL/REPACK. |
| Languages | "Multi" popover. |
| Formats / score | Formats as chips; score in its own column (`+0` rule). |
| Protocol | Label (`nzb` / `torrent`). |
| Size | Binary units (decision 7.1), "x left" tooltip. |
| Time left | Downloading/paused/queued: humanized, with the exact `d hh:mm:ss` and "remaining / total size" in the tooltip. Delay: "Delaying until {date}". Client unavailable: "Retrying at {date}". Completed/failed: "—". Relative dates after mount (16). |
| ETA, Added | After mount. |
| Progress | Hidden at 0; tone by state. |

**3.9 Row actions.**
- One context-sensitive primary button: Import for import-blocked, Grab now for held, otherwise none.
- An overflow `DropdownMenu`: Remove…, Blocklist & search…, Blocklist only…, Grab now, Import…, Manage…, Open in Radarr/Sonarr, Copy download id, Details.
- This replaces today's six equal buttons.

**3.10 Details** is an inline panel on desktop and a `Drawer` on mobile. It shows every field, grouped status messages, and the per-episode list (title and air date).

**3.11 Instance strip** replaces the full health panel at the top:
- One chip per instance: name · vX · reachable/health/webhook, plus truncation and read errors.
- Clicking expands the existing `ArrHealthPanel`, collapsed by default and remembered.
- Set up / Repair webhook is unchanged.

**3.12 Mobile (<768 px).** A card list: checkbox, status icon, title and episodes, progress, chips (quality, left, ETA), the primary action and overflow. Tap opens the details Drawer; filters go in a Drawer. No sideways scrolling.

**3.13 States.**
- Loading skeleton mirroring the real layout (`--ds-bg-3`, guardrail 42).
- Not configured.
- Every instance failed.
- Filtered-empty with "Clear filters".
- Empty.
- Notices auto-dismiss through the toast primitive.

**3.14 Accessibility.**
- `<caption>` (sr-only), `th scope`, `aria-sort`.
- sr-only status text beside each icon.
- A live region for action results.
- Focus returns to the row after a dialog.

**3.15 Freshness hooks** (expanded in Phase 6): pause while any dialog is open (kept); re-read on tab return when the data is older than 10 s.

**3.16 i18n.** All new strings in `src/lib/i18n/messages/<7 locales>/adminQueue.json`. Status and filter labels go through literal key maps.

**Tests:**
- Pure: URL-state round-trip and per-part drop; sort per key including null-last and tie-break; every filter and facet count; selection prune/range/select-all-matching; column registry covers every sort key; default columns.
- Source scans:
  - no `Date.now`/`new Date` in render paths (16)
  - snapshot URL equals live URL; `markLive` only after the gate (5h)
  - one poll, paused while dialogs are open
  - the page never sends more than `removalIds`
- The E2E crawl still visits `/admin/queue` with no `#418`.

**Done when:** a browser check against `npm run dev` with seeded fixtures passes for desktop and mobile widths, light and dark, and two accents (definition of done #3).

### Phase 4: remove, grab and bulk dialogs

**4.1 Remove dialog parity** (`RemoveQueueItemModal`):
- Two selects:
  - **Removal method:** Remove from download client / Change category / Ignore download.
  - **Blocklist:** Do not blocklist / Blocklist and search / Blocklist only.
- Upstream hint texts (translated). The "removes the download and its files from the client" warning. Defaults: remove from client + do not blocklist, reset every time (Sonarr v4 behaviour; not develop's remembered choice, which can resend a choice the next row doesn't support).
- Options are **disabled with the reason shown**:
  - no post-import category on the client
  - the title isn't known to the arr
  - held release
  - Sonarr v3: no change category, and "only" still searches (existing 5c wording)
  - not grabbed by the arr: "can't be blocklisted"
- Single vs bulk wording ("Remove N downloads from 2 instances"). A bulk choice is enabled only when it holds for every selected download (upstream rule); the dialog says how many block an option.
- The confirm button is danger-toned only when files are deleted from the client.
- The result names per-instance outcomes: removed, gone, not blocklisted, refused, uncertain.

**4.2 Quick actions** (Blocklist & search / Blocklist only) open the same dialog pre-set, as today.

**4.3 Grab:** immediate for one row; a confirm for bulk ("Grab 5 held releases now — this sends them to the download client").

**4.4** After a write: optimistic removal stays. A follow-up re-read at +2 s and +7 s (the arr's own 5 s debounce) replaces "drop the row and hope".

**Tests:**
- Dialog option gating is a pure function of the selected views (table test).
- Source scan: the dialog builds its body only from the gated choices.
- Route tests from Phase 2 cover the server side.

### Phase 5: Interactive Import v2

**5.1 Table.** Columns:
- relative path
- title
- season
- episodes ("S01E05 (abs 105) – title")
- release group
- quality (+P/R)
- languages
- size
- release type (shown; editable on v5 only)
- custom formats with score popover
- indexer flags (display only)
- rejections (popover, Permanent/Temporary)

All sortable (except season, episodes, release group, as upstream), with shift-range select. Keep Summonarr's safer preselection: clean matched rows. Upstream preselects rejected rows too.

**5.2 Bulk "Set for selected…" menu:** title, season, episodes, quality (+P/R), release group, languages, release type (v5).
- Episodes are split evenly across the selected files, and the count must be a multiple of the file count (upstream rule).
- Season and episodes are enabled only when every selected row shares a series and a season.
- Each bulk edit becomes per-file corrections, every one re-validated on the server (5d).

**5.3 Library title picker.**
- `GET /api/admin/queue/import/targets` switches from the remote `/lookup` to a server-side filter over the instance's OWN library: `getCachedArrLibraryIndex` entries for that instance, extended with year and imdbId if absent.
- Matches title, year, tmdb/tvdb/imdb id. At most 50 results; fields `{id, title, year, ids}`, never paths.

**5.4 Series-only correction.** Preview accepts a series with no episodes; the arr's reprocess maps them.
- The server checks every returned episode id belongs to that series and season, and hands them back for the admin to confirm.
- The import re-validates them like any correction.

**5.5 Reprocessed values.**
- At POST, for corrected rows the server re-runs the reprocess itself.
- It merges only the fields the admin didn't correct (quality, languages, release group, season, custom formats), from the instance's answer. Never from the browser.

**5.6 Validation before any command:**
- quality and language present
- one season per file (from 0.2)
- **no episode on two files** (v5 rule, applied to every version; otherwise the arr silently keeps one)
- unmatched rows can't be imported

Every refusal is a 400 naming the file, with nothing sent.

**5.7 Sonarr v3 languages:** a single-language editor from `/api/v3/languageprofile/schema` (`languages[].language`), written as the v3 `language` object from that catalog.

**5.8 Multi-download import.** "Import selected" in the bulk bar, for importable rows on ONE instance. The bulk bar groups by instance and opens one dialog per instance in turn.
- Files are listed grouped by download.
- `POST` takes `downloads[]`; each `downloadId` is verified on a fresh queue read.
- Audit `ARR_QUEUE_IMPORT` per download.

**5.9 Command feedback.**
- The import answers additive `commandIds`.
- The dialog closes into a tracked notice that follows the command (`useArrCommandWatch`).
- On completion it re-reads the queue and reports "Imported N files", or that the download still needs attention. A command can end "completed" with files failed, so the queue row is the confirmation.

**5.10 Dialog guards:** closing with unsaved corrections asks first; Import is disabled with per-row reasons.

**Tests:**
- bulk corrections become per-file and are each validated
- even split and the multiple-of rule
- the picker never returns paths
- series-only mapping refuses a foreign episode
- duplicate-episode refusal
- v3 language object comes from the catalog
- multi-download: each id verified; an injected unknown id is 400 with nothing sent
- `commandIds` present
- the reprocess merge never takes a browser value

All mutation-verified; extends `tests/arr-ops*.test.mts`.

### Phase 6: freshness, badge and deep links

**6.1 Adaptive polling** (`use-queue-data.ts`):
- 15 s while visible and anything is downloading, importing or held.
- 60 s when the queue is idle or empty.
- Immediate re-read on tab return when the data is older than 10 s.
- After an action: follow-up re-reads at +2 s / +7 s, or the command watch.
- Still one poll through `createLoadGate`, paused while dialogs are open.
- Note in code: the arr itself only refreshes once a minute, plus 5 s after a grab or import.

**6.2 Webhook nudge.**
- When a Radarr/Sonarr webhook we already handle arrives (Download, Upgrade, ManualInteractionRequired, MovieDelete/SeriesDelete), emit a **system-admin-only** SSE `arr:queue {service, instance}`. Register it in `sse-emitter.ts` and in the admin-only branch of `/api/events`.
- The page re-reads, debounced 3 s.
- Optional `onGrab` subscription: decision 7.3. Adding it to `WEBHOOK_EVENTS` turns every existing install's webhook to `eventsMissing` until Repair, so it would go in as an *optional* event that `evaluateWebhook` doesn't require.

**6.3 Badge.**
- While the queue page is open, it publishes its live attention count into `NavBadgesProvider` (client context, no new poll — 7c), so the badge matches the page.
- Elsewhere arr-watch stays the source.
- Optional severity colour (red when any error, amber for warnings): decision 7.4. It needs `arrWatch:summary` to carry severity.

**6.4 Deep links.**
- `arr.queue_attention` (`notify-events.ts:247`) → `/admin/queue?attention=1&service=…&instance=…`, or the title link when the event names one download.
- The request "Why?" panel (`request-arr-status.tsx:345`) → `queueTitleHref` for its title.

**Tests:** poll cadence state machine (pure, counted not timed); SSE event delivered to admins only; badge override only while mounted; link builders.

### Phase 7: queue status where the title lives

**7.1 Title manager "Queue" tab.**
- This title's downloads on this instance, with the same row/card, status popover and actions (remove, grab, import), reusing Phase 3/4 components.
- Data from `GET /api/admin/queue?service=&instance=&arrId=`: a new optional server-side filter of the fold, snapshotted in the title-manager tier.
- `manageTabFor("queue")` stays History (opening Queue from the queue would be redundant).

**7.2 Movie/TV detail pages (ADMIN).**
- A "Downloading 42% · Radarr 4K" / "Import blocked" chip, fetched client-side after mount. A page render never lists an arr, per the never-watched chip rule.
- It links to the filtered queue.

**7.3 Adjacent (optional):** the Missing bulk search and the Arr Calendar Search skip titles already in the queue (upstream's calendar does).

**Tests:** route filter by arrId (instance-scoped); tab reuse source scan; chip renders nothing on a failed read.

### Phase 8 (optional): download-handling context

**8.1** A read-only line per instance in the instance strip. It explains why rows vanish and why a blocklist triggers a search.
- From `GET /api/v3/config/downloadclient`: Completed Download Handling on/off, Redownload Failed (+ from Interactive Search), check interval.
- From the client resources: Remove Completed / Remove Failed.

**8.2** Editing those switches belongs in Arr System → Indexers & clients:
- read-modify-write of the config resource
- serialized like `withProviderLock`
- audited after acceptance

Decision 7.5.

### Phase 9 (deferred until Sonarr v5 ships): `/api/v5` adapter

When an instance reports major version ≥5, read `/api/v5/queue`:
- per-download records
- `episodeIds`, `seasonNumbers`, `isFullSeason`
- camelCase `sizeLeft` / `timeLeft`
- `includeSubresources`
- `includeUnknownSeriesItems` defaults to true

Then:
- Act with v5 ids. Develop's `/api/v3` pending grab/remove 404.
- Accept 204s.
- Optionally send the `message` parameter on remove.

Fixtures come from develop's source; the trigger is Sonarr v5's stable release.

### Phase 10: docs, guardrails, verification (runs alongside every phase)

**10.1 CLAUDE.md.**
- Rewrite the "Download Queue + Radarr/Sonarr health" section.
- Add **guardrail 5i** (suffix on 5, per the numbering rules): queue writes resolve on a fresh read; one id per download *including held releases*; method and blocklist gated on the fresh row; download imports are Auto-only; reprocessed values are never taken from the browser.
- Update the 5c/5d cross-references.
- Update the OpenAPI entries.

**10.2 Gate commands** each phase, run bare and never piped:
- `npm run lint`
- `npm run typecheck`
- `npm run typecheck:classic`
- `npm test`
- `npm run audit:routes`
- `npm run audit:tw-merge`
- the E2E crawl in CI

No new dependencies are expected, so the licence file doesn't change.

**10.3 Live verification:** decision 7.6. Fixtures can't prove the arr behaves as its source says.

---

## 6. Order, slicing and size

| Slice | Phases | Size | Notes |
|---|---|---|---|
| A | 0 | S | Ships alone; fixes real hazards (Move on a seeding torrent, silent mis-imports). |
| B | 1 + 2 | M–L | Server-only. The page keeps working on the old fields until C. |
| C | 3 + 4 | L | The visible revamp. Browser-verified at desktop and mobile width. |
| D | 5 | L | Interactive Import v2. |
| E | 6 + 7 | M | Freshness, badge, title-manager tab, detail chip. |
| F | 8 | S–M | Optional. |
| — | 9 | M | Deferred. |

Each slice is one commit (conventional, `feat(arr)` / `fix(arr)`) on `build`, with its tests and CLAUDE.md edits in the same commit.

---

## 7. Decisions (my default in **bold**)

1. **Size units:** **binary (GiB), matching the arrs side by side**; or keep Summonarr's decimal.
2. **Saved filters:** **per-browser presets on top of shareable URLs**; or per-admin server-side, as upstream stores them shared.
3. **Grab webhook nudge:** **no, adaptive polling is enough**; or add `onGrab` as an optional (not-required) event.
4. **Badge colour by severity:** **yes** (red errors / amber warnings), or keep it amber.
5. **Download-handling switches:** **read-only context on the queue page**, with editing deferred; or editing in Arr System now.
6. **Live verification:** **a local Docker lab** (Radarr v6, Sonarr v4, Sonarr v3, qBittorrent, public-domain torrents). With a delay profile, a stopped client and a renamed release it reproduces downloading, paused, queued, held, client-unavailable, import-blocked and failed. Or read-only checks against the production instances.
7. **Import gate:** **narrow to upstream's completed + warning**, or keep offering Import for a plain import-pending row.

---

## 8. Not doing, and why

| Item | Reason |
|---|---|
| Folder or filesystem-browse import, typed paths, "Move automatically" | Guardrail 5d. It would expose the arr host's filesystem and import any readable file. |
| Move mode for download imports | Can pull files out from under a seeding client; upstream hides it too. |
| Editing indexer flags on import | Radarr and Sonarr v4 take them from the grab history; v5 overrides them from it. A dead control. |
| Download-client control (pause, resume, priority, force-recheck) | The arrs don't expose it. It needs direct qBittorrent/SAB integration, previously declined. |
| SignalR client | D2. |
| "Remove completed" button | Doesn't exist upstream; it's the client's Remove Completed setting (Phase 8 context). |
| Interactive release search from a queue row | Already one click away through Manage → the title manager's scoped interactive search. |
