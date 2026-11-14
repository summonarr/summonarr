// How the library page's "Sync episodes" button reads POST /api/sync/tv-episodes
// (sync-tv-episodes-button.tsx). Pure and directive-free, so the unit suite
// loads it (tests/sync-buttons.test.mts).
//
// The button runs the rebuild as a background job (POST { async: true }, then
// GET ?job= — guardrail 37a): the walk outlasts a reverse proxy's hold, and a
// held-open request showed the proxy's 504 as a failed sync while the server
// finished. `tvEpisodeJobOutcome` reads the job's answer.
//
// The route rebuilds Plex and Jellyfin independently and answers 200 with both
// counts and any per-source errors: one source failing leaves its cache as it
// was while the other's is rewritten, so the counts are shown beside the errors.
import type { FetchJsonResult } from "@/lib/client/fetch-json";
import type { Translator } from "@/lib/i18n/translate";
import { isNoAnswer, jobAnswerError } from "@/lib/client/library-sync";
import { check, v, type Infer } from "@/lib/validate";

export const TV_EPISODE_SYNC_ANSWER = v.object({
  plex: v.optional(v.number()),
  jellyfin: v.optional(v.number()),
  errors: v.optional(v.array(v.string())),
  // Not a 200 the route sends today; read so one can never pass as a success.
  error: v.optional(v.string()),
});
export type TvEpisodeSyncAnswer = Infer<typeof TV_EPISODE_SYNC_ANSWER>;

export interface TvEpisodeSyncOutcome {
  status: "done" | "error";
  text: string;
  /** A cache was rewritten, so the page's counts are stale. */
  refresh: boolean;
}

/** The result line for one run, or null when the run was dropped (the button went away). */
export function tvEpisodeSyncOutcome(
  res: FetchJsonResult<TvEpisodeSyncAnswer>,
  t: Translator,
  locale: string,
): TvEpisodeSyncOutcome | null {
  if (!res.ok) {
    if (res.kind === "aborted") return null;
    // A refusal names its own reason. No answer at all — the request failed, a
    // proxy's own error page, or a 2xx that isn't the route's JSON — is a
    // failed sync, never a successful "0 episodes".
    const text = res.kind === "http"
      ? res.error || t("adminManage.users.error.requestFailed", { status: res.status })
      : t("adminManage.library.btn.syncFailed");
    return { status: "error", text, refresh: false };
  }
  const data = res.data;
  if (data.error) return { status: "error", text: data.error, refresh: false };

  const plex = data.plex ?? 0;
  const jellyfin = data.jellyfin ?? 0;
  const total = plex + jellyfin;
  // Same locale grouping as the total — "Plex 12345 · 13,023 episodes" mixed
  // grouped and ungrouped digits in one line.
  const parts: string[] = [];
  if (plex > 0) parts.push(`Plex ${plex.toLocaleString(locale)}`);
  if (jellyfin > 0) parts.push(`Jellyfin ${jellyfin.toLocaleString(locale)}`);
  const counts = parts.length > 0
    ? t("adminManage.library.btn.episodesWithParts", { count: total, formatted: total.toLocaleString(locale), parts: parts.join(", ") })
    : t("adminManage.library.btn.episodes", { count: 0, formatted: "0" });
  const errors = data.errors ?? [];
  if (errors.length === 0) return { status: "done", text: counts, refresh: true };
  // Still red when a source failed, so the failure stays prominent; the page
  // still refreshes when the other source's cache was rewritten.
  return {
    status: "error",
    text: total > 0 ? `${counts} · ${errors.join("; ")}` : errors.join("; "),
    refresh: total > 0,
  };
}

/**
 * The result line for a background run's answer (status 0 = none came).
 * No answer — the polls failed or ran out, or a gateway's own 502/503/504
 * stood in for the app — is never a failure: the rebuild may still be running.
 */
export function tvEpisodeJobOutcome(
  answer: { status: number; data: unknown },
  t: Translator,
  locale: string,
): TvEpisodeSyncOutcome {
  if (isNoAnswer(answer)) {
    return { status: "done", text: t("adminManage.library.btn.episodesNoAnswer"), refresh: false };
  }
  const failed = (kind: "http" | "invalid"): FetchJsonResult<TvEpisodeSyncAnswer> =>
    ({ ok: false, kind, status: answer.status, error: jobAnswerError(answer) ?? "", body: null, detail: "" });
  let res: FetchJsonResult<TvEpisodeSyncAnswer>;
  if (answer.status < 200 || answer.status >= 300) {
    res = failed("http");
  } else {
    const read = check(TV_EPISODE_SYNC_ANSWER, answer.data);
    res = read.ok ? { ok: true, status: answer.status, data: read.value } : failed("invalid");
  }
  // Never null: only an aborted read is dropped, and a job answer is not one.
  return tvEpisodeSyncOutcome(res, t, locale) ?? { status: "error", text: t("adminManage.library.btn.syncFailed"), refresh: false };
}
