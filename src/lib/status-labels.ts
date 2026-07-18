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
