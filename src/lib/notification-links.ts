// Pure, dependency-free link helper shared by the notification bell (header) and
// the /notifications list. Kept in one place so the link-routing rules (notably the
// ISSUE_* → /issues rule) can't drift between the two renderers.

export interface NotificationLinkFields {
  type: string;
  tmdbId: number | null;
  mediaType: "MOVIE" | "TV" | null;
}

// Where clicking a notification takes the user. ISSUE_* rows go to the issues
// page; REQUEST_COMMENT rows to the requests page; other media-typed rows to the title page; everything else to requests.
export function notificationHref(n: NotificationLinkFields): string {
  if (n.type.startsWith("ISSUE")) return "/issues";
  // A comment lives on the request, not the title page.
  if (n.type === "REQUEST_COMMENT") return "/requests";
  // A concurrent-stream alert is for admins; the live sessions are on Activity.
  if (n.type === "STREAM_LIMIT") return "/admin/activity";
  if (n.tmdbId && n.mediaType === "MOVIE") return `/movie/${n.tmdbId}`;
  if (n.tmdbId && n.mediaType === "TV") return `/tv/${n.tmdbId}`;
  return "/requests";
}
