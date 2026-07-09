// Pure, dependency-free helpers shared by the notification bell (header) and the
// /notifications list. Kept in one place so the link-routing rules (notably the
// ISSUE_* → /issues rule) can't drift between the two renderers.

export interface NotificationLinkFields {
  type: string;
  tmdbId: number | null;
  mediaType: "MOVIE" | "TV" | null;
}

// Where clicking a notification takes the user. ISSUE_* rows go to the issues
// page; media-typed rows to the title page; everything else to requests.
export function notificationHref(n: NotificationLinkFields): string {
  if (n.type.startsWith("ISSUE")) return "/issues";
  if (n.tmdbId && n.mediaType === "MOVIE") return `/movie/${n.tmdbId}`;
  if (n.tmdbId && n.mediaType === "TV") return `/tv/${n.tmdbId}`;
  return "/requests";
}

// Relative "time ago". `nowMs` is injectable for testing and defaults to now;
// callers in "use client" components must still invoke this behind a mounted gate
// (guardrail 16) so the server/client render never disagrees.
export function timeAgo(iso: string, nowMs: number = Date.now()): string {
  const s = Math.max(0, Math.floor((nowMs - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
