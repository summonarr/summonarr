"use client";

// Admin → Download Queue → Import: Radarr/Sonarr's own Manual Import for a
// download they would not import on their own, with everything the arr's
// dialog lets you change. Lists the files the arr found (GET
// /api/admin/queue/import), what each matched to and why it was refused; any
// file can be corrected — re-matched to another movie, or to a series, season
// and episodes; its quality, languages, release group and (Sonarr) release
// type — and "Apply" has the arr re-judge it (POST …/import/preview). The
// admin picks files and a mode and confirms (POST …/import).
//
// The browser only ever names a file by its path and a correction by its ids;
// the server re-reads the arr's list, checks every id against the instance's
// own catalogs and builds the command itself (guardrail 5d).

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StyledSelect } from "@/components/ui/styled-select";
import { Dialog, DialogBackdrop, DialogClose, DialogPopup, DialogPortal, DialogTitle } from "@/components/ui/dialog";
import { AlertTriangle, Check, FileCheck, Loader2, Search, Wrench, X } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import { episodeCode, episodeSummary, queueFormatters } from "@/components/admin/queue-format";
import {
  defaultImportSelection,
  SONARR_RELEASE_TYPES,
  type ImportCandidate,
  type ImportMode,
  type ImportOverride,
  type QueueItem,
} from "@/lib/arr-queue";

const SERVICE_LABEL = { radarr: "Radarr", sonarr: "Sonarr" } as const;

type Choice = { id: number; name: string };
type TargetChoice = { id: number; title: string; year: number | null };
type EpisodeChoice = { id: number; seasonNumber: number; episodeNumber: number; title: string; hasFile: boolean };

// The editor's working copy of one file.
type Draft = {
  movie: TargetChoice | null;
  series: TargetChoice | null;
  episodeIds: number[];
  season: number | null;
  qualityId: number | null;
  languageIds: number[];
  releaseGroup: string;
  releaseType: string | null;
};

const sameSet = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((x) => b.includes(x));

// Only what the admin actually changed goes back as a correction.
function overrideFrom(file: ImportCandidate, d: Draft, service: "radarr" | "sonarr"): ImportOverride {
  const o: ImportOverride = {};
  if (service === "radarr" && d.movie && d.movie.id !== file.movieId) o.movieId = d.movie.id;
  if (service === "sonarr" && d.series && d.episodeIds.length > 0) {
    if (d.series.id !== file.seriesId) {
      o.seriesId = d.series.id;
      o.episodeIds = [...d.episodeIds];
    } else if (!sameSet(d.episodeIds, file.episodeIds)) {
      o.episodeIds = [...d.episodeIds];
    }
  }
  if (d.qualityId !== null && d.qualityId !== file.qualityId) o.qualityId = d.qualityId;
  if (!sameSet(d.languageIds, file.languageIds)) o.languageIds = [...d.languageIds];
  if (d.releaseGroup.trim() !== (file.releaseGroup ?? "")) o.releaseGroup = d.releaseGroup.trim();
  if (service === "sonarr" && d.releaseType && d.releaseType !== file.releaseType) {
    o.releaseType = d.releaseType as ImportOverride["releaseType"];
  }
  return o;
}

