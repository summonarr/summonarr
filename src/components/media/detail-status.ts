import type { Translator } from "@/lib/i18n/translate";

// TMDB's movie/TV `status` values → i18n keys (detail.json). TMDB sends these
// in English regardless of the request language; anything unlisted is shown
// as TMDB sent it.
const STATUS_KEYS: Record<string, string> = {
  Released: "detail.status.released",
  "In Production": "detail.status.inProduction",
  "Post Production": "detail.status.postProduction",
  Planned: "detail.status.planned",
  Rumored: "detail.status.rumored",
  Canceled: "detail.status.canceled",
  "Returning Series": "detail.status.returningSeries",
  Ended: "detail.status.ended",
  Pilot: "detail.status.pilot",
};

export function translateTmdbStatus(status: string, t: Translator): string {
  const key = STATUS_KEYS[status];
  return key ? t(key) : status;
}
