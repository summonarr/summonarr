"use client";

// The request queue's "Pick release": an interactive search on the request's
// own Radarr/Sonarr instance (GET/POST /api/requests/[id]/releases). A movie
// searches at once; a series first lists its seasons — Sonarr can only search a
// season or an episode — and searches the first season with missing episodes.
// The release rows are the same projected ArrRelease list the Issue "Replace"
// panel shows (no indexer download URL ever reaches the browser).
//
// With a `target` instead of a request it is the admin title manager's
// "Interactive search" (GET/POST /api/admin/arr/title/releases): one title on
// one instance, for the movie, one season or one episode the manager chose —
// no season picker, it searches at once.
//
// Every answer is checked against its shape (release-search-schema.ts), and a
// refusal shows the route's own reason (a 422 "not configured", a 429 with its
// wait) rather than a generic failure.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { StyledSelect } from "@/components/ui/styled-select";
import { Dialog, DialogBackdrop, DialogClose, DialogPopup, DialogPortal, DialogTitle } from "@/components/ui/dialog";
import { AlertTriangle, Check, ChevronDown, ChevronUp, Download, Loader2, Magnet, Radio, Search, X } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import type { SonarrSeasonSummary } from "@/lib/arr";
import { apiErrorText } from "@/lib/client/api-error";
import { fetchJson, ARR_WRITE_TIMEOUT_MS, jsonInit, type FetchJsonFailure } from "@/lib/client/fetch-json";
import { RELEASE_SEARCH_POLL_MS, runReleaseSearchJob } from "@/lib/client/release-search-job";
import { check } from "@/lib/validate";
import { ageFormatter, sizeFormatter } from "@/components/admin/queue-format";
import { ReleasesAnswer, SeasonsAnswer, type ArrReleaseWire } from "@/components/admin/release-search-schema";
import type { Translator } from "@/lib/i18n/translate";


const SLOW_SEARCH_MS = 15_000;

// The season to search first: the earliest with something missing, else the latest.
export function defaultSeason(seasons: readonly SonarrSeasonSummary[]): number | null {
  if (seasons.length === 0) return null;
  return (seasons.find((s) => s.missing > 0) ?? seasons[seasons.length - 1]).seasonNumber;
}

/** One title on one instance, and what to search for: the movie, a season, or an episode. */
export interface TitleReleaseTarget {
  service: "radarr" | "sonarr";
  instance: string;
  arrId: number;
  scope: { seasonNumber: number } | { episodeId: number } | null;
}

function titleScopeParams(target: TitleReleaseTarget): Record<string, string | number> {
  if (!target.scope) return {};
  return "seasonNumber" in target.scope ? { season: target.scope.seasonNumber } : { episodeId: target.scope.episodeId };
}

// The title search's query string. A string, so the search can depend on the
// target's VALUE: a parent re-render hands a new target object.
function titleReleaseQuery(target: TitleReleaseTarget): string {
  const q = new URLSearchParams({ service: target.service, instance: target.instance, id: String(target.arrId) });
  for (const [k, v] of Object.entries(titleScopeParams(target))) q.set(k, String(v));
  return q.toString();
}

// No answer (the network, or the browser's wait) reads as a network error; a
// refusal is the route's own reason.
function failureText(res: FetchJsonFailure, t: Translator): string {
  return res.kind === "network" || res.kind === "timeout" ? t("shared.thread.networkError") : res.error;
}

type Phase = "seasons" | "releases" | "grab" | null;

