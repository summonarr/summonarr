// Content issues: filing, the thread, and the admin's fix-file tools.

import {
  JOB_STARTED,
  JOB_RUNNING,
  SEARCH_JOB,
  jobAnswer,
  ARR_RELEASE,
  ARR_SERVICE,
  ARR_HISTORY_EVENT,
  TITLE_FILE,
  tooLargeAnswer,
  forbiddenAnswer,
  RETRY_AFTER_HEADER,
  rowOwner,
  OK_TRUE,
  threadEntry,
} from "../shared";
import { ISSUE_FILES_MAX_IDS } from "@/lib/api-body-limits";
import type { OpenApiPaths } from "../types";

export const issuesPaths: OpenApiPaths = {
  "/issues": {
    get: {
      tags: ["Issues"],
      summary: "List issues",
      parameters: [
        { name: "limit", in: "query", schema: { type: "integer", default: 50, maximum: 100 } },
        { name: "cursor", in: "query", required: false, schema: { type: "string" }, description: "Continue after a page: `<createdAt ISO>|<id>` of its last issue (or the page's `X-Next-Cursor`). Absent or malformed ⇒ the first page." },
      ],
      responses: {
        "200": {
          description: "Issues for the caller (own issues, or all when MANAGE_ISSUES), newest first (createdAt, then id), each with a `user` ({ name, email } for MANAGE_ISSUES, { name } otherwise)",
          headers: { "X-Next-Cursor": { description: "The `cursor` for the next page; sent only when the page is full", schema: { type: "string" } } },
          content: {
            "application/json": {
              schema: { type: "array", items: { allOf: [{ $ref: "#/components/schemas/Issue" }, { type: "object", required: ["user"], properties: { user: rowOwner("MANAGE_ISSUES") } }] } },
            },
          },
        },
      },
    },
    post: {
      tags: ["Issues"],
      summary: "Create a new issue",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["tmdbId", "mediaType", "issueType"],
              properties: {
                tmdbId: { type: "integer" },
                mediaType: { $ref: "#/components/schemas/MediaType" },
                issueType: { $ref: "#/components/schemas/IssueType" },
                scope: { $ref: "#/components/schemas/IssueScope" },
                note: { type: "string", maxLength: 1000 },
                seasonNumber: { type: "integer" },
                episodeNumber: { type: "integer" },
              },
            },
          },
        },
      },
      responses: {
        "201": { description: "Created issue (tvdbId is resolved server-side from tmdbId, never taken from the body). The caller's identical report still OPEN or IN_PROGRESS (same title, type, scope, season, episode and note) is answered instead, unchanged and without a second admin notification", content: { "application/json": { schema: { $ref: "#/components/schemas/Issue" } } } },
        "400": { description: "Validation error" },
        "403": { description: "feature.page.issues is disabled" },
        "413": tooLargeAnswer(64 * 1024),
        "422": { description: "Title could not be verified with TMDB, or is not in a library the caller can see" },
        "429": { description: "Rate limited (the `rateLimitIssues` setting per minute, default 10)" },
        "503": { description: "Maintenance mode (non-ADMIN callers)" },
      },
    },
  },
  "/issues/{id}": {
    patch: {
      tags: ["Issues"],
      summary: "Update issue status / resolution, or trigger an ARR re-search (ADMIN / ISSUE_ADMIN)",
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      requestBody: {
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                status: { $ref: "#/components/schemas/IssueStatus" },
                resolution: { type: "string", nullable: true, maxLength: 1000, description: "The resolution note. null (or an empty string) is an empty note: alone it is the 400 'must not be empty'; beside a status change it is dropped." },
                refetch: { type: "boolean", description: "`true`: trigger a Radarr/Sonarr re-search for the issue media (scope's own search: movie MoviesSearch, EPISODE EpisodeSearch, SEASON SeasonSearch, FULL SeriesSearch). Takes precedence over status/resolution; 409 when the issue is RESOLVED; at most 10 re-searches a minute per admin (429). `false` (or null, or absent) is the status/resolution edit; any other value is 400." },
                instance: { type: "string", description: "With `refetch`: the Radarr/Sonarr instance slug to search on ('' = default). An invalid slug is 400." },
              },
            },
          },
        },
      },
      responses: {
        "200": { description: "Updated issue (unchanged, with nothing written or broadcast, when the body changes nothing). A `refetch` answers the issue plus `arrError` (string, or null when the search was queued); a failed search is still 200 with `arrError` set.", content: { "application/json": { schema: { allOf: [{ $ref: "#/components/schemas/Issue" }, { type: "object", properties: { arrError: { type: "string", nullable: true } } }] } } } },
        "400": { description: "Invalid status, resolution over 1000 chars or empty with no status, a `refetch` that is not a boolean, or (with refetch) an invalid instance slug" },
        "403": { description: "Forbidden" },
        "404": { description: "Not found, or (refetch) the service's integration is switched off (feature.integration.radarr / sonarr)" },
        "409": { description: "`refetch` on a RESOLVED issue, or `{ error: \"status-conflict\" }` — the status changed concurrently" },
        "413": tooLargeAnswer(16 * 1024),
        "422": { description: "`refetch` only: the instance is not a registered, configured one (the default included)" },
        "429": { description: "`refetch` only: more than 10 re-searches a minute by this admin", headers: RETRY_AFTER_HEADER },
        "503": { description: "Maintenance mode (non-ADMIN callers)" },
      },
    },
    delete: {
      tags: ["Issues"],
      summary: "Delete an issue (ADMIN / ISSUE_ADMIN)",
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      responses: {
        "200": { description: "Deleted", content: { "application/json": { schema: { type: "object", properties: { ok: { type: "boolean" } } } } } },
        "403": { description: "Forbidden" },
        "404": { description: "Not found" },
        "503": { description: "Maintenance mode (non-ADMIN callers)" },
      },
    },
  },
  "/issues/{id}/messages": {
    get: {
      tags: ["Issues"],
      summary: "List messages on an issue",
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string" } },
        { name: "before", in: "query", required: false, schema: { type: "string" }, description: "Keyset cursor `<createdAt ISO-8601>|<id>` of the oldest entry the client holds: answers the page strictly older, same array shape and cap. Absent or malformed reads the newest page; `X-Truncated: true` says older entries remain" }],
      responses: {
        "200": {
          description: "The newest 500 messages, oldest first, each with author { name, role } (+ email for MANAGE_ISSUES callers)",
          headers: { "X-Truncated": { description: "\"true\" when the list was cut at the cap", schema: { type: "string", enum: ["true", "false"] } }, "X-Truncated-Cap": { description: "The cap, as an integer string", schema: { type: "string" } } }, 
          content: { "application/json": { schema: { type: "array", maxItems: 500, items: threadEntry("issueId") } } },
        },
        "403": { description: "Not the reporter and no MANAGE_ISSUES, or issue reporting is disabled (feature.page.issues) for a non-admin" },
        "404": { description: "No such issue" },
      },
    },
    post: {
      tags: ["Issues"],
      summary: "Add a message to an issue",
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["body"],
              properties: { body: { type: "string", maxLength: 2000 } },
            },
          },
        },
      },
      description: "An admin's first reply flips an OPEN issue to IN_PROGRESS; the reporter replying to their own RESOLVED issue reopens it.",
      responses: {
        "201": { description: "Message added (the new message with its author)", content: { "application/json": { schema: threadEntry("issueId") } } },
        "400": { description: "Missing/non-string/empty body, or over 2000 characters" },
        "403": { description: "Not the reporter and no MANAGE_ISSUES, or issue reporting is disabled (non-admins)" },
        "404": { description: "No such issue" },
        "413": tooLargeAnswer(64 * 1024),
        "429": { description: "Rate limited (10/min per user)" },
        "503": { description: "Maintenance mode (non-ADMIN callers)" },
      },
    },
  },
  "/issues/{id}/files": {
    get: {
      tags: ["Issues"],
      summary: "List the files an issue is about, with the grab behind each (ADMIN)",
      description:
        "Resolves the issue's title on one Radarr/Sonarr instance and lists its files inside the issue's scope (FULL: all; SEASON: that season's; EPISODE: the file holding that S/E), each with the grab that produced it where the title's history can tell (projected — never a release's download URL or guid), and each file's episodes named by SONARR's own titles: the issue's numbers are the media server's, and on an anime or reordered show they can name different episodes. ADMIN only: ISSUE_ADMIN keeps Refetch and Replace-release.",
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string" } },
        { name: "instance", in: "query", schema: { type: "string" }, description: "Arr instance slug; defaults to the default instance" },
        { name: "job", in: "query", schema: { type: "string", pattern: "^[0-9a-f]{32}$" }, description: "A background replace's job id (from POST with async: true). When present the issue is not listed: 202 { job, running } while it runs, then the POST's own status and body; 404 when the job is gone (expired, another admin's, or a restart)" },
      ],
      responses: {
        "200": {
          description: "The in-scope files",
          content: { "application/json": { schema: { type: "object", properties: {
            service: ARR_SERVICE,
            instance: { type: "string" },
            arrId: { type: "integer" },
            scope: {
              type: "object",
              description: "{ kind: movie | series | season | episode, seasonNumber?, episodeNumber? }",
              required: ["kind"],
              properties: {
                kind: { type: "string", enum: ["movie", "series", "season", "episode"] },
                seasonNumber: { type: "integer", description: "season and episode scopes" },
                episodeNumber: { type: "integer", description: "episode scope only" },
              },
            },
            seriesType: { type: "string", nullable: true, description: "Sonarr's series type (standard | daily | anime); null for a movie. Anime numbering may not match the media server's" },
            files: {
              type: "array",
              items: {
                type: "object",
                description: "TitleFile (its episodes as { seasonNumber, episodeNumber, title: Sonarr's episode title | null }) plus grab: { event: ArrHistoryEvent, failed: boolean } | null",
                properties: {
                  ...TITLE_FILE.properties,
                  episodes: {
                    type: "array",
                    description: "The episodes the file holds, each with SONARR's title for it (the issue's numbers are the media server's)",
                    items: {
                      type: "object",
                      required: ["seasonNumber", "episodeNumber", "title"],
                      properties: { seasonNumber: { type: "integer" }, episodeNumber: { type: "integer" }, title: { type: "string", nullable: true } },
                    },
                  },
                  grab: {
                    type: "object",
                    nullable: true,
                    description: "The grab that produced the file; null when the title's history can't tell — the file is then searched for, not blocklisted",
                    required: ["event", "failed"],
                    properties: {
                      event: ARR_HISTORY_EVENT,
                      failed: { type: "boolean", description: "A failure was already recorded for its download — marking it again is refused, so the file is searched for instead" },
                    },
                  },
                },
              },
            },
            otherFiles: { type: "integer", description: "The title's files outside the issue's scope (not listed)" },
          } } } },
        },
        "202": jobAnswer("With ?job=: the replace is still running — { job, running: true }", JOB_RUNNING),
        "400": { description: "Invalid instance slug (or one over 100 characters), or the arr rejected the read (its validation messages in `messages`)" },
        "403": { description: "Forbidden — ADMIN only" },
        "404": { description: "Issue not found, the title isn't on that instance, the instance isn't configured, or the integration is off; or (with ?job=) the job is gone — reload the issue" },
        "409": { description: "Issue is RESOLVED, or the arr refused in its own words (masked)" },
        "422": { description: "A SEASON/EPISODE issue without its season/episode number" },
        "502": { description: "Radarr/Sonarr failed (worded by kind: API key, unreachable, server)" },
        "504": { description: "Radarr/Sonarr timed out" },
      },
    },
    post: {
      tags: ["Issues"],
      summary: "Delete an issue's broken files, then blocklist their release or search again (ADMIN)",
      description:
        "Deletes the named files (while a file is on disk Radarr/Sonarr only take an upgrade of it), then follows up as " +
        "`then` says; the whole plan is guardrail 5f. The files and history are re-read: every id must be one of the " +
        "issue's in-scope files, or 409 with nothing deleted. The issue is claimed IN_PROGRESS (compare-and-swap) before " +
        "the delete, and whatever the delete unmonitored (\"Unmonitor Deleted Movies/Episodes\") is monitored again before " +
        "any mark or search. Records an instance-scoped IssueGrab. Audited ARR_FILE_DELETE, ARR_TITLE_EDIT (the " +
        "re-monitor), ARR_MARK_FAILED and ISSUE_STATUS_CHANGE. One replace per issue at a time, process-wide (a second " +
        "POST while one runs is 409, nothing written or sent). With `async: true` everything after the status claim runs " +
        "as a background job — 202 { job } at once, poll GET ?job= (a long series' marks outlast a reverse proxy's hold); " +
        "the synchronous default stays for API callers.",
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      requestBody: {
        required: true,
        content: { "application/json": { schema: {
          type: "object",
          required: ["fileIds", "then"],
          properties: {
            instance: { type: "string", description: "Arr instance slug; defaults to the default instance" },
            fileIds: { type: "array", items: { type: "integer", minimum: 1 }, minItems: 1, maxItems: ISSUE_FILES_MAX_IDS },
            then: {
              type: "string",
              enum: ["markFailed", "search"],
              description:
                "`markFailed`: mark each deleted file's grab failed, one mark per download, so the arr's Redownload Failed " +
                "searches again; the search is queued here instead when that won't (switched off or unreadable, a grab " +
                "picked by hand with \"Redownload Failed from Interactive Search\" off, or an item still unmonitored). " +
                "Files with no known grab, or an already-failed one, are searched for. `search`: a search scoped to the " +
                "deleted files (Radarr MoviesSearch; Sonarr EpisodeSearch, or SeasonSearch where a whole season went) — " +
                "never SeriesSearch.",
            },
            async: { type: "boolean", description: "Run everything after the status CAS as a background job: 202 { job } at once, poll GET ?job=. The same admin posting for the same issue while it runs joins it (no rate token spent). Default (absent/false): synchronous." },
          },
        } } },
      },
      responses: {
        "200": {
          description: "Deleted and followed up",
          content: { "application/json": { schema: { type: "object", properties: {
            deleted: { type: "integer" }, requested: { type: "integer" },
            marked: { type: "integer", description: "Downloads marked failed" },
            unmarked: { type: "integer", description: "Marks refused or failed — those files were searched for instead" },
            searched: { type: "boolean" },
            redownload: { type: "boolean", nullable: true, description: "The arr's Redownload Failed switch, read when a mark was planned" },
            redownloading: { type: "integer", description: "Marks the arr's own redownload searches for (no search of ours for their files)" },
            remonitored: { type: "integer", description: "Episodes (Sonarr) or the movie (Radarr: 1) the delete unmonitored and that were monitored again" },
            remonitorFailed: { type: "boolean", description: "Re-reading or re-monitoring failed — the files were searched for by name, and may stay unmonitored in the arr" },
            nothingMissing: { type: "boolean" },
          } } } },
        },
        "202": jobAnswer("async: true — { job }: the replace runs in the background; poll GET ?job= (the same admin re-posting while it runs gets the same job id)", JOB_STARTED),
        "400": { description: "Malformed JSON or body (fileIds / then / async), an invalid instance slug, or the arr rejected a read (its messages in `messages`)" },
        "403": { description: "Forbidden — ADMIN only" },
        "404": { description: "Issue not found, the title isn't on that instance, or the instance isn't configured" },
        "409": { description: "Issue is RESOLVED (before or during), a file isn't one of the issue's in-scope files, or a Replace file is already running for this issue — nothing deleted" },
        "413": { description: "Request body over the 64 KB cap" },
        "422": { description: "A SEASON/EPISODE issue without its season/episode number" },
        "429": { description: "Rate limited (10 per minute per admin); Retry-After header", headers: RETRY_AFTER_HEADER },
        "502": { description: "Radarr/Sonarr failed; or files were deleted but the delete stopped part-way / the search couldn't be queued — the body then carries the 200 counts plus an `error`" },
        "503": { description: "Maintenance mode" },
        "504": { description: "Radarr/Sonarr timed out before anything was deleted" },
      },
    },
  },
  "/issues/{id}/releases": {
    post: {
      tags: ["Issues"],
      summary: "Grab a specific release for the issue's media (ADMIN / ISSUE_ADMIN)",
      description:
        "CAS-claims the issue to IN_PROGRESS before the grab, then records an instance-scoped IssueGrab row. Routes to Radarr for a MOVIE issue and Sonarr for a TV one. The `guid` is an opaque handle from the GET on this path (bound to this issue and instance, 30-minute TTL, single use) — never a raw indexer guid; `indexerId` is checked but the handle names the indexer. A TV issue must be searchable as a season or an episode (Sonarr has no whole-series release search): a FULL issue, or a SEASON/EPISODE one without its numbers, is 422 before the handle claim and the CAS.",
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["guid", "indexerId"],
              properties: {
                guid: { type: "string", minLength: 1, maxLength: 500, description: "Opaque release handle (32 hex) from the GET on this path" },
                indexerId: { type: "integer", minimum: 1 },
                instance: { type: "string", description: "Arr instance slug; defaults to the default instance" },
              },
            },
          },
        },
      },
      responses: {
        "200": { description: "Grab accepted", content: { "application/json": { schema: { type: "object", properties: { ok: { type: "boolean" } } } } } },
        "400": { description: "Missing or malformed guid / indexerId, or an invalid instance slug" },
        "403": { description: "Forbidden — ADMIN or ISSUE_ADMIN only" },
        "404": { description: "Issue not found, or the service's integration is switched off (feature.integration.radarr / sonarr)" },
        "409": { description: "Issue is already RESOLVED (the handle is handed back), another grab with the same handle is in flight, or the indexer/download client refused the release (the arr's reason, masked)" },
        "410": { description: "The handle is unknown, expired, spent or from another search (a raw guid included), or the arr's own 30-minute search cache no longer has the release — search again" },
        "413": { description: "Request body over the 64 KB cap" },
        "422": { description: "Instance not configured, TVDB resolution failed, or the issue scope is invalid — a TV issue whose scope is FULL, or SEASON/EPISODE without its season/episode number (Sonarr can only search a season or an episode)" },
        "502": { description: "Radarr/Sonarr rejected the grab" },
        "503": { description: "Maintenance mode" },
      },
    },
    get: {
      tags: ["Issues"],
      summary: "Get Sonarr/Radarr releases for issue media (ADMIN / ISSUE_ADMIN)",
      description:
        "Interactive search on one instance for the issue's scope: a MOVIE issue on Radarr; a TV issue on Sonarr for its SEASON or EPISODE " +
        "(a FULL issue, or one missing its numbers, is 422 — Sonarr's series-only release query is the indexers' RSS feed). Answers the bare " +
        "projected `ArrRelease` list (no download URL) — the wire shape the iOS app decodes — with each release's `guid` replaced by an " +
        "OPAQUE handle (32 hex chars) bound to this issue, service and instance for 30 minutes; POST it back to grab. With `async=1` the " +
        "search answers 202 `{ job }` at once and runs in the background (a Sonarr season search can outlast a reverse proxy's hold); " +
        "GET `?job=<id>` answers 202 while it runs, then the search's own status and body, 404 once the job is gone. The same admin " +
        "re-searching the same issue and instance while one runs joins it.",
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string" } },
        { name: "instance", in: "query", schema: { type: "string" }, description: "Arr instance slug; defaults to the default instance" },
        { name: "async", in: "query", schema: { type: "string", enum: ["1"] }, description: "Run the search as a background job" },
        { name: "job", in: "query", schema: { type: "string", pattern: "^[0-9a-f]{32}$" }, description: "Poll a background search (when present the issue is not read)" },
      ],
      responses: {
        "200": {
          description: "The projected releases, each `guid` an opaque handle",
          content: { "application/json": { schema: { type: "array", items: ARR_RELEASE } } },
        },
        "202": jobAnswer(
          "{ job } — a background search started (`async=1`), or the same search already running was joined; polling `?job=` answers { job, running: true } while it runs",
          SEARCH_JOB,
        ),
        "400": { description: "Invalid instance slug" },
        "403": { description: "Forbidden — ADMIN or ISSUE_ADMIN only" },
        "404": { description: "Issue not found, the service's integration is switched off (feature.integration.radarr / sonarr), or (with `?job=`) the job is gone — expired, not the caller's, or a restart; search again" },
        "422": { description: "Instance not configured, TVDB resolution failed, or a TV issue whose scope is FULL, or SEASON/EPISODE without its season/episode number (Sonarr can only search a season or an episode)" },
        "429": { description: "More than 20 searches a minute by this admin (Retry-After set); joining a search already running costs none", headers: RETRY_AFTER_HEADER },
        "502": { description: "Radarr/Sonarr could not be reached or failed" },
      },
    },
  },
  "/report": {
    post: {
      tags: ["Issues"],
      summary: "Report objectionable content (native app)",
      description: "Writes a CONTENT_REPORT audit row for the admins. The reported content must exist. 10 reports per hour per user; refused with 503 while maintenance mode applies to the caller.",
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["contentType", "contentId"], properties: {
        contentType: { type: "string", enum: ["issue_message", "vote_reason", "issue"] },
        contentId: { type: "string", maxLength: 200, description: "The id of the IssueMessage, DeletionVote or Issue" },
        context: { type: "string", maxLength: 200, description: "Optional; cut to 200 characters" },
        reason: { type: "string", maxLength: 500, description: "Optional; cut to 500 characters" },
      } } } } },
      responses: {
        "200": { description: "{ ok: true } — report received (a repeat report of the same item by the same caller answers ok without a second record)", content: { "application/json": { schema: OK_TRUE } } },
        "400": { description: "Unknown contentType or missing/oversized contentId" },
        "404": { description: "The content does not exist, or it is an issue or issue message the caller can't see (only the reporter's own, or any with MANAGE_ISSUES), or a vote reason the votes list would not show the caller: a vote with no reason, the caller's own vote, a title held only on a server the caller has no grant for, or the votes feature switched off" },
        "413": tooLargeAnswer(32 * 1024),
        "429": { description: "Rate limited (10/hour)" },
        "503": { description: "Maintenance mode" },
      },
    },
  },
  "/issues/{id}/claim": {
    post: {
      tags: ["Issues"],
      summary: "Claim, release or take over an issue (ADMIN / ISSUE_ADMIN)",
      description: "A toggle: unclaimed → claim for the caller; claimed by the caller → release; claimed by someone else → take over. Replies on a claimed issue narrow to the claimer and the reporter.",
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      requestBody: { required: false, content: { "application/json": { schema: { type: "object", properties: {
        expectedClaimedBy: { type: "string", nullable: true, description: "Who the caller saw as the claimer (null = unclaimed). When present and it no longer matches, the call is refused with 409 instead of silently taking over. Omit to toggle without the check" },
      } } } } },
      responses: {
        "403": forbiddenAnswer("the ADMIN or ISSUE_ADMIN role"),
        "200": {
          description: "{ id, claimedBy, claimedAt, claimedUser: { id, name, email } | null } after the change",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["id", "claimedBy", "claimedAt", "claimedUser"],
                properties: {
                  id: { type: "string" },
                  claimedBy: { type: "string", nullable: true, description: "The claimer's user id; null once released" },
                  claimedAt: { type: "string", format: "date-time", nullable: true },
                  claimedUser: {
                    type: "object",
                    nullable: true,
                    required: ["id", "name", "email"],
                    properties: { id: { type: "string" }, name: { type: "string", nullable: true }, email: { type: "string" } },
                  },
                },
              },
            },
          },
        },
        "400": { description: "`expectedClaimedBy` is neither null nor a string" },
        "404": { description: "No such issue, or it was deleted during the claim" },
        "409": { description: "{ error: \"claim-conflict\", message } — the claim changed since the caller read it" },
        "413": tooLargeAnswer(8 * 1024),
        "503": { description: "Maintenance mode" },
      },
    },
  },
};
