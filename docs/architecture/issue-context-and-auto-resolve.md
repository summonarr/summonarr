# Issue playback context and auto-resolve

## Playback context

When a user files an issue, `createIssue` ([issue-create.ts](../../src/lib/issue-create.ts), shared with Discord's `/issue`) snapshots the reporter's most recent play of that title into `Issue.playbackContext` (version-tagged JSON): player/platform/device, play method, video/audio decision and codec, resolution, container, delivered bitrate (kbps), the recorded transcode reason, and lan/wan/relay.

- **Which play.** The reporter's linked media-server identities (`resolveLinkedMediaServerUserIds`, guardrail 34) → `PlayHistory` rows of that title in the last 45 days → `pickPlay`. An episode issue prefers the exact episode, then the same season, then any play of the title (`exact: false`, shown as "a different episode of this title"); a season issue matches on season.
- **Never stored:** the IP address, anything else network-identifying, the title of other plays. The admin sees it as chips under the issue's note on `/admin/issues` (server component, `IssuePlaybackContext`).
- **Best effort.** No linked identity, no recent play, or a failed read ⇒ no context, and the issue is filed anyway.
- **Purge.** `purgeUserDataInTx` nulls `playbackContext` on the account's issues.

## Auto-resolve

`autoResolveIssueForGrab` runs from both Download webhooks at the point where the first delivery claims a `IssueGrab` (the same moment the admin gets the "replacement landed" push).

- Movies and single-episode TV issues only. A season grab matches any delivered episode of the season, so its first import proves nothing; season/series issues stay with the admin.
- Grabs older than 30 days are stale intent and are ignored.
- The status write is a CAS on OPEN/IN_PROGRESS; audited as `ISSUE_STATUS_CHANGE` (`trigger: "auto-resolve-replacement"`, actor `system`); no resolution text.
- The reporter is notified through the manual-resolve channels behind one `deactivatedAt` read, except when they are the admin whose grab landed.
- A reporter reply reopens a RESOLVED issue (existing behaviour), so a wrong guess costs one message.
- `feature.behavior.issueAutoResolve`, default ON.

## Related: stream alerts and studio browse

- Concurrent-stream alert: [stream-limit.ts](../../src/lib/stream-limit.ts); Settings → Media → Play history → "Simultaneous streams alert". Alert only.
- Browse by studio/network/certification: `companyId`, `networkId` (TV), `certification` (movies, US cap) on `/movies`, `/tv` and `/api/browse`; the detail page links studios/networks. TMDB cannot cap a TV discover by rating, so `certification` is dropped for TV. Adding these segments changed the `discover:` cache-key shape, so existing discover cache rows expire by TTL instead of being reused. Titles cached before `studioList` existed show no studio links until their detail cache refreshes.