// The dialog's reads and grab. Only the newest search may write state —
// switching seasons quickly must never leave one season's releases offered for
// another (the grab would then send that release to the wrong season's
// episodes). Closing the dialog bumps the counter too, so a season list still
// loading never starts an indexer search.
function useReleaseSearch({
  open,
  isTv,
  requestId,
  target,
}: {
  open: boolean;
  isTv: boolean;
  requestId?: string;
  target?: TitleReleaseTarget;
}) {
  const t = useT();
  const titleQuery = target ? titleReleaseQuery(target) : null;
  const [seasons, setSeasons] = useState<SonarrSeasonSummary[] | null>(null);
  const [season, setSeason] = useState<number | null>(null);
  const [releases, setReleases] = useState<ArrReleaseWire[] | null>(null);
  const [loading, setLoading] = useState<Phase>(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [showRejected, setShowRejected] = useState(false);
  const [grabbed, setGrabbed] = useState(false);
  // A search past SLOW_SEARCH_MS says it is still going (indexers are slow, not stuck).
  const [slow, setSlow] = useState(false);
  const seq = useRef(0);
  // The translator through a ref: the request queue router.refresh()es on every
  // request:* event, which hands the provider a new catalog object and so a new
  // `t`. As an effect dependency that re-ran the open-time search (and cleared
  // the "grabbed" confirmation) under an open dialog.
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  }, [t]);

  const search = useCallback(async (s: number | null) => {
    const id = ++seq.current;
    setLoading("releases");
    setError("");
    setReleases(null);
    setSelected(null);
    setShowRejected(false);
    setFilter("");
    setSlow(false);
    try {
      const url = titleQuery !== null
        ? `/api/admin/arr/title/releases?${titleQuery}`
        : `/api/requests/${requestId}/releases${s !== null ? `?season=${s}` : ""}`;
      // In the background (release-search-jobs.ts): indexers can take a minute
      // or two, longer than a reverse proxy keeps one request open. Time is
      // counted in polls, not read off the clock.
      const answer = await runReleaseSearchJob(fetch, withBasePath(url), {
        isAlive: () => id === seq.current,
        onPoll: (polls) => {
          if (polls * RELEASE_SEARCH_POLL_MS >= SLOW_SEARCH_MS) setSlow(true);
        },
      });
      if (answer === null || id !== seq.current) return;
      const failed = tRef.current("adminQueue.releases.failed");
      if (answer.status < 200 || answer.status >= 300) {
        setError(apiErrorText(answer.data, failed));
        return;
      }
      const parsed = check(ReleasesAnswer, answer.data);
      if (!parsed.ok) {
        setError(failed);
        return;
      }
      const list = parsed.value.releases;
      setReleases(list);
      setSelected((list.find((r) => !r.rejected) ?? list[0])?.guid ?? null);
    } catch {
      if (id === seq.current) setError(tRef.current("shared.thread.networkError"));
    } finally {
      if (id === seq.current) setLoading(null);
    }
  }, [requestId, titleQuery]);

  // Fresh state on every open; a movie searches straight away, a series loads
  // its seasons first.
  useEffect(() => {
    if (!open) return;
    const t = tRef.current;
    // The counter object itself (not a value read from it) for the cleanup:
    // closing (or switching request) invalidates whatever is still in flight —
    // a movie's or a title manager's search too, whose poll would otherwise
    // keep running for minutes behind a closed (or unmounted) dialog.
    const counter = seq;
    const invalidate = () => {
      counter.current++;
    };
    setSeasons(null);
    setSeason(null);
    setReleases(null);
    setError("");
    setGrabbed(false);
    // search() takes its own place in the sequence.
    if (!isTv) {
      void search(null);
      return invalidate;
    }
    const id = ++seq.current;
    setLoading("seasons");
    (async () => {
      const res = await fetchJson(withBasePath(`/api/requests/${requestId}/releases`), {
        schema: SeasonsAnswer,
        fallbackError: t("adminQueue.releases.failed"),
      });
      if (id !== seq.current) return;
      if (!res.ok) {
        setError(failureText(res, t));
        setLoading(null);
        return;
      }
      setSeasons(res.data.seasons);
      const first = defaultSeason(res.data.seasons);
      setSeason(first);
      if (first === null) {
        setLoading(null);
        setError(t("adminQueue.releases.noSeasons"));
        return;
      }
      void search(first);
    })();
    return invalidate;
  }, [open, isTv, requestId, search]);

  function pickSeason(next: number) {
    setSeason(next);
    setGrabbed(false);
    void search(next);
  }

  async function grab() {
    const rel = releases?.find((r) => r.guid === selected);
    if (!rel) return;
    setLoading("grab");
    setError("");
    // `guid` on these rows is the server's opaque handle for the release,
    // never the indexer's own guid (which can embed an apikey).
    const res = target
      ? await fetchJson(withBasePath("/api/admin/arr/title/releases"), {
        init: jsonInit("POST", { service: target.service, instance: target.instance, id: target.arrId, release: rel.guid, ...titleScopeParams(target) }),
        // The grab waits on the arr; a slow success must not read as a failure.
        timeoutMs: ARR_WRITE_TIMEOUT_MS,
        fallbackError: t("adminQueue.releases.grabFailed"),
      })
      : await fetchJson(withBasePath(`/api/requests/${requestId}/releases`), {
        init: jsonInit("POST", { release: rel.guid, ...(isTv && season !== null ? { season } : {}) }),
        timeoutMs: ARR_WRITE_TIMEOUT_MS,
        fallbackError: t("adminQueue.releases.grabFailed"),
      });
    setLoading(null);
    if (!res.ok) {
      setError(failureText(res, t));
      return;
    }
    setGrabbed(true);
  }

  return {
    seasons, season, pickSeason, releases, loading, error, selected, setSelected,
    filter, setFilter, showRejected, setShowRejected, grabbed, slow, grab,
  };
}

