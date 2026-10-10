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

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { StyledSelect } from "@/components/ui/styled-select";
import { Dialog, DialogBackdrop, DialogClose, DialogPopup, DialogPortal, DialogTitle } from "@/components/ui/dialog";
import { AlertTriangle, Check, ChevronDown, ChevronUp, Download, Loader2, Magnet, Radio, Search, X } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import type { ArrRelease, SonarrSeasonSummary } from "@/lib/arr";

function sizeFormatter(locale: string) {
  const gb = new Intl.NumberFormat(locale, { style: "unit", unit: "gigabyte", unitDisplay: "narrow", maximumFractionDigits: 1 });
  const mb = new Intl.NumberFormat(locale, { style: "unit", unit: "megabyte", unitDisplay: "narrow", maximumFractionDigits: 0 });
  return (bytes: number) => (bytes >= 1e9 ? gb.format(bytes / 1e9) : mb.format(bytes / 1e6));
}

function ageFormatter(locale: string) {
  const d = new Intl.NumberFormat(locale, { style: "unit", unit: "day", unitDisplay: "narrow", maximumFractionDigits: 0 });
  return (days: number) => d.format(Math.max(0, Math.round(days)));
}

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
  const locale = useLocale();
  // A target names its own scope, so it never shows the season picker.
  const isTv = !target && mediaType !== "MOVIE";
  // Effects key on the target's VALUE: a parent re-render hands a new object.
  const targetKey = target ? JSON.stringify(target) : "";
  const [seasons, setSeasons] = useState<SonarrSeasonSummary[] | null>(null);
  const [season, setSeason] = useState<number | null>(null);
  const [releases, setReleases] = useState<ArrRelease[] | null>(null);
  const [loading, setLoading] = useState<"seasons" | "releases" | "grab" | null>(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [showRejected, setShowRejected] = useState(false);
  const [grabbed, setGrabbed] = useState(false);
  // Only the newest search may write state — switching seasons quickly must
  // never leave one season's releases offered for another (the grab would then
  // send that release to the wrong season's episodes). Closing the dialog bumps
  // it too, so a season list still loading never starts an indexer search.
  const seq = useRef(0);
  // The translator through a ref: the request queue router.refresh()es on every
  // request:* event, which hands the provider a new catalog object and so a new
  // `t`. As an effect dependency that re-ran the open-time search (and cleared
  // the "grabbed" confirmation) under an open dialog.
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  }, [t]);
  const size = sizeFormatter(locale);
  const age = ageFormatter(locale);

  const search = useCallback(async (s: number | null) => {
    const id = ++seq.current;
    setLoading("releases");
    setError("");
    setReleases(null);
    setSelected(null);
    setShowRejected(false);
    setFilter("");
    try {
      let url: string;
      if (targetKey) {
        const tg = JSON.parse(targetKey) as TitleReleaseTarget;
        const q = new URLSearchParams({ service: tg.service, instance: tg.instance, id: String(tg.arrId) });
        for (const [k, v] of Object.entries(titleScopeParams(tg))) q.set(k, String(v));
        url = `/api/admin/arr/title/releases?${q.toString()}`;
      } else {
        url = `/api/requests/${requestId}/releases${s !== null ? `?season=${s}` : ""}`;
      }
      const res = await fetch(withBasePath(url));
      const data = (await res.json().catch(() => null)) as { releases?: ArrRelease[]; error?: string } | null;
      if (id !== seq.current) return;
      if (!res.ok || !data?.releases) {
        setError(data?.error ?? tRef.current("adminQueue.releases.failed"));
        return;
      }
      setReleases(data.releases);
      setSelected((data.releases.find((r) => !r.rejected) ?? data.releases[0])?.guid ?? null);
    } catch {
      if (id === seq.current) setError(tRef.current("shared.thread.networkError"));
    } finally {
      if (id === seq.current) setLoading(null);
    }
  }, [requestId, targetKey]);

  // Fresh state on every open; a movie searches straight away, a series loads
  // its seasons first.
  useEffect(() => {
    if (!open) return;
    const t = tRef.current;
    // The counter object itself (not a value read from it) for the cleanup below.
    const counter = seq;
    seq.current++;
    setSeasons(null);
    setSeason(null);
    setReleases(null);
    setError("");
    setGrabbed(false);
    if (!isTv) {
      void search(null);
      return;
    }
    const id = ++seq.current;
    setLoading("seasons");
    (async () => {
      try {
        const res = await fetch(withBasePath(`/api/requests/${requestId}/releases`));
        const data = (await res.json().catch(() => null)) as { seasons?: SonarrSeasonSummary[]; error?: string } | null;
        if (id !== seq.current) return;
        if (!res.ok || !data?.seasons) {
          setError(data?.error ?? t("adminQueue.releases.failed"));
          setLoading(null);
          return;
        }
        setSeasons(data.seasons);
        const first = defaultSeason(data.seasons);
        setSeason(first);
        if (first === null) {
          setLoading(null);
          setError(t("adminQueue.releases.noSeasons"));
          return;
        }
        void search(first);
      } catch {
        if (id === seq.current) {
          setError(t("shared.thread.networkError"));
          setLoading(null);
        }
      }
    })();
    // Closing (or switching request) invalidates whatever is still in flight.
    return () => {
      counter.current++;
    };
  }, [open, isTv, requestId, search]);

  async function grab() {
    const rel = releases?.find((r) => r.guid === selected);
    if (!rel) return;
    setLoading("grab");
    setError("");
    try {
      // `guid` on these rows is the server's opaque handle for the release,
      // never the indexer's own guid (which can embed an apikey).
      const res = target
        ? await fetch(withBasePath("/api/admin/arr/title/releases"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ service: target.service, instance: target.instance, id: target.arrId, release: rel.guid, ...titleScopeParams(target) }),
        })
        : await fetch(withBasePath(`/api/requests/${requestId}/releases`), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ release: rel.guid, ...(isTv && season !== null ? { season } : {}) }),
        });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? t("adminQueue.releases.grabFailed"));
        return;
      }
      setGrabbed(true);
    } catch {
      setError(t("shared.thread.networkError"));
    } finally {
      setLoading(null);
    }
  }

  const term = filter.toLowerCase();
  const list = releases ?? [];
  const visible = list.filter((r) => (showRejected || !r.rejected) && (!term || r.title.toLowerCase().includes(term)));
  const rejectedCount = list.filter((r) => r.rejected).length;
  // Keep a visible row selected as the filter narrows the list.
  const selectedVisible = visible.some((r) => r.guid === selected);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && loading === "grab") return; onOpenChange(o); }}>
      <DialogPortal>
        <DialogBackdrop />
        <DialogPopup className="max-w-3xl">
          <div className="flex items-center justify-between gap-3 px-6 py-4 border-b border-zinc-700 flex-shrink-0">
            <div className="min-w-0">
              <DialogTitle className="text-base font-semibold text-zinc-100">{t("adminQueue.releases.title")}</DialogTitle>
              {subtitle && <p className="m-0 mt-0.5 text-xs text-zinc-500 truncate">{subtitle}</p>}
            </div>
            <div className="flex items-center gap-3">
              {isTv && seasons && seasons.length > 0 && (
                <StyledSelect
                  compact
                  value={season === null ? "" : String(season)}
                  onChange={(e) => {
                    const next = Number(e.target.value);
                    setSeason(next);
                    setGrabbed(false);
                    void search(next);
                  }}
                  disabled={loading !== null}
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
              )}
              <DialogClose
                disabled={loading === "grab"}
                aria-label={t("adminQueue.common.close")}
                title={t("adminQueue.common.close")}
                className="text-zinc-500 hover:text-zinc-300 disabled:opacity-40 transition-colors"
              >
                <X className="w-5 h-5" />
              </DialogClose>
            </div>
          </div>

          {loading === "seasons" || loading === "releases" ? (
            <div className="flex items-center justify-center gap-3 text-sm text-zinc-500 py-16">
              <Loader2 className="w-5 h-5 animate-spin" />
              {t("adminQueue.releases.searching")}
            </div>
          ) : grabbed ? (
            <div className="flex items-center justify-center gap-2 text-sm text-green-400 py-16 px-6 text-center">
              <Check className="w-4 h-4 shrink-0" />
              {t("adminQueue.releases.grabbed")}
            </div>
          ) : error && releases === null ? (
            <div role="alert" className="flex items-center justify-center gap-2 text-sm py-16 px-6 text-center" style={{ color: "var(--ds-danger)" }}>
              <AlertTriangle className="w-4 h-4 shrink-0" /> {error}
            </div>
          ) : list.length === 0 ? (
            <div className="text-sm text-zinc-500 text-center py-16">{t("adminQueue.releases.none")}</div>
          ) : (
            <>
              <div className="px-6 py-3 border-b border-zinc-800 flex-shrink-0">
                <div className="relative flex items-center">
                  <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500 pointer-events-none" />
                  <input
                    type="text"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value.slice(0, 200))}
                    placeholder={t("adminQueue.issueActions.filterPlaceholder")}
                    aria-label={t("adminQueue.issueActions.filterAria")}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-md pl-10 pr-3 py-2.5 text-sm text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-indigo-500/60 focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </div>
              </div>

              <div className="overflow-y-auto flex-1 divide-y divide-zinc-800">
                {visible.map((rel) => {
                  const isSelected = selected === rel.guid;
                  return (
                    <button
                      key={rel.guid}
                      type="button"
                      onClick={() => setSelected(rel.guid)}
                      aria-pressed={isSelected}
                      className={`w-full text-left px-6 py-3.5 flex items-start gap-4 hover:bg-zinc-800/60 transition-colors ${isSelected ? "bg-zinc-800" : ""}`}
                    >
                      <span className={`mt-0.5 shrink-0 ${rel.protocol === "torrent" ? "text-green-500" : "text-sky-400"}`}>
                        {rel.protocol === "torrent" ? <Magnet className="w-4 h-4" /> : <Radio className="w-4 h-4" />}
                      </span>
                      <div className="flex-1 min-w-0">
                        <p className={`text-sm truncate ${isSelected ? "text-zinc-100" : "text-zinc-300"}`} title={rel.title}>{rel.title}</p>
                        <div className="flex items-center gap-3 mt-1 flex-wrap">
                          <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${rel.rejected ? "bg-zinc-800 text-zinc-500" : "bg-sky-500/10 text-sky-400"}`}>
                            {rel.quality.quality.name}
                            {rel.quality.revision.version > 1 && " v2"}
                          </span>
                          <span className="text-xs text-zinc-500">{size(rel.size)}</span>
                          <span className="text-xs text-zinc-500">{rel.indexer}</span>
                          {rel.protocol === "torrent" && rel.seeders != null && (
                            <span className={`text-xs ${rel.seeders > 5 ? "text-green-400" : rel.seeders > 0 ? "text-yellow-400" : "text-red-400"}`}>
                              {t("adminQueue.releases.seeders", { count: rel.seeders })}
                            </span>
                          )}
                          <span className="text-xs text-zinc-500">{age(rel.age)}</span>
                        </div>
                        {rel.rejected && rel.rejections.length > 0 && (
                          <p className="text-xs text-amber-400 mt-0.5 truncate">{rel.rejections[0]}</p>
                        )}
                      </div>
                      {isSelected && <Check className="w-4 h-4 text-sky-400 shrink-0 mt-0.5" />}
                    </button>
                  );
                })}
                {visible.length === 0 && (
                  <p className="text-xs text-zinc-500 text-center py-8">{t("adminQueue.issueActions.noMatch", { filter })}</p>
                )}
              </div>

              {rejectedCount > 0 && (
                <button
                  type="button"
                  onClick={() => setShowRejected((v) => !v)}
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
                  <button type="button" onClick={() => onOpenChange(false)} disabled={loading === "grab"} className="rounded px-2 py-1 text-sm text-zinc-500 hover:text-zinc-300">
                    {t("shared.common.cancel")}
                  </button>
                  <Button size="sm" onClick={() => void grab()} disabled={!selected || !selectedVisible || loading === "grab"}>
                    {loading === "grab" ? <Loader2 className="animate-spin" /> : <Download />}
                    {t("adminQueue.issueActions.grab")}
                  </Button>
                </div>
              </div>
            </>
          )}
        </DialogPopup>
      </DialogPortal>
    </Dialog>
  );
}
