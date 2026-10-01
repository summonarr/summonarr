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
  AVAILABLE: "approved",
};

export const REQUEST_STATUS_LABEL: Record<string, string> = {
  PENDING: "Pending",
  APPROVED: "Approved",
  DECLINED: "Declined",
  AVAILABLE: "Available",
};

export const ISSUE_STATUS_TONE: Record<string, ChipTone> = {
  OPEN: "declined",
  IN_PROGRESS: "pending",
  RESOLVED: "approved",
};

export const ISSUE_STATUS_LABEL: Record<string, string> = {
  OPEN: "Open",
  IN_PROGRESS: "In Progress",
  RESOLVED: "Resolved",
};

export const ISSUE_TYPE_LABELS: Record<string, string> = {
  BAD_VIDEO: "Bad video quality",
  WRONG_AUDIO: "Wrong / missing audio",
  MISSING_SUBTITLES: "Missing subtitles",
  WRONG_MATCH: "Wrong match",
  OTHER: "Other",
};

// i18n keys for the same labels, for translated surfaces (the user's own
// /issues page). The English maps above stay for the untranslated callers.
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

// Locale-aware twin of ISSUE_DATE_FORMAT below — same fields and UTC pin, so the
// server-rendered list and the client drawer still agree for a given locale.
export function issueDateFormat(locale: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(locale, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

// Fixed locale + timezone so the desktop issues list/pane (server-rendered) and
// the mobile issue drawer (client) print the same date for the same issue.
export const ISSUE_DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