export function ReleaseSearchDialog({
  open,
  onOpenChange,
  requestId,
  mediaType,
  target,
  subtitle,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The request queue's search — or `target` for the title manager's. */
  requestId?: string;
  mediaType?: string;
  target?: TitleReleaseTarget;
  /** Shown under the heading ("Season 2", "S02E05"). */
  subtitle?: string;
}) {
  const t = useT();
  // A target names its own scope, so it never shows the season picker.
  const isTv = !target && mediaType !== "MOVIE";
  const s = useReleaseSearch({ open, isTv, requestId, target });
  const grabbing = s.loading === "grab";

  let body: React.ReactNode;
  if (s.loading === "seasons" || s.loading === "releases") {
    body = (
      <div className="flex items-center justify-center gap-3 text-sm text-zinc-500 py-16">
        <Loader2 className="w-5 h-5 animate-spin" />
        {s.slow ? t("adminQueue.releases.searchingSlow") : t("adminQueue.releases.searching")}
      </div>
    );
  } else if (s.grabbed) {
    body = (
      <div className="flex items-center justify-center gap-2 text-sm text-green-400 py-16 px-6 text-center">
        <Check className="w-4 h-4 shrink-0" />
        {target
          ? t("adminQueue.releases.grabbedTitle", { service: target.service === "radarr" ? "Radarr" : "Sonarr" })
          : t("adminQueue.releases.grabbed")}
      </div>
    );
  } else if (s.error && s.releases === null) {
    body = (
      <div role="alert" className="flex items-center justify-center gap-2 text-sm py-16 px-6 text-center" style={{ color: "var(--ds-danger)" }}>
        <AlertTriangle className="w-4 h-4 shrink-0" /> {s.error}
      </div>
    );
  } else if ((s.releases ?? []).length === 0) {
    body = <div className="text-sm text-zinc-500 text-center py-16">{t("adminQueue.releases.none")}</div>;
  } else {
    body = (
      <ReleaseList
        releases={s.releases ?? []}
        selected={s.selected}
        onSelect={s.setSelected}
        filter={s.filter}
        onFilter={s.setFilter}
        showRejected={s.showRejected}
        onToggleRejected={() => s.setShowRejected((v) => !v)}
        error={s.error}
        grabbing={grabbing}
        onCancel={() => onOpenChange(false)}
        onGrab={() => void s.grab()}
      />
    );
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && grabbing) return; onOpenChange(o); }}>
      <DialogPortal>
        <DialogBackdrop />
        <DialogPopup className="max-w-3xl">
          <div className="flex items-center justify-between gap-3 px-6 py-4 border-b border-zinc-700 flex-shrink-0">
            <div className="min-w-0">
              <DialogTitle className="text-base font-semibold text-zinc-100">{t("adminQueue.releases.title")}</DialogTitle>
              {subtitle && <p className="m-0 mt-0.5 text-xs text-zinc-500 truncate">{subtitle}</p>}
            </div>
            <div className="flex items-center gap-3">
              {isTv && s.seasons && s.seasons.length > 0 && (
                <SeasonSelect seasons={s.seasons} season={s.season} disabled={s.loading !== null} onPick={s.pickSeason} />
              )}
              <DialogClose
                disabled={grabbing}
                aria-label={t("adminQueue.common.close")}
                title={t("adminQueue.common.close")}
                className="text-zinc-500 hover:text-zinc-300 disabled:opacity-40 transition-colors"
              >
                <X className="w-5 h-5" />
              </DialogClose>
            </div>
          </div>
          {body}
        </DialogPopup>
      </DialogPortal>
    </Dialog>
  );
}

