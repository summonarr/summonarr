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
// own catalogs and builds the command itself (guardrail 5d). Every answer is
// checked against its shape (queue-import-rules.ts) before it is shown.

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StyledSelect } from "@/components/ui/styled-select";
import { Dialog, DialogBackdrop, DialogClose, DialogPopup, DialogPortal, DialogTitle } from "@/components/ui/dialog";
import { AlertTriangle, Check, FileCheck, Loader2, RefreshCw, Search, Wrench, X } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import { useAsyncAction } from "@/hooks/use-async-action";
import { fetchJson, LONG_RUN_TIMEOUT_MS, jsonInit } from "@/lib/client/fetch-json";
import { episodeCode, episodeSummary, queueFormatters } from "@/components/admin/queue-format";
import {
  defaultImportSelection,
  nextImportSelection,
  SONARR_RELEASE_TYPES,
  type ImportCandidate,
  type ImportMode,
  type ImportOverride,
  type QueueItem,
} from "@/lib/arr-queue";
import {
  chosenEpisodes,
  ImportEpisodesAnswer,
  ImportListAnswer,
  ImportPreviewAnswer,
  ImportSubmitAnswer,
  ImportTargetsAnswer,
  initialDraft,
  isSonarrReleaseType,
  overrideFrom,
  toggleId,
  type Draft,
  type ImportChoice,
  type ImportEpisodeChoice,
  type ImportTargetChoice,
} from "@/components/admin/queue-import-rules";

const SERVICE_LABEL = { radarr: "Radarr", sonarr: "Sonarr" } as const;

type QueueFormatters = ReturnType<typeof queueFormatters>;
type FileView = ImportCandidate & { rechecked: boolean };