export function QueueImportDialog({
  row,
  onClose,
  onImported,
}: {
  row: QueueItem | null;
  onClose: () => void;
  onImported: (row: QueueItem, files: number) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const fmt = useMemo(() => queueFormatters(locale), [locale]);
  const [files, setFiles] = useState<ImportCandidate[] | null>(null);
  const [qualities, setQualities] = useState<Choice[]>([]);
  const [languages, setLanguages] = useState<Choice[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Applied corrections per path, and the arr's verdict on the corrected file.
  const [edits, setEdits] = useState<Record<string, ImportOverride>>({});
  const [views, setViews] = useState<Record<string, ImportCandidate & { rechecked: boolean }>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [mode, setMode] = useState<ImportMode>("auto");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  }, [t]);

  const service = row?.service;
  const instance = row?.instance;
  const downloadId = row?.downloadId ?? null;

  useEffect(() => {
    if (!service || instance === undefined || downloadId === null) return;
    let live = true;
    setFiles(null);
    setSelected(new Set());
    setEdits({});
    setViews({});
    setEditing(null);
    setMode("auto");
    setError("");
    setLoading(true);
    (async () => {
      try {
        const qs = new URLSearchParams({ service, instance, downloadId });
        const res = await fetch(withBasePath(`/api/admin/queue/import?${qs}`));
        const data = (await res.json().catch(() => null)) as { files?: ImportCandidate[]; qualities?: Choice[]; languages?: Choice[]; error?: string } | null;
        if (!live) return;
        if (!res.ok || !data?.files) {
          setError(data?.error ?? tRef.current("adminManage.queue.import.loadFailed"));
          return;
        }
        setFiles(data.files);
        setQualities(data.qualities ?? []);
        setLanguages(data.languages ?? []);
        setSelected(defaultImportSelection(data.files));
      } catch {
        if (live) setError(tRef.current("adminManage.queue.import.loadFailed"));
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [service, instance, downloadId]);

  // What a row shows: the arr's verdict on the corrected file when there is one.
  const shown = (f: ImportCandidate) => views[f.path] ?? f;

  async function submit() {
    if (!row || downloadId === null || selected.size === 0) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch(withBasePath("/api/admin/queue/import"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          service: row.service,
          instance: row.instance,
          downloadId,
          files: [...selected].map((path) => ({ path, ...(edits[path] ?? {}) })),
          importMode: mode,
        }),
      });
      const data = (await res.json().catch(() => null)) as { files?: number; error?: string } | null;
      if (!res.ok) {
        setError(data?.error ?? t("adminManage.queue.import.failed"));
        return;
      }
      onImported(row, data?.files ?? selected.size);
    } catch {
      setError(t("adminManage.queue.import.failed"));
    } finally {
      setBusy(false);
    }
  }

  // The editor's Apply: the arr re-judges the corrected file.
  async function applyEdit(file: ImportCandidate, override: ImportOverride): Promise<string | null> {
    if (!row || downloadId === null) return null;
    if (Object.keys(override).length === 0) {
      setEdits((m) => { const n = { ...m }; delete n[file.path]; return n; });
      setViews((m) => { const n = { ...m }; delete n[file.path]; return n; });
      setEditing(null);
      return null;
    }
    try {
      const res = await fetch(withBasePath("/api/admin/queue/import/preview"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service: row.service, instance: row.instance, downloadId, files: [{ path: file.path, ...override }] }),
      });
      const data = (await res.json().catch(() => null)) as { files?: ImportCandidate[]; rechecked?: boolean; error?: string } | null;
      if (!res.ok || !data?.files?.[0]) return data?.error ?? t("adminManage.queue.import.previewFailed");
      const view = { ...data.files[0], rechecked: data.rechecked === true };
      setEdits((m) => ({ ...m, [file.path]: override }));
      setViews((m) => ({ ...m, [file.path]: view }));
      if (view.importable) setSelected((s) => new Set(s).add(file.path));
      setEditing(null);
      return null;
    } catch {
      return t("adminManage.queue.import.previewFailed");
    }
  }

  const label = service ? SERVICE_LABEL[service] : "";
  const importable = (files ?? []).filter((f) => shown(f).importable);
  const allSelected = importable.length > 0 && importable.every((f) => selected.has(f.path));

  function toggle(path: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  return (
    <Dialog open={row !== null} onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogPortal>
        <DialogBackdrop />
        <DialogPopup className="max-w-3xl">
          <div className="flex items-center justify-between gap-3 px-6 py-4 border-b border-zinc-700 flex-shrink-0">
            <DialogTitle className="text-base font-semibold text-zinc-100">{t("adminManage.queue.import.title")}</DialogTitle>
            <DialogClose
              disabled={busy}
              aria-label={t("adminQueue.common.close")}
              title={t("adminQueue.common.close")}
              className="text-zinc-500 hover:text-zinc-300 disabled:opacity-40 transition-colors"
            >
              <X className="w-5 h-5" />
            </DialogClose>
          </div>

          {row && (
            <div className="px-6 pt-4 flex-shrink-0">
              <p className="m-0 text-sm font-medium text-zinc-100">
                {row.mediaTitle || row.title}
                {row.episodes.length > 0 && <span className="ds-mono text-zinc-400"> · {episodeSummary(row.episodes)}</span>}
              </p>
              <p className="m-0 mt-1 text-xs text-zinc-500">{t("adminManage.queue.import.intro", { service: label })}</p>
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center gap-3 text-sm text-zinc-500 py-14">
              <Loader2 className="w-5 h-5 animate-spin" />
              {t("adminManage.queue.import.loading")}
            </div>
          ) : files === null ? (
            <div role="alert" className="flex items-center justify-center gap-2 text-sm py-14 px-6 text-center" style={{ color: "var(--ds-danger)" }}>
              <AlertTriangle className="w-4 h-4 shrink-0" /> {error || t("adminManage.queue.import.loadFailed")}
            </div>
          ) : files.length === 0 ? (
            <div className="text-sm text-zinc-500 text-center py-14 px-6">{t("adminManage.queue.import.none", { service: label })}</div>
          ) : (
            <>
              {importable.length > 1 && (
                <label className="flex items-center gap-2 px-6 pt-3 text-xs text-zinc-400">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={() => setSelected(allSelected ? new Set() : new Set(importable.map((f) => f.path)))}
                  />
                  {t("adminManage.queue.import.selectAll")}
                </label>
              )}
              <ul className="m-0 mt-2 p-0 overflow-y-auto flex-1 divide-y divide-zinc-800 border-y border-zinc-800" style={{ listStyle: "none" }}>
                {files.map((orig) => {
                  const f = shown(orig);
                  const edited = edits[orig.path] !== undefined;
                  const view = views[orig.path];
                  return (
                    <li key={orig.path}>
                      <div className={`flex items-start gap-3 px-6 py-3 ${f.importable ? "" : "opacity-90"}`}>
                        <input
                          type="checkbox"
                          checked={selected.has(orig.path)}
                          disabled={!f.importable || busy}
                          onChange={() => toggle(orig.path)}
                          aria-label={t("adminManage.queue.import.fileLabel", { name: orig.name })}
                          style={{ marginTop: 3 }}
                        />
                        <div className="flex flex-col min-w-0 gap-0.5 flex-1" title={orig.path}>
                          <span className="ds-mono text-xs text-zinc-100" style={{ overflowWrap: "anywhere" }}>{orig.name}</span>
                          <span className="text-xs text-zinc-400">
                            {f.target ? (
                              <>
                                {f.target}
                                {f.episodes.length > 0 && <span className="ds-mono"> · {episodeSummary(f.episodes)}</span>}
                              </>
                            ) : (
                              <span style={{ color: "var(--ds-warning)" }}>{t("adminManage.queue.import.unmatched")}</span>
                            )}
                            {edited && <span className="ml-2 text-sky-400">{t("adminManage.queue.import.edited")}</span>}
                          </span>
                          <span className="text-xs text-zinc-500">
                            {[f.quality, fmt.size(orig.size), f.languages.join(", "), f.releaseGroup].filter(Boolean).join(" · ")}
                          </span>
                          {f.rejections.length > 0 && (
                            <span className="flex flex-col text-xs" style={{ color: "var(--ds-warning)" }}>
                              {f.rejections.map((r, i) => (
                                <span key={i} className="flex items-start gap-1">
                                  <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" aria-hidden /> {r}
                                </span>
                              ))}
                            </span>
                          )}
                          {view && !view.rechecked && (
                            <span className="text-xs text-zinc-500">{t("adminManage.queue.import.notRechecked", { service: label })}</span>
                          )}
                        </div>
                        {editing !== orig.path && (
                          <Button
                            size="xs"
                            variant="outline"
                            onClick={() => setEditing(orig.path)}
                            disabled={busy}
                            aria-label={t("adminManage.queue.import.editAria", { name: orig.name })}
                            className="shrink-0"
                          >
                            <Wrench />
                            {f.importable ? t("adminManage.queue.import.edit") : t("adminManage.queue.import.match")}
                          </Button>
                        )}
                      </div>
                      {editing === orig.path && row && (
                        <FileEditor
                          service={row.service}
                          instance={row.instance}
                          file={orig}
                          current={f}
                          applied={edits[orig.path]}
                          qualities={qualities}
                          languages={languages}
                          onCancel={() => setEditing(null)}
                          onApply={(o) => applyEdit(orig, o)}
                        />
                      )}
                    </li>
                  );
                })}
              </ul>

              <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-4 border-t border-zinc-700 bg-zinc-900 flex-shrink-0">
                <label className="flex items-center gap-2 text-xs text-zinc-400">
                  {t("adminManage.queue.import.mode")}
                  <StyledSelect compact className="w-auto" value={mode} onChange={(e) => setMode(e.target.value as ImportMode)} disabled={busy}>
                    <option value="auto">{t("adminManage.queue.import.modeAuto")}</option>
                    <option value="move">{t("adminManage.queue.import.modeMove")}</option>
                    <option value="copy">{t("adminManage.queue.import.modeCopy")}</option>
                  </StyledSelect>
                </label>
                <div className="flex items-center gap-2">
                  <button type="button" onClick={onClose} disabled={busy} className="rounded px-2 py-1 text-sm text-zinc-500 hover:text-zinc-300">
                    {t("shared.common.cancel")}
                  </button>
                  <Button size="sm" onClick={() => void submit()} disabled={busy || selected.size === 0 || editing !== null}>
                    {busy ? <Loader2 className="animate-spin" /> : <FileCheck />}
                    {t("adminManage.queue.import.submit", { count: selected.size })}
                  </Button>
                </div>
              </div>
            </>
          )}

          {error && files !== null && (
            <p role="alert" className="m-0 px-6 pb-4 text-xs flex items-center gap-1" style={{ color: "var(--ds-danger)" }}>
              <AlertTriangle className="w-3 h-3 shrink-0" /> {error}
            </p>
          )}
        </DialogPopup>
      </DialogPortal>
    </Dialog>
  );
}

