import type { ChipTone } from "@/components/ui/design";
import type { IssueStatus, IssueType, RequestStatus } from "@/generated/prisma";

// Single source of truth for the request/issue status chips and issue-type
// display labels. These maps were previously copy-pasted across the requests
// page, admin-request-list, both issues pages, and the mobile issue drawer —
// and the copies drifted ("Bad video" vs "Bad video quality"). Add new
// statuses/types here, not at the call sites. (The longer descriptive labels in
// the report-issue dialog are filing-form option text, a separate concern.)
//
// Each map is indexed by a plain string (callers read rows from JSON), but
// `satisfies` the Prisma enum, so a new status or type fails to compile until
// it has an entry here.

export const REQUEST_STATUS_TONE: Record<string, ChipTone> = {
  PENDING: "pending",
  APPROVED: "approved",
  DECLINED: "declined",
  // Its own tone, not `approved`: both used to render `.ds-chip-approved`, so a
  // requester scanning their list couldn't tell "approved, still downloading"
  // from "ready to watch" without reading each chip. Picked up by every
  // consumer (requests page, admin queue) — pinned in tests/status-labels.test.mts.
  AVAILABLE: "accent",
} satisfies Record<RequestStatus, ChipTone>;

// Message keys for the request status labels (the queue's chips, the status
// filter). A status with no entry has no label: callers show it as stored
// rather than build a key that may not exist.
export const REQUEST_STATUS_LABEL_KEY: Record<string, string> = {
  PENDING: "requests.status.pending",
  APPROVED: "requests.status.approved",
  DECLINED: "requests.status.declined",
  AVAILABLE: "requests.status.available",
} satisfies Record<RequestStatus, string>;

export const ISSUE_STATUS_TONE: Record<string, ChipTone> = {
  OPEN: "declined",
  IN_PROGRESS: "pending",
  RESOLVED: "approved",
} satisfies Record<IssueStatus, ChipTone>;

// Message keys for the issue status and type labels. Every surface that shows
// them is translated (both issues pages, the mobile drawer, admin stats), so the
// English text lives only in the catalog — there are no English maps here.
export const ISSUE_STATUS_LABEL_KEY: Record<string, string> = {
  OPEN: "personal.issues.status.open",
  IN_PROGRESS: "personal.issues.status.inProgress",
  RESOLVED: "personal.issues.status.resolved",
} satisfies Record<IssueStatus, string>;

export const ISSUE_TYPE_LABEL_KEY: Record<string, string> = {
  BAD_VIDEO: "personal.issues.type.badVideo",
  WRONG_AUDIO: "personal.issues.type.wrongAudio",
  MISSING_SUBTITLES: "personal.issues.type.missingSubtitles",
  WRONG_MATCH: "personal.issues.type.wrongMatch",
  OTHER: "personal.issues.type.other",
} satisfies Record<IssueType, string>;

// Issue dates: fixed fields and a UTC pin, so the server-rendered issues list
// and the client mobile drawer print the same date for a given locale.
export function issueDateFormat(locale: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(locale, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}
