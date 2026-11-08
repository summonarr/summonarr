// The fix-match pickers' read of GET /api/admin/fix-match/candidates (the Plex
// picker and the Jellyfin confirmation card): one fetch, the answer checked
// against the route's own shape before a dialog renders it, and its failure
// worded once. The route builds the answer with `satisfies CandidatesResponse`;
// this schema is held to that same type below, so the two can't drift apart.
//
// A body that isn't the shape (a reverse proxy's sign-in page, a changed route)
// is a failure the dialog shows, never a half-read object the modal crashes on.
import { withBasePath } from "@/lib/base-path";
import { fetchJson, type FetchJsonResult } from "@/lib/client/fetch-json";
import { apiErrorText } from "@/lib/client/api-error";
import { v, type Infer } from "@/lib/validate";
import type { Translator } from "@/lib/i18n/translate";
import type { CandidatesResponse } from "@/lib/fix-match-candidates";

const PlexCandidateSchema = v.object({
  guid: v.string(),
  name: v.string(),
  year: v.nullable(v.number()),
  thumb: v.nullable(v.string()),
  score: v.nullable(v.number()),
  imdbId: v.nullable(v.string()),
  tmdbId: v.nullable(v.string()),
  tmdbTitle: v.nullable(v.string()),
  tmdbOverview: v.nullable(v.string()),
  tmdbRuntime: v.nullable(v.number()),
  tmdbGenres: v.array(v.string()),
  tmdbVoteAvg: v.nullable(v.number()),
  tmdbPosterPath: v.nullable(v.string()),
  matchLevel: v.literal("exact", "strong", "likely", "possible", "wrong", "unknown"),
  confidence: v.number(),
  titleSimilarity: v.number(),
  radarrConfirmed: v.boolean(),
  suggested: v.boolean(),
});

export const CandidatesResponseSchema = v.object({
  candidates: v.array(PlexCandidateSchema),
  targetTitle: v.string(),
  targetYear: v.string(),
  targetImdbId: v.string(),
  targetPosterPath: v.nullable(v.string()),
  targetOverview: v.string(),
  targetReleaseDate: v.nullable(v.string()),
  targetVoteAverage: v.nullable(v.number()),
  targetRuntime: v.nullable(v.number()),
  targetGenres: v.array(v.string()),
  arrConfirmedTmdbId: v.nullable(v.number()),
  arrConfirmedTitle: v.nullable(v.string()),
  arrPathAgrees: v.nullable(v.boolean()),
  ratingKey: v.string(),
  plexFilePath: v.nullable(v.string()),
  jellyfinFilePath: v.nullable(v.string()),
  serverInstance: v.string(),
  currentTitle: v.nullable(v.string()),
  currentYear: v.nullable(v.string()),
});

// Both directions: a field the route adds or retypes fails to compile here
// until the schema follows it.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const schemaMatchesRoute: Same<Infer<typeof CandidatesResponseSchema>, CandidatesResponse> = true;
void schemaMatchesRoute;

export interface CandidatesQuery {
  server: "plex" | "jellyfin";
  /** The library row's current (wrong) id. */
  tmdbId: number;
  mediaType: "MOVIE" | "TV";
  correctTmdbId: number;
  arrTmdbId?: number | null;
  /** "" (the default server) is left out, so the query is the pre-multi-server one. */
  serverInstance?: string;
}

export function candidatesUrl(q: CandidatesQuery): string {
  const params = new URLSearchParams({ server: q.server, tmdbId: String(q.tmdbId), mediaType: q.mediaType, correctTmdbId: String(q.correctTmdbId) });
  if (q.arrTmdbId) params.set("arrTmdbId", String(q.arrTmdbId));
  if (q.serverInstance) params.set("serverInstance", q.serverInstance);
  return withBasePath(`/api/admin/fix-match/candidates?${params}`);
}

export function fetchFixMatchCandidates(q: CandidatesQuery, signal?: AbortSignal): Promise<FetchJsonResult<CandidatesResponse>> {
  // The route waits on Plex, TMDB and every Radarr/Sonarr; give it room.
  return fetchJson(candidatesUrl(q), { schema: CandidatesResponseSchema, signal, timeoutMs: 90_000 });
}

/** What a failed candidates read tells the admin: the route's own reason, else what went wrong. */
export function candidatesErrorText(res: Extract<FetchJsonResult<unknown>, { ok: false }>, t: Translator): string {
  if (res.kind === "http") return apiErrorText(res.body, t("adminQueue.common.requestFailed", { status: res.status }));
  if (res.kind === "invalid") return t("adminQueue.common.requestFailed", { status: res.status });
  return t("shared.thread.networkError");
}
