import type { ChipTone } from "@/components/ui/design";

// Single source of truth for the request/issue status chips and issue-type
// display labels. These maps were previously copy-pasted across the requests
// page, admin-request-list, both issues pages, and the mobile issue drawer —
// and the copies drifted ("Bad video" vs "Bad video quality"). Add new
// statuses/types here, not at the call sites. (The longer descriptive labels in
// the report-issue dialog are filing-form option text, a separate concern.)

export const REQUEST_STATUS_TONE: Record<string, ChipTone> = {
  PENDING: "pending",
  APPROVED: "approved",
  DECLINED: "declined",
  // Its own tone, not `approved`: both used to render `.ds-chip-approved`, so a
  // requester scanning their list couldn't tell "approved, still downloading"
  // from "ready to watch" without reading each chip. Picked up by every
  // consumer (requests page, admin queue) — pinned in tests/status-labels.test.mts.
  AVAILABLE: "accent",
};

export const ISSUE_STATUS_TONE: Record<string, ChipTone> = {
  OPEN: "declined",
  IN_PROGRESS: "pending",
  RESOLVED: "approved",
};

// Message keys for the issue status and type labels. Every surface that shows
// them is translated (both issues pages, the mobile drawer, admin stats), so the
// English text lives only in the catalog — there are no English maps here.
export const ISSUE_STATUS_LABEL_KEY: Record<string, string> = {
  OPEN: "personal.issues.status.open",
  IN_PROGRESS: "personal.issues.status.inProgress",
  RESOLVED: "personal.issues.status.resolved",
};

export const ISSUE_TYPE_LABEL_KEY: Record<string, string> = {
  BAD_VIDEO: "personal.issues.type.badVideo",
  WRONG_AUDIO: "personal.issues.type.wrongAudio",
  MISSING_SUBTITLES: "personal.issues.type.missingSubtitles",
  WRONG_MATCH: "personal.issues.type.wrongMatch",
  OTHER: "personal.issues.type.other",
};

// Issue dates: fixed fields and a UTC pin, so the server-rendered issues list
// and the client mobile drawer print the same date for a given locale.
export function issueDateFormat(locale: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(locale, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}