// The dialog's state for the open download: its files, the admin's
// corrections and selection, and the three calls (load, Apply, Import).
function useImportDialog(row: QueueItem | null, onImported: (row: QueueItem, files: number) => void) {
  const t = useT();
  const [files, setFiles] = useState<ImportCandidate[] | null>(null);
  const [qualities, setQualities] = useState<ImportChoice[]>([]);
  const [languages, setLanguages] = useState<ImportChoice[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Applied corrections per path, and the arr's verdict on the corrected file.
  const [edits, setEdits] = useState<Record<string, ImportOverride>>({});
  const [views, setViews] = useState<Record<string, FileView>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [mode, setMode] = useState<ImportMode>("auto");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  // The submit, and each file's Apply (keyed by its path). A download switch
  // aborts every Apply still out, so its verdict never lands on another
  // download's files.
  const action = useAsyncAction();
  const busy = action.busy("submit");
  // The translator through a ref: a new catalog object must not reload the files.
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  }, [t]);

  const service = row?.service;
  const instance = row?.instance;
  const downloadId = row?.downloadId ?? null;
  // Which download the files, edits and error on screen belong to. Until the
  // open row's own load settles they are another row's (or none): the dialog
  // shows its spinner, never the last row's files or a "load failed" before
  // anything was asked.
  const dataKey = service && instance !== undefined && downloadId !== null ? `${service}:${instance}:${downloadId}` : null;
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const pending = row !== null && dataKey !== loadedFor;

  useEffect(() => {
    action.abort();
    if (!service || instance === undefined || downloadId === null) return;
    const key = `${service}:${instance}:${downloadId}`;
    const ctl = new AbortController();
    setFiles(null);
    setSelected(new Set());
    setEdits({});
    setViews({});
    setEditing(null);
    setMode("auto");
    setError("");
    setLoading(true);
    (async () => {
      const qs = new URLSearchParams({ service, instance, downloadId });
      const res = await fetchJson(withBasePath(`/api/admin/queue/import?${qs}`), {
        schema: ImportListAnswer,
        signal: ctl.signal,
        // Listing a download asks the arr to scan it: no client-side timeout.
        timeoutMs: LONG_RUN_TIMEOUT_MS,
        fallbackError: tRef.current("adminManage.queue.import.loadFailed"),
      });
      if (ctl.signal.aborted) return;
      if (res.ok) {
        setFiles(res.data.files);
        setQualities(res.data.qualities ?? []);
        setLanguages(res.data.languages ?? []);
        setSelected(defaultImportSelection(res.data.files));
      } else {
        setError(res.error);
      }
      setLoading(false);
      setLoadedFor(key);
    })();
    return () => ctl.abort();
  }, [service, instance, downloadId, action]);

  async function submit() {
    if (!row || downloadId === null || selected.size === 0) return;
    setError("");
    const res = await action.run("submit", (signal) => fetchJson(withBasePath("/api/admin/queue/import"), {
      init: jsonInit("POST", {
        service: row.service,
        instance: row.instance,
        downloadId,
        files: [...selected].map((path) => ({ path, ...(edits[path] ?? {}) })),
        importMode: mode,
      }),
      schema: ImportSubmitAnswer,
      signal,
      timeoutMs: LONG_RUN_TIMEOUT_MS,
      fallbackError: t("adminManage.queue.import.failed"),
    }), { ifBusy: "skip" });
    if (!res) return;
    if (!res.ok) {
      setError(res.error);
      return;
    }
    onImported(row, res.data.files ?? selected.size);
  }

  // The editor's Apply: the arr re-judges the corrected file.
  async function applyEdit(file: ImportCandidate, override: ImportOverride): Promise<string | null> {
    if (!row || downloadId === null) return null;
    if (Object.keys(override).length === 0) {
      setEdits((m) => { const n = { ...m }; delete n[file.path]; return n; });
      setViews((m) => { const n = { ...m }; delete n[file.path]; return n; });
      // Back to the arr's own verdict, both ways, exactly as an Apply would:
      // ticked when it can import the file, unticked when it can't (its box
      // goes disabled, so it could never be unticked by hand).
      setSelected((sel) => nextImportSelection(sel, file.path, file.importable));
      setEditing(null);
      return null;
    }
    const res = await action.run(`preview:${file.path}`, (signal) => fetchJson(withBasePath("/api/admin/queue/import/preview"), {
      init: jsonInit("POST", { service: row.service, instance: row.instance, downloadId, files: [{ path: file.path, ...override }] }),
      schema: ImportPreviewAnswer,
      signal,
      timeoutMs: LONG_RUN_TIMEOUT_MS,
      fallbackError: t("adminManage.queue.import.previewFailed"),
    }));
    // Dropped: the dialog moved on to another download (or closed) meanwhile.
    if (!res) return null;
    if (!res.ok) return res.error;
    if (!res.data.files[0]) return t("adminManage.queue.import.previewFailed");
    const view = { ...res.data.files[0], rechecked: res.data.rechecked === true };
    setEdits((m) => ({ ...m, [file.path]: override }));
    setViews((m) => ({ ...m, [file.path]: view }));
    // Ticked when the arr now accepts it, unticked when it no longer does.
    setSelected((sel) => nextImportSelection(sel, file.path, view.importable));
    setEditing(null);
    return null;
  }

  function toggle(path: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  return {
    files, qualities, languages, selected, setSelected, toggle, edits, views, editing, setEditing,
    mode, setMode, loading, pending, busy, error, submit, applyEdit,
  };
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
  const { files, qualities, languages, selected, setSelected, toggle, edits, views, editing, setEditing, mode, setMode, loading, pending, busy, error, submit, applyEdit } =
    useImportDialog(row, onImported);

  // What a row shows: the arr's verdict on the corrected file when there is one.
  const shown = (f: ImportCandidate) => views[f.path] ?? f;
  const label = row ? SERVICE_LABEL[row.service] : "";
  const importable = (files ?? []).filter((f) => shown(f).importable);
  const allSelected = importable.length > 0 && importable.every((f) => selected.has(f.path));

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

          {loading || pending || (files === null && !error) ? (
            <div className="flex items-center justify-center gap-3 text-sm text-zinc-500 py-14">
              <Loader2 className="w-5 h-5 animate-spin" />
              {t("adminManage.queue.import.loading")}
            </div>
          ) : files === null ? (
            <div role="alert" className="flex items-center justify-center gap-2 text-sm py-14 px-6 text-center" style={{ color: "var(--ds-danger)" }}>
              <AlertTriangle className="w-4 h-4 shrink-0" /> {error}
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
                {files.map((orig) => (
                  <ImportFileRow
                    key={orig.path}
                    file={orig}
                    shown={shown(orig)}
                    edited={edits[orig.path] !== undefined}
                    view={views[orig.path]}
                    checked={selected.has(orig.path)}
                    busy={busy}
                    serviceLabel={label}
                    fmt={fmt}
                    onToggle={() => toggle(orig.path)}
                    onEdit={editing !== orig.path ? () => setEditing(orig.path) : null}
                    editor={editing === orig.path && row ? (
                      <FileEditor
                        service={row.service}
                        instance={row.instance}
                        file={orig}
                        current={shown(orig)}
                        applied={edits[orig.path]}
                        qualities={qualities}
                        languages={languages}
                        onCancel={() => setEditing(null)}
                        onApply={(o) => applyEdit(orig, o)}
                      />
                    ) : null}
                  />
                ))}
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

          {error && files !== null && !pending && (
            <p role="alert" className="m-0 px-6 pb-4 text-xs flex items-center gap-1" style={{ color: "var(--ds-danger)" }}>
              <AlertTriangle className="w-3 h-3 shrink-0" /> {error}
            </p>
          )}
        </DialogPopup>
      </DialogPortal>
    </Dialog>
  );
}

// One file: its box, what the arr matched it to and why it refused it, and
// its editor when open.
function ImportFileRow({
  file,
  shown: f,
  edited,
  view,
  checked,
  busy,
  serviceLabel,
  fmt,
  onToggle,
  onEdit,
  editor,
}: {
  /** The file as the arr reported it. */
  file: ImportCandidate;
  /** What it shows now: the arr's verdict on the corrected file when there is one. */
  shown: ImportCandidate;
  edited: boolean;
  view: FileView | undefined;
  checked: boolean;
  busy: boolean;
  serviceLabel: string;
  fmt: QueueFormatters;
  onToggle: () => void;
  /** Opens the editor; null while it is open. */
  onEdit: (() => void) | null;
  editor: React.ReactNode;
}) {
  const t = useT();
  return (
    <li>
      <div className={`flex items-start gap-3 px-6 py-3 ${f.importable ? "" : "opacity-90"}`}>
        <input
          type="checkbox"
          checked={checked}
          disabled={!f.importable || busy}
          onChange={onToggle}
          aria-label={t("adminManage.queue.import.fileLabel", { name: file.name })}
          style={{ marginTop: 3 }}
        />
        <div className="flex flex-col min-w-0 gap-0.5 flex-1" title={file.path}>
          <span className="ds-mono text-xs text-zinc-100" style={{ overflowWrap: "anywhere" }}>{file.name}</span>
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
            {[f.quality, fmt.size(file.size), f.languages.join(", "), f.releaseGroup].filter(Boolean).join(" · ")}
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
            <span className="text-xs text-zinc-500">{t("adminManage.queue.import.notRechecked", { service: serviceLabel })}</span>
          )}
        </div>
        {onEdit && (
          <Button
            size="xs"
            variant="outline"
            onClick={onEdit}
            disabled={busy}
            aria-label={t("adminManage.queue.import.editAria", { name: file.name })}
            className="shrink-0"
          >
            <Wrench />
            {f.importable ? t("adminManage.queue.import.edit") : t("adminManage.queue.import.match")}
          </Button>
        )}
      </div>
      {editor}
    </li>
  );
}

