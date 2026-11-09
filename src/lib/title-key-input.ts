import { NextResponse } from "next/server";
import { isTmdbIdInRange } from "@/lib/tmdb-id";
import type { Translator } from "@/lib/i18n/translate";

// The (tmdbId, mediaType) title key and its optional title/reason text, as the
// admin blacklist and cleanup-protection routes receive them. One checker, so
// the two can't answer the same bad input differently.

export type TitleKey = { tmdbId: number; mediaType: "MOVIE" | "TV" };
export type TitleKeyFields = TitleKey & { title: string | undefined; reason: string | undefined };

const TEXT_MAX = 500;
const bad = (error: string) => NextResponse.json({ error }, { status: 400 });

/** A POST body: the key plus optional `title` / `reason` (each at most 500 characters). */
export function parseTitleKeyBody(body: { tmdbId?: unknown; mediaType?: unknown; title?: unknown; reason?: unknown }, t: Translator): TitleKeyFields | NextResponse {
  const { tmdbId, mediaType, title, reason } = body;
  // isTmdbIdInRange also bounds INT4: a larger id would throw out of the write as a 500.
  if (typeof tmdbId !== "number" || !isTmdbIdInRange(tmdbId)) return bad(t("apiAdmin.common.tmdbIdPositive"));
  if (mediaType !== "MOVIE" && mediaType !== "TV") return bad(t("apiAdmin.common.mediaTypeMovieOrTv"));
  if (title !== undefined && (typeof title !== "string" || title.length > TEXT_MAX)) return bad(t("apiAdmin.common.titleTooLong"));
  if (reason !== undefined && (typeof reason !== "string" || reason.length > TEXT_MAX)) return bad(t("apiAdmin.common.reasonTooLong"));
  return { tmdbId, mediaType, title, reason };
}

/** A DELETE's query string (`?tmdbId=&mediaType=`; DELETE bodies are stripped by some proxies). */
export function parseTitleKeyQuery(params: URLSearchParams, t: Translator): TitleKey | NextResponse {
  const tmdbId = Number(params.get("tmdbId"));
  const mediaType = params.get("mediaType");
  if (!isTmdbIdInRange(tmdbId) || (mediaType !== "MOVIE" && mediaType !== "TV")) return bad(t("apiAdmin.common.tmdbIdAndMediaTypeRequired"));
  return { tmdbId, mediaType };
}