function SeasonSelect({
  seasons,
  season,
  disabled,
  onPick,
}: {
  seasons: readonly SonarrSeasonSummary[];
  season: number | null;
  disabled: boolean;
  onPick: (season: number) => void;
}) {
  const t = useT();
  return (
    <StyledSelect
      compact
      value={season === null ? "" : String(season)}
      onChange={(e) => onPick(Number(e.target.value))}
      disabled={disabled}
      aria-label={t("adminQueue.releases.season")}
      className="w-auto md:text-xs"
    >
      {seasons.map((s) => (
        <option key={s.seasonNumber} value={String(s.seasonNumber)}>
          {s.missing > 0
            ? t("adminQueue.releases.seasonMissing", { number: s.seasonNumber, count: s.missing })
            : t("adminQueue.releases.seasonComplete", { number: s.seasonNumber })}
        </option>
      ))}
    </StyledSelect>
  );
}

// The filter, the releases it leaves, the rejected toggle and the Grab footer.
function ReleaseList({
  releases,
  selected,
  onSelect,
  filter,
  onFilter,
  showRejected,
  onToggleRejected,
  error,
  grabbing,
  onCancel,
  onGrab,
}: {
  releases: readonly ArrReleaseWire[];
  selected: string | null;
  onSelect: (guid: string) => void;
  filter: string;
  onFilter: (filter: string) => void;
  showRejected: boolean;
  onToggleRejected: () => void;
  error: string;
  grabbing: boolean;
  onCancel: () => void;
  onGrab: () => void;
}) {
  const t = useT();
  const locale = useLocale();
  // Once per locale, not on every render (each filter keystroke re-renders).
  const size = useMemo(() => sizeFormatter(locale), [locale]);
  const age = useMemo(() => ageFormatter(locale), [locale]);
  const term = filter.toLowerCase();
  const visible = releases.filter((r) => (showRejected || !r.rejected) && (!term || r.title.toLowerCase().includes(term)));
  const rejectedCount = releases.filter((r) => r.rejected).length;
  // Grab waits for the selection to be visible: the filter never moves it.
  const selectedVisible = visible.some((r) => r.guid === selected);

  return (
    <>
      <div className="px-6 py-3 border-b border-zinc-800 flex-shrink-0">
        <div className="relative flex items-center">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500 pointer-events-none" />
          <input
            type="text"
            value={filter}
            onChange={(e) => onFilter(e.target.value.slice(0, 200))}
            placeholder={t("adminQueue.issueActions.filterPlaceholder")}
            aria-label={t("adminQueue.issueActions.filterAria")}
            className="w-full bg-zinc-800 border border-zinc-700 rounded-md pl-10 pr-3 py-2.5 text-sm text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-indigo-500/60 focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
      </div>

      <div className="overflow-y-auto flex-1 divide-y divide-zinc-800">
        {visible.map((rel) => (
          <ReleaseRow key={rel.guid} rel={rel} selected={selected === rel.guid} onSelect={() => onSelect(rel.guid)} size={size} age={age} />
        ))}
        {visible.length === 0 && (
          <p className="text-xs text-zinc-500 text-center py-8">{t("adminQueue.issueActions.noMatch", { filter })}</p>
        )}
      </div>

      {rejectedCount > 0 && (
        <button
          type="button"
          onClick={onToggleRejected}
          className="w-full flex items-center justify-center gap-1.5 py-2 text-xs text-zinc-500 hover:text-zinc-400 border-t border-zinc-800 transition-colors flex-shrink-0"
        >
          {showRejected ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          {showRejected
            ? t("adminQueue.issueActions.hideRejected", { count: rejectedCount })
            : t("adminQueue.issueActions.showRejected", { count: rejectedCount })}
        </button>
      )}

      <div className="flex items-center justify-between gap-3 px-6 py-4 border-t border-zinc-700 bg-zinc-900 flex-shrink-0">
        <div className="min-w-0">
          {error && (
            <p role="alert" className="m-0 text-xs flex items-center gap-1" style={{ color: "var(--ds-danger)" }}>
              <AlertTriangle className="w-3 h-3 shrink-0" /> {error}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button type="button" onClick={onCancel} disabled={grabbing} className="rounded px-2 py-1 text-sm text-zinc-500 hover:text-zinc-300">
            {t("shared.common.cancel")}
          </button>
          <Button size="sm" onClick={onGrab} disabled={!selected || !selectedVisible || grabbing}>
            {grabbing ? <Loader2 className="animate-spin" /> : <Download />}
            {t("adminQueue.issueActions.grab")}
          </Button>
        </div>
      </div>
    </>
  );
}

function ReleaseRow({
  rel,
  selected,
  onSelect,
  size,
  age,
}: {
  rel: ArrReleaseWire;
  selected: boolean;
  onSelect: () => void;
  size: (bytes: number) => string;
  age: (days: number) => string;
}) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`w-full text-left px-6 py-3.5 flex items-start gap-4 hover:bg-zinc-800/60 transition-colors ${selected ? "bg-zinc-800" : ""}`}
    >
      <span className={`mt-0.5 shrink-0 ${rel.protocol === "torrent" ? "text-green-500" : "text-sky-400"}`}>
        {rel.protocol === "torrent" ? <Magnet className="w-4 h-4" /> : <Radio className="w-4 h-4" />}
      </span>
      <div className="flex-1 min-w-0">
        <p className={`text-sm truncate ${selected ? "text-zinc-100" : "text-zinc-300"}`} title={rel.title}>{rel.title}</p>
        <div className="flex items-center gap-3 mt-1 flex-wrap">
          <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${rel.rejected ? "bg-zinc-800 text-zinc-500" : "bg-sky-500/10 text-sky-400"}`}>
            {rel.quality.quality.name}
            {rel.quality.revision.version > 1 && ` v${rel.quality.revision.version}`}
          </span>
          <span className="text-xs text-zinc-500">{size(rel.size)}</span>
          <span className="text-xs text-zinc-500">{rel.indexer}</span>
          {rel.protocol === "torrent" && rel.seeders != null && (
            <span className={`text-xs ${rel.seeders > 5 ? "text-green-400" : rel.seeders > 0 ? "text-yellow-400" : "text-red-400"}`}>
              {t("adminQueue.releases.seeders", { count: rel.seeders })}
            </span>
          )}
          <span className="text-xs text-zinc-500">{age(rel.age)}</span>
          {rel.customFormatScore !== null && (rel.customFormatScore !== 0 || rel.customFormats.length > 0) && (
            <span
              className={`text-xs font-medium px-1.5 py-0.5 rounded ${rel.customFormatScore < 0 ? "bg-red-500/10 text-red-400" : "bg-zinc-800 text-zinc-300"}`}
              title={rel.customFormats.length > 0 ? rel.customFormats.join(", ") : undefined}
            >
              {t("adminQueue.releases.score", { score: rel.customFormatScore > 0 ? `+${rel.customFormatScore}` : String(rel.customFormatScore) })}
            </span>
          )}
          {rel.languages.length > 0 && (
            <span className="text-xs text-zinc-500 truncate max-w-[12rem]" title={rel.languages.join(", ")}>{rel.languages.join(", ")}</span>
          )}
        </div>
        {rel.rejected && rel.rejections.length > 0 && (
          <ul className="m-0 mt-0.5 p-0 list-none">
            {rel.rejections.slice(0, 4).map((r, i) => (
              <li key={i} className="text-xs text-amber-400 truncate" title={r}>{r}</li>
            ))}
          </ul>
        )}
      </div>
      {selected && <Check className="w-4 h-4 text-sky-400 shrink-0 mt-0.5" />}
    </button>
  );
}