// ── one file's corrections ───────────────────────────────────────────────────

// A Sonarr series' episodes, read whenever the chosen series changes. A failed
// read is said, with a Retry — never an empty season list.
function useSeriesEpisodes(service: "radarr" | "sonarr", instance: string, seriesId: number | null) {
  const [attempt, setAttempt] = useState(0);
  const readKey = service === "sonarr" && seriesId ? `${instance}:${seriesId}#${attempt}` : null;
  const [answer, setAnswer] = useState<{ key: string; episodes: ImportEpisodeChoice[] | null; error: string } | null>(null);
  useEffect(() => {
    if (readKey === null || seriesId === null) return;
    const ctl = new AbortController();
    const qs = new URLSearchParams({ instance, seriesId: String(seriesId) });
    void fetchJson(withBasePath(`/api/admin/queue/import/episodes?${qs}`), {
      schema: ImportEpisodesAnswer,
      signal: ctl.signal,
    }).then((res) => {
      if (ctl.signal.aborted) return;
      setAnswer(res.ok ? { key: readKey, episodes: res.data.episodes, error: "" } : { key: readKey, episodes: null, error: res.error });
    });
    return () => ctl.abort();
  }, [readKey, instance, seriesId]);
  const current = answer !== null && answer.key === readKey ? answer : null;
  return {
    episodes: current?.episodes ?? null,
    /** The route's reason; "" when it gave none (the caller's fallback line). */
    error: current?.error ?? "",
    loading: readKey !== null && current === null,
    retry: () => setAttempt((n) => n + 1),
  };
}

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
  qualities: ImportChoice[];
  languages: ImportChoice[];
  onCancel: () => void;
  onApply: (o: ImportOverride) => Promise<string | null>;
}) {
  const t = useT();
  const [draft, setDraft] = useState<Draft>(() => initialDraft(service, current));
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState("");
  const series = useSeriesEpisodes(service, instance, draft.series?.id ?? null);

  function pick(target: ImportTargetChoice) {
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

  const needsEpisodes = service === "sonarr" && (!draft.series || draft.episodeIds.length === 0);

  return (
    <div
      className="flex flex-col gap-3 mx-6 mb-3 rounded-md"
      style={{ padding: 12, border: "1px solid var(--ds-border)", background: "var(--ds-bg-2)" }}
    >
      <TargetPicker service={service} instance={instance} chosen={service === "radarr" ? draft.movie : draft.series} onPick={pick} onError={setError} />

      {service === "sonarr" && draft.series && (
        <EpisodePicker draft={draft} setDraft={setDraft} series={series} />
      )}

      <FileFields service={service} draft={draft} setDraft={setDraft} qualities={qualities} currentQuality={current.quality} />

      {languages.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className={FIELD_LABEL}>{t("adminManage.queue.import.languages")}</span>
          <div className="flex flex-wrap gap-x-3 gap-y-1 max-h-28 overflow-y-auto rounded border border-zinc-700 px-2 py-1.5">
            {languages.map((l) => (
              <label key={l.id} className="flex items-center gap-1.5 text-xs text-zinc-100">
                <input
                  type="checkbox"
                  checked={draft.languageIds.includes(l.id)}
                  onChange={() => setDraft((d) => ({ ...d, languageIds: toggleId(d.languageIds, l.id) }))}
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

const FIELD_LABEL = "text-xs font-medium text-zinc-400";

// The title the file is matched to — the movie, or the series — and a search
// of the instance's own titles to re-match it.
function TargetPicker({
  service,
  instance,
  chosen,
  onPick,
  onError,
}: {
  service: "radarr" | "sonarr";
  instance: string;
  chosen: ImportTargetChoice | null;
  onPick: (target: ImportTargetChoice) => void;
  onError: (message: string) => void;
}) {
  const t = useT();
  const label = SERVICE_LABEL[service];
  const [term, setTerm] = useState("");
  const [results, setResults] = useState<ImportTargetChoice[] | null>(null);
  // A newer search supersedes one still out: its results never land.
  const action = useAsyncAction();
  const searching = action.busy("search");

  async function search() {
    const q = term.trim();
    if (!q) return;
    onError("");
    const qs = new URLSearchParams({ service, instance, term: q });
    const res = await action.run("search", (signal) => fetchJson(withBasePath(`/api/admin/queue/import/targets?${qs}`), {
      schema: ImportTargetsAnswer,
      signal,
      fallbackError: t("adminManage.queue.import.searchFailed"),
    }));
    if (!res) return;
    if (res.ok) setResults(res.data.results);
    else onError(res.error);
  }

  function choose(target: ImportTargetChoice) {
    setResults(null);
    setTerm("");
    onPick(target);
  }

  return (
    <div className="flex flex-col gap-1.5">
      <span className={FIELD_LABEL}>{service === "radarr" ? t("adminManage.queue.import.movie") : t("adminManage.queue.import.series")}</span>
      <span className="text-xs text-zinc-100">
        {chosen?.title ?? <span style={{ color: "var(--ds-warning)" }}>{t("adminManage.queue.import.noneChosen")}</span>}
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
                <button type="button" onClick={() => choose(r)} className="w-full text-left px-3 py-1.5 text-xs text-zinc-100 hover:bg-zinc-800">
                  {r.title}
                  {r.year ? <span className="text-zinc-500"> ({r.year})</span> : null}
                </button>
              </li>
            ))}
          </ul>
        )
      )}
    </div>
  );
}

// Sonarr: the season, its episodes, and the episodes chosen across every
// season — a choice made in another season still goes back with Apply.
function EpisodePicker({
  draft,
  setDraft,
  series,
}: {
  draft: Draft;
  setDraft: React.Dispatch<React.SetStateAction<Draft>>;
  series: ReturnType<typeof useSeriesEpisodes>;
}) {
  const t = useT();
  const episodes = series.episodes ?? [];
  const seasons = [...new Set(episodes.map((e) => e.seasonNumber))].sort((a, b) => a - b);
  const seasonEpisodes = episodes.filter((e) => e.seasonNumber === draft.season);
  const chosen = chosenEpisodes(episodes, draft.episodeIds);
  let body: React.ReactNode;
  if (series.loading) {
    body = <span className="flex items-center gap-2 text-xs text-zinc-500"><Loader2 className="w-3 h-3 animate-spin" /> {t("adminManage.queue.import.episodesLoading")}</span>;
  } else if (series.episodes === null) {
    body = (
      <span className="flex flex-wrap items-center gap-2 text-xs">
        <span role="alert" className="flex items-center gap-1" style={{ color: "var(--ds-danger)" }}>
          <AlertTriangle className="w-3 h-3 shrink-0" /> {series.error || t("adminManage.queue.import.episodesFailed")}
        </span>
        <Button size="xs" variant="outline" onClick={series.retry}>
          <RefreshCw />
          {t("adminManage.common.retry")}
        </Button>
      </span>
    );
  } else {
    body = (
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
                  onChange={() => setDraft((d) => ({ ...d, episodeIds: toggleId(d.episodeIds, e.id) }))}
                />
                <span className="ds-mono text-zinc-400">{episodeCode(e)}</span>
                <span className="truncate">{e.title || "—"}</span>
                {e.hasFile && <span className="text-zinc-500">· {t("adminManage.queue.import.hasFile")}</span>}
              </label>
            ))}
          </div>
        )}
        {chosen.length > 0 && (
          <span role="status" className="ds-mono text-xs text-zinc-400">
            {t("adminManage.queue.import.chosenEpisodes", { list: episodeSummary(chosen) })}
          </span>
        )}
      </>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <span className={FIELD_LABEL}>{t("adminManage.queue.import.episodes")}</span>
      {body}
    </div>
  );
}

