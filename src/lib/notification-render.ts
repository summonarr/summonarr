// Read-time rendering of in-app notification rows in the READER's language.
//
// A Notification row stores its title/body as English text (the shape the iOS
// app and older clients read) plus, since the `data` column landed, the values
// that text was built from. Pure and zero-import beyond types, so the API route,
// the /notifications page and tests share one implementation.
//
// Rules:
//   - A row WITH data is rendered from its type + data in the reader's locale.
//     The English render is byte-identical to the stored copy (the writers and
//     this module produce the same strings), so an English reader — and every
//     native client on an English instance — sees exactly what was stored.
//   - A row WITHOUT data (written before the column existed), or with a type or
//     data shape this module does not know, returns the stored title/body as-is.
//   - The title is never translated: it is the media or issue title.

import type { Translator } from "./i18n/translate";

// The stored `data` payloads, one per writer. `v` versions the shape so a later
// change can tell old rows apart; an unknown version falls back to stored text.
export type NotificationData =
  | { v: 1 } // REQUEST_APPROVED | REQUEST_AVAILABLE | REQUEST_DECLINED (body from type + mediaType)
  | { v: 1; resolution: string | null } // ISSUE_RESOLVED
  | { v: 1; author: string; text: string }; // ISSUE_REPLY

export interface RenderableNotification {
  type: string;
  title: string;
  body: string;
  mediaType: "MOVIE" | "TV" | null;
  data?: unknown;
}

// Same cap as buildNotificationData's VarChar(1000) body slice, so a rendered
// body can never be longer than a stored one.
const BODY_MAX = 1000;

const REQUEST_BODY_KEYS: Record<string, { movie: string; tv: string }> = {
  REQUEST_APPROVED: {
    movie: "personal.notifications.body.approvedMovie",
    tv: "personal.notifications.body.approvedTv",
  },
  REQUEST_AVAILABLE: {
    movie: "personal.notifications.body.availableMovie",
    tv: "personal.notifications.body.availableTv",
  },
  REQUEST_DECLINED: {
    movie: "personal.notifications.body.declinedMovie",
    tv: "personal.notifications.body.declinedTv",
  },
};

// The catalog key for a request-status row's body, or null for any other row.
// Shared with the client list/bell, which re-render request rows from type +
// mediaType alone (that works for rows written before `data` existed too).
export function requestBodyKey(type: string, mediaType: "MOVIE" | "TV" | null): string | null {
  const keys = REQUEST_BODY_KEYS[type];
  if (!keys || mediaType == null) return null;
  return mediaType === "MOVIE" ? keys.movie : keys.tv;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function renderBody(n: RenderableNotification, t: Translator): string | null {
  const data = asRecord(n.data);
  if (!data || data.v !== 1) return null;
  if (REQUEST_BODY_KEYS[n.type]) {
    // The writer's English copy reads "TV show" for anything not a movie, but
    // the column only stores MOVIE/TV — a null column keeps the stored text.
    const key = requestBodyKey(n.type, n.mediaType);
    return key ? t(key) : null;
  }
  if (n.type === "ISSUE_RESOLVED") {
    const resolution = data.resolution;
    if (typeof resolution === "string" && resolution !== "") {
      return t("notify.inApp.issueResolvedWith", { resolution });
    }
    if (resolution == null || resolution === "") return t("notify.inApp.issueResolved");
    return null;
  }
  if (n.type === "ISSUE_REPLY") {
    if (typeof data.author !== "string" || typeof data.text !== "string") return null;
    return t("notify.inApp.issueReply", { author: data.author, text: data.text });
  }
  return null;
}

export function renderNotification<T extends RenderableNotification>(
  n: T,
  t: Translator,
): { title: string; body: string } {
  const body = renderBody(n, t);
  return { title: n.title, body: body == null ? n.body : body.slice(0, BODY_MAX) };
}