// ── one file's corrections ───────────────────────────────────────────────────

function FileEditor({
  service,
  instance,
  file,
  current,
  applied,
  qualities,
  languages,
  onCancel,
  onApply,
}: {
  service: "radarr" | "sonarr";
  instance: string;
  /** The file as the arr reported it — what "unchanged" is measured against. */
  file: ImportCandidate;
  /** What it shows now (with any applied correction). */
  current: ImportCandidate;
  applied: ImportOverride | undefined;
  qualities: Choice[];
  languages: Choice[];
  onCancel: () => void;
  onApply: (o: ImportOverride) => Promise<string | null>;
}) {
  const t = useT();
  const label = SERVICE_LABEL[service];
  const titleLabel = current.target ? { id: service === "radarr" ? current.movieId ?? 0 : current.seriesId ?? 0, title: current.target, year: null } : null;
  const [draft, setDraft] = useState<Draft>(() => ({
    movie: service === "radarr" && current.movieId ? titleLabel : null,
    series: service === "sonarr" && current.seriesId ? titleLabel : null,
    episodeIds: [...current.episodeIds],
    season: current.episodes[0]?.seasonNumber ?? null,
    qualityId: current.qualityId,
    languageIds: [...current.languageIds],
    releaseGroup: current.releaseGroup ?? "",
    releaseType: current.releaseType,
  }));
  const [term, setTerm] = useState("");
  const [results, setResults] = useState<TargetChoice[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [episodes, setEpisodes] = useState<EpisodeChoice[] | null>(null);
  const [episodesLoading, setEpisodesLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState("");
  const seriesId = draft.series?.id ?? null;

  // A series' episodes, whenever the chosen series changes.
  useEffect(() => {
    if (service !== "sonarr" || !seriesId) return;
    let live = true;
    setEpisodesLoading(true);
    (async () => {
      try {
        const qs = new URLSearchParams({ instance, seriesId: String(seriesId) });
        const res = await fetch(withBasePath(`/api/admin/queue/import/episodes?${qs}`));
        const data = (await res.json().catch(() => null)) as { episodes?: EpisodeChoice[] } | null;
        if (live) setEpisodes(res.ok && data?.episodes ? data.episodes : []);
      } catch {
        if (live) setEpisodes([]);
      } finally {
        if (live) setEpisodesLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [service, instance, seriesId]);

  async function search() {
    const q = term.trim();
    if (!q) return;
    setSearching(true);
    setError("");
    try {
      const qs = new URLSearchParams({ service, instance, term: q });
      const res = await fetch(withBasePath(`/api/admin/queue/import/targets?${qs}`));
      const data = (await res.json().catch(() => null)) as { results?: TargetChoice[]; error?: string } | null;
      if (!res.ok || !data?.results) setError(data?.error ?? t("adminManage.queue.import.searchFailed"));
      else setResults(data.results);
    } catch {
      setError(t("adminManage.queue.import.searchFailed"));
    } finally {
      setSearching(false);
    }
  }

  function pick(target: TargetChoice) {
    setResults(null);
    setTerm("");
    if (service === "radarr") setDraft((d) => ({ ...d, movie: target }));
    else setDraft((d) => ({ ...d, series: target, episodeIds: target.id === file.seriesId ? [...file.episodeIds] : [], season: target.id === file.seriesId ? d.season : null }));
  }

  async function apply() {
    setApplying(true);
    setError("");
    const message = await onApply(overrideFrom(file, draft, service));
    setApplying(false);
    if (message) setError(message);
  }

  const seasons = [...new Set((episodes ?? []).map((e) => e.seasonNumber))].sort((a, b) => a - b);
  const seasonEpisodes = (episodes ?? []).filter((e) => e.seasonNumber === draft.season);
  const needsEpisodes = service === "sonarr" && (!draft.series || draft.episodeIds.length === 0);
  const fieldLabel = "text-xs font-medium text-zinc-400";

  return (
    <div
      className="flex flex-col gap-3 mx-6 mb-3 rounded-md"
      style={{ padding: 12, border: "1px solid var(--ds-border)", background: "var(--ds-bg-2)" }}
    >
      {/* Title: the movie, or the series */}
      <div className="flex flex-col gap-1.5">
        <span className={fieldLabel}>{service === "radarr" ? t("adminManage.queue.import.movie") : t("adminManage.queue.import.series")}</span>
        <span className="text-xs text-zinc-100">
          {(service === "radarr" ? draft.movie : draft.series)?.title ?? <span style={{ color: "var(--ds-warning)" }}>{t("adminManage.queue.import.noneChosen")}</span>}
        </span>
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void search();
          }}
        >
          <Input
            value={term}
            onChange={(e) => setTerm(e.target.value.slice(0, 100))}
            placeholder={t("adminManage.queue.import.searchPlaceholder", { service: label })}
            aria-label={t("adminManage.queue.import.searchPlaceholder", { service: label })}
            className="h-8 text-xs"
          />
          <Button type="submit" size="xs" variant="outline" disabled={searching || !term.trim()}>
            {searching ? <Loader2 className="animate-spin" /> : <Search />}
            {t("adminManage.queue.import.searchButton")}
          </Button>
        </form>
        {results && (
          results.length === 0 ? (
            <span className="text-xs text-zinc-500">{t("adminManage.queue.import.noResults", { service: label })}</span>
          ) : (
            <ul className="m-0 p-0 flex flex-col max-h-40 overflow-y-auto rounded border border-zinc-700" style={{ listStyle: "none" }}>
              {results.map((r) => (
                <li key={r.id}>
                  <button type="button" onClick={() => pick(r)} className="w-full text-left px-3 py-1.5 text-xs text-zinc-100 hover:bg-zinc-800">
                    {r.title}
                    {r.year ? <span className="text-zinc-500"> ({r.year})</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          )
        )}
      </div>

      {/* Sonarr: season and episodes */}
      {service === "sonarr" && draft.series && (
        <div className="flex flex-col gap-1.5">
          <span className={fieldLabel}>{t("adminManage.queue.import.episodes")}</span>
          {episodesLoading || episodes === null ? (
            <span className="flex items-center gap-2 text-xs text-zinc-500"><Loader2 className="w-3 h-3 animate-spin" /> {t("adminManage.queue.import.episodesLoading")}</span>
          ) : (
            <>
              <StyledSelect
                compact
                className="w-auto"
                value={draft.season === null ? "" : String(draft.season)}
                onChange={(e) => setDraft((d) => ({ ...d, season: e.target.value === "" ? null : Number(e.target.value) }))}
                aria-label={t("adminManage.queue.import.season")}
              >
                <option value="">{t("adminManage.queue.import.chooseSeason")}</option>
                {seasons.map((s) => (
                  <option key={s} value={String(s)}>{s === 0 ? t("adminManage.queue.import.specials") : t("adminManage.queue.import.seasonN", { number: s })}</option>
                ))}
              </StyledSelect>
              {draft.season !== null && (
                <div className="flex flex-col max-h-48 overflow-y-auto rounded border border-zinc-700 px-2 py-1">
                  {seasonEpisodes.map((e) => (
                    <label key={e.id} className="flex items-center gap-2 py-0.5 text-xs text-zinc-100">
                      <input
                        type="checkbox"
                        checked={draft.episodeIds.includes(e.id)}
                        onChange={() =>
                          setDraft((d) => ({
                            ...d,
                            episodeIds: d.episodeIds.includes(e.id) ? d.episodeIds.filter((x) => x !== e.id) : [...d.episodeIds, e.id],
                          }))
                        }
                      />
                      <span className="ds-mono text-zinc-400">{episodeCode(e)}</span>
                      <span className="truncate">{e.title || "—"}</span>
                      {e.hasFile && <span className="text-zinc-500">· {t("adminManage.queue.import.hasFile")}</span>}
                    </label>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Quality, release group, release type */}
      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))" }}>
        <label className="flex flex-col gap-1">
          <span className={fieldLabel}>{t("adminManage.queue.import.quality")}</span>
          <StyledSelect
            compact
            value={draft.qualityId === null ? "" : String(draft.qualityId)}
            onChange={(e) => setDraft((d) => ({ ...d, qualityId: e.target.value === "" ? null : Number(e.target.value) }))}
          >
            {draft.qualityId === null && <option value="">{t("adminManage.queue.import.unknown")}</option>}
            {draft.qualityId !== null && !qualities.some((q) => q.id === draft.qualityId) && (
              <option value={String(draft.qualityId)}>{current.quality ?? String(draft.qualityId)}</option>
            )}
            {qualities.map((q) => <option key={q.id} value={String(q.id)}>{q.name}</option>)}
          </StyledSelect>
        </label>
        <label className="flex flex-col gap-1">
          <span className={fieldLabel}>{t("adminManage.queue.import.releaseGroup")}</span>
          <Input
            value={draft.releaseGroup}
            onChange={(e) => setDraft((d) => ({ ...d, releaseGroup: e.target.value.slice(0, 100) }))}
            className="h-8 text-xs"
          />
        </label>
        {service === "sonarr" && (
          <label className="flex flex-col gap-1">
            <span className={fieldLabel}>{t("adminManage.queue.import.releaseType")}</span>
            <StyledSelect
              compact
              value={draft.releaseType ?? "unknown"}
              onChange={(e) => setDraft((d) => ({ ...d, releaseType: e.target.value }))}
            >
              {SONARR_RELEASE_TYPES.map((rt) => <option key={rt} value={rt}>{t(`adminManage.queue.import.releaseTypes.${rt}`)}</option>)}
            </StyledSelect>
          </label>
        )}
      </div>

      {/* Languages */}
      {languages.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className={fieldLabel}>{t("adminManage.queue.import.languages")}</span>
          <div className="flex flex-wrap gap-x-3 gap-y-1 max-h-28 overflow-y-auto rounded border border-zinc-700 px-2 py-1.5">
            {languages.map((l) => (
              <label key={l.id} className="flex items-center gap-1.5 text-xs text-zinc-100">
                <input
                  type="checkbox"
                  checked={draft.languageIds.includes(l.id)}
                  onChange={() =>
                    setDraft((d) => ({
                      ...d,
                      languageIds: d.languageIds.includes(l.id) ? d.languageIds.filter((x) => x !== l.id) : [...d.languageIds, l.id],
                    }))
                  }
                />
                {l.name}
              </label>
            ))}
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className="m-0 text-xs flex items-center gap-1" style={{ color: "var(--ds-danger)" }}>
          <AlertTriangle className="w-3 h-3 shrink-0" /> {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="xs" onClick={() => void apply()} disabled={applying || needsEpisodes}>
          {applying ? <Loader2 className="animate-spin" /> : <Check />}
          {t("adminManage.queue.import.apply")}
        </Button>
        <Button size="xs" variant="ghost" onClick={onCancel} disabled={applying}>
          {t("shared.common.cancel")}
        </Button>
        {applied && (
          <Button size="xs" variant="ghost" onClick={() => void onApply({})} disabled={applying}>
            {t("adminManage.queue.import.reset")}
          </Button>
        )}
        {needsEpisodes && <span className="text-xs text-zinc-500">{t("adminManage.queue.import.chooseEpisodes")}</span>}
      </div>
    </div>
  );
}