// Quality, release group, and (Sonarr) release type.
function FileFields({
  service,
  draft,
  setDraft,
  qualities,
  currentQuality,
}: {
  service: "radarr" | "sonarr";
  draft: Draft;
  setDraft: React.Dispatch<React.SetStateAction<Draft>>;
  qualities: ImportChoice[];
  /** The file's own quality name, for an id the instance's list doesn't hold. */
  currentQuality: string | null;
}) {
  const t = useT();
  return (
    <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))" }}>
      <label className="flex flex-col gap-1">
        <span className={FIELD_LABEL}>{t("adminManage.queue.import.quality")}</span>
        <StyledSelect
          compact
          value={draft.qualityId === null ? "" : String(draft.qualityId)}
          onChange={(e) => setDraft((d) => ({ ...d, qualityId: e.target.value === "" ? null : Number(e.target.value) }))}
        >
          {draft.qualityId === null && <option value="">{t("adminManage.queue.import.unknown")}</option>}
          {draft.qualityId !== null && !qualities.some((q) => q.id === draft.qualityId) && (
            <option value={String(draft.qualityId)}>{currentQuality ?? String(draft.qualityId)}</option>
          )}
          {qualities.map((q) => <option key={q.id} value={String(q.id)}>{q.name}</option>)}
        </StyledSelect>
      </label>
      <label className="flex flex-col gap-1">
        <span className={FIELD_LABEL}>{t("adminManage.queue.import.releaseGroup")}</span>
        <Input
          value={draft.releaseGroup}
          onChange={(e) => setDraft((d) => ({ ...d, releaseGroup: e.target.value.slice(0, 100) }))}
          className="h-8 text-xs"
        />
      </label>
      {service === "sonarr" && (
        <label className="flex flex-col gap-1">
          <span className={FIELD_LABEL}>{t("adminManage.queue.import.releaseType")}</span>
          <StyledSelect
            compact
            value={draft.releaseType ?? "unknown"}
            onChange={(e) => {
              const value = e.target.value;
              if (isSonarrReleaseType(value)) setDraft((d) => ({ ...d, releaseType: value }));
            }}
          >
            {SONARR_RELEASE_TYPES.map((rt) => <option key={rt} value={rt}>{t(`adminManage.queue.import.releaseTypes.${rt}`)}</option>)}
          </StyledSelect>
        </label>
      )}
    </div>
  );
}
