"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Wrench, Search, X, ChevronLeft, Loader2 } from "@/components/icons";
import { Dialog, DialogBackdrop, DialogClose, DialogPopup, DialogPortal, DialogTitle } from "@/components/ui/dialog";
import { withBasePath } from "@/lib/base-path";
import { postMediaRequest } from "@/lib/client/media-request";
import { runFixMatch, fixMatchErrorMessage, fixMatchWarningMessage, type FixMatchOutcome } from "@/lib/client/fix-match";
import { apiErrorText } from "@/lib/client/api-error";
import { fetchJson, jsonInit } from "@/lib/client/fetch-json";
import { useAsyncAction } from "@/hooks/use-async-action";
import { arrServiceName } from "@/lib/arr-service-name";
import { DEFAULT_MEDIA_INSTANCE, mediaInstanceLabel } from "@/lib/media-instances";
import { useT } from "@/components/i18n/i18n-provider";
import type { Translator } from "@/lib/i18n/translate";
import { holdLiveRefresh, requestPageRefresh } from "@/lib/client/refresh-hold";
import { candidatesErrorText, fetchFixMatchCandidates } from "@/lib/client/fix-match-candidates";
import {
  AddWrongAsRequest,
  BRAND,
  CurrentMatchInfo,
  FileInfoSchema,
  PlexCandidatesList,
  SearchHitsSchema,
  SearchResultRow,
  SelectedMatchHeader,
  ServerFixPanel,
  searchHitsOf,
  type AddWrongState,
  type Candidates,
  type FileInfo,
  type FileInfoRow,
  type SearchHit,
  type ServerState,
  type Side,
} from "./issue-fix-match-parts";

type Phase =
  | "search"
  | "confirm"
  | "plex-candidates";

interface Props {
  issueId:      string;
  tmdbId:       number;
  mediaType:    "MOVIE" | "TV";
  title:        string;
  onPlex:       boolean;
  onJellyfin:   boolean;

  // Preferred server for the fix. This dialog starts from a tmdbId with no
  // library row in hand, so it's only a HINT: the real instance is resolved from
  // the file-info response (which lists every server holding the title).
  serverInstance?: string;
}


// Picks which configured server to act on: the caller's hint if that server
// actually holds the title, else the default server, else the first one that
// does. null when no server holds it (nothing to fix on that side).
function resolveInstance(rows: FileInfoRow[], hint: string): string | null {
  if (rows.length === 0) return null;
  if (rows.some((r) => r.serverInstance === hint)) return hint;
  if (rows.some((r) => r.serverInstance === DEFAULT_MEDIA_INSTANCE)) return DEFAULT_MEDIA_INSTANCE;
  return rows[0].serverInstance;
}

// Picks a side's server after file-info is (re)fetched. If the admin already
// chose a server in the picker and it still holds the title, keep that choice;
// otherwise fall back to resolveInstance. This matters because file-info is
// refetched on every open, including reopening after a busy "hide" that keeps
// state — re-resolving there would silently switch the fix back to the default
// server. A normal close calls reset(), so a fresh open starts from scratch.
function seedInstance(cur: string | null, rows: FileInfoRow[], hint: string): string | null {
  if (cur !== null && rows.some((r) => r.serverInstance === cur)) return cur;
  return resolveInstance(rows, hint);
}

// A remap that went through: the job's own warning (a partial remap, a joined
// job), then — when the issue couldn't be closed — that.
function fixWarning(outcome: FixMatchOutcome, resolved: boolean, t: Translator): string | undefined {
  const parts = [fixMatchWarningMessage(outcome, t), resolved ? null : t("adminQueue.fixMatch.issueNotResolved")];
  return parts.filter((p): p is string => !!p).join(" ") || undefined;
}

// The label a side's server goes by: empty for the default server, so a
// single-server deployment renders exactly as before.
function instanceLabelOf(side: Side, instance: string | null): string {
  return instance && instance !== DEFAULT_MEDIA_INSTANCE ? mediaInstanceLabel(side, instance) : "";
}

// The path shown for whichever server a side is pointed at; falls back to the
// path the route resolved for the requested instance.
function pathOf(fileInfo: FileInfo | null, side: Side, instance: string | null): string | null {
  if (!fileInfo) return null;
  const rows = side === "plex" ? fileInfo.plexInstances : fileInfo.jellyfinInstances;
  // A row for the selected instance answers for it, even with no path: the
  // top-level path belongs to the requested instance, which may be another.
  const row = rows.find((r) => r.serverInstance === instance);
  if (row) return row.filePath ?? null;
  return (side === "plex" ? fileInfo.plexFilePath : fileInfo.jellyfinFilePath) ?? null;
}

// The TMDB search step: debounced, abortable, and remembered — Back from the
// confirm step keeps the results on screen, so the same query isn't asked
// again (the search route is rate limited). `resultsFor` is the query the
// results answer: "No results" only once a search for THIS query came back
// empty — never before the first debounce fired. `clear` forgets it all.
function useFixMatchSearch(active: boolean, query: string, mediaType: "MOVIE" | "TV", t: Translator) {
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchHit[]>([]);
  const [resultsFor, setResultsFor] = useState<string | null>(null);
  const [searchError, setSearchError] = useState("");
  // The query whose results are on screen.
  const lastSearched = useRef<string | null>(null);

  useEffect(() => {
    if (!active) return;
    const q = query.trim();
    if (!q) { setSearchResults([]); setResultsFor(null); setSearchError(""); lastSearched.current = null; return; }
    // Back from the confirm step: these results are still on screen.
    if (q === lastSearched.current) return;
    // The debounce timer and an AbortController: a newer keystroke or the
    // dialog closing cancels both the wait and the request in flight, so stale
    // results from a previous keystroke can't overwrite the current ones.
    const ac = new AbortController();
    const timer = setTimeout(async () => {
      setSearching(true);
      setSearchError("");
      const type = mediaType === "MOVIE" ? "movie" : "tv";
      const res = await fetchJson(withBasePath(`/api/search?q=${encodeURIComponent(q)}&type=${type}`), {
        schema: SearchHitsSchema,
        signal: ac.signal,
      });
      setSearching(false);
      if (res.ok) {
        lastSearched.current = q;
        setResultsFor(q);
        setSearchResults(searchHitsOf(res.data));
      } else if (res.kind !== "aborted") {
        // The old query's hits must not sit under the new query's error.
        setSearchResults([]);
        setResultsFor(null);
        lastSearched.current = null;
        setSearchError(res.kind === "http"
          ? apiErrorText(res.body, t("adminQueue.common.requestFailed", { status: res.status }))
          : t("adminQueue.fixMatch.searchFailed"));
      }
    }, 350);
    return () => {
      clearTimeout(timer);
      ac.abort();
    };
  }, [query, active, mediaType, t]);

  const clear = useCallback(() => {
    setSearching(false);
    setSearchResults([]);
    setResultsFor(null);
    setSearchError("");
    lastSearched.current = null;
  }, []);

  return { searching, searchResults, resultsFor, searchError, clear };
}

// The title's files on every configured server, read each time the dialog
// opens. `onRows` seeds each side's server from the answer (seedInstance).
function useFixMatchFileInfo(
  open: boolean,
  tmdbId: number,
  mediaType: "MOVIE" | "TV",
  serverInstance: string,
  onRows: (info: FileInfo) => void,
) {
  const [fileInfo, setFileInfo] = useState<FileInfo | null>(null);
  const [fileInfoError, setFileInfoError] = useState(false);
  const onRowsRef = useRef(onRows);
  useEffect(() => {
    onRowsRef.current = onRows;
  });
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setFileInfoError(false);
    // The hint is omitted when it's the default instance so the request stays
    // byte-identical to the pre-multi-server one. The response lists EVERY
    // server holding the title regardless, so one fetch is enough to resolve
    // (or offer a choice of) the instance — no refetch on picker change.
    const params = new URLSearchParams({ tmdbId: String(tmdbId), mediaType });
    if (serverInstance) params.set("serverInstance", serverInstance);
    void fetchJson(withBasePath(`/api/admin/fix-match/file-info?${params}`), {
      schema: FileInfoSchema,
      signal: controller.signal,
    }).then((res) => {
      if (res.ok) {
        setFileInfo(res.data);
        onRowsRef.current(res.data);
      } else if (res.kind !== "aborted") {
        setFileInfoError(true);
      }
    });
    return () => controller.abort();
  }, [open, tmdbId, mediaType, serverInstance]);
  return { fileInfo, fileInfoError };
}

// Multi-phase dialog (search → confirm → Plex candidates) for re-matching a
// mismatched library item to the correct TMDB ID and resolving the issue. Its
// pieces, and the shapes it reads from its routes, are issue-fix-match-parts.tsx.
export function IssueFixMatchButton({
  issueId, tmdbId, mediaType, title, onPlex, onJellyfin,
  serverInstance = DEFAULT_MEDIA_INSTANCE,
}: Props) {
  const router = useRouter();
  const t = useT();
  const [open, setOpen] = useState(false);
  const arrName = arrServiceName(mediaType);

  const [phase, setPhase]               = useState<Phase>("search");
  const [query, setQuery]               = useState(title);
  const search = useFixMatchSearch(open && phase === "search", query, mediaType, t);
  const { searching, searchResults, resultsFor, searchError, clear: clearSearch } = search;
  const [selected, setSelected]         = useState<SearchHit | null>(null);

  const [plexState, setPlexState]         = useState<ServerState>({ status: "idle" });
  const [jellyfinState, setJellyfinState] = useState<ServerState>({ status: "idle" });
  const [plexCandidates, setPlexCandidates] = useState<Candidates | null>(null);
  // The Plex candidate picked in the list; the footer's Apply sends it.
  const [plexPick, setPlexPick] = useState<string | null>(null);
  // Which configured server each side's fix targets. Resolved from the file-info
  // response (the dialog has no library row to read it off), overridable by the
  // admin when several servers hold the title. null ⇒ no server holds it.
  const [plexInstance, setPlexInstance]         = useState<string | null>(null);
  const [jellyfinInstance, setJellyfinInstance] = useState<string | null>(null);
  const { fileInfo, fileInfoError } = useFixMatchFileInfo(open, tmdbId, mediaType, serverInstance, (info) => {
    setPlexInstance((cur) => seedInstance(cur, info.plexInstances, serverInstance));
    setJellyfinInstance((cur) => seedInstance(cur, info.jellyfinInstances, serverInstance));
  });
  const [addWrongState, setAddWrongState] = useState<AddWrongState>("idle");

  const inputRef = useRef<HTMLInputElement>(null);
  // Bumped by reset(): an add-as-request still in flight when the dialog was
  // closed must not write its outcome into the next session of the dialog.
  const addGen = useRef(0);
  // The Plex candidate read: aborted on unmount, and a newer read drops an older one.
  const reads = useAsyncAction();
  // Stops the runFixMatch status polling on unmount (the server-side job keeps
  // running by design). One controller PER SIDE: Plex and Jellyfin can be
  // applied at the same time, and a single shared ref would lose the first
  // one, leaving it polling long after the dialog is gone.
  const plexAbort = useRef<AbortController | null>(null);
  const jellyfinAbort = useRef<AbortController | null>(null);
  useEffect(() => () => {
    plexAbort.current?.abort();
    jellyfinAbort.current?.abort();
  }, []);

  const reset = useCallback(() => {
    setPhase("search");
    setQuery(title);
    clearSearch();
    setSelected(null);
    setPlexState({ status: "idle" });
    setJellyfinState({ status: "idle" });
    reads.abort("candidates");
    setPlexCandidates(null);
    setPlexPick(null);
    addGen.current++;
    setAddWrongState("idle");
    setPlexInstance(null);
    setJellyfinInstance(null);
  }, [title, reads, clearSearch]);

  const close = useCallback(() => {
    setOpen(false);
    reset();
  }, [reset]);

  // While the dialog is open, the page's live refresh waits: resolving the
  // issue refreshes the page, and on the OPEN tab that drops the issue's card
  // — and this dialog with it — before its result or the add-as-request step
  // was seen. Released on close, hide and unmount; never held while hidden,
  // where a remap can run for hours.
  useEffect(() => {
    if (!open) return;
    return holdLiveRefresh();
  }, [open]);

  // The search input takes focus on open (DialogPopup's initialFocus); Back to
  // the search step puts it there again.
  useEffect(() => {
    if (!open || phase !== "search") return;
    const timer = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(timer);
  }, [open, phase]);

  function pickResult(result: SearchHit) {
    setSelected(result);
    setPhase("confirm");
    setPlexState({ status: "idle" });
    setJellyfinState({ status: "idle" });
    setPlexCandidates(null);
  }

  async function fetchPlexCandidates() {
    if (!selected) return;
    setPlexState({ status: "fetching" });
    setPlexPick(null);
    // Same server the candidates (and their ratingKey) must come from as the
    // POST that applies them; the default is left out of the query.
    const res = await reads.run("candidates", (signal) =>
      fetchFixMatchCandidates(
        { server: "plex", tmdbId, mediaType, correctTmdbId: selected.id, serverInstance: plexInstance ?? undefined },
        signal,
      ));
    // Closed, unmounted or superseded: nothing to show.
    if (!res) return;
    if (!res.ok) {
      // The route's own (translated) reason; a reverse proxy's HTML 502/504 is
      // no answer, never a parser error.
      setPlexState({ status: "error", error: candidatesErrorText(res, t) });
      return;
    }
    setPlexCandidates(res.data);
    setPlexState({ status: "selecting" });
    setPhase("plex-candidates");
  }

  // The fallback close, for a fix that joined a remap already running (whose
  // job closes this issue separately and can't say whether it did). A resolved
  // issue stays resolved, so it is harmless when the job got there first. true
  // when the issue is closed.
  async function resolveIssue(correctedTitle: string): Promise<boolean> {
    const res = await fetchJson(withBasePath(`/api/issues/${issueId}`), {
      // Stored on the Issue and shown to the reporter in the acting admin's
      // language — the same note the job writes when it closes the issue
      // itself (fix-match-run.ts closeIssueAfterFix).
      init: jsonInit("PATCH", { status: "RESOLVED", resolution: t("adminQueue.fixMatch.resolutionNote", { title: correctedTitle }) }),
    });
    return res.ok || res.kind === "invalid";
  }

  // One apply for both services. Plex sends the candidate picked from its list;
  // Jellyfin's target is exact. Each side keeps its own AbortController (both
  // can run at once). The job closes the issue itself when the remap succeeds
  // (issueId), so the issue no longer stays open when this dialog goes away
  // mid-fix; its answer says whether it did.
  async function applyFix(side: Side, canonicalGuid?: string) {
    if (!selected) return;
    const setState = side === "plex" ? setPlexState : setJellyfinState;
    const abort = side === "plex" ? plexAbort : jellyfinAbort;
    const instance = side === "plex" ? plexInstance : jellyfinInstance;
    setState({ status: "applying" });
    if (side === "plex") setPhase("confirm");
    // A side's earlier poll (a retry after an error) never outlives its controller.
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    try {
      // Background job + status poll (guardrail 37a).
      const outcome = await runFixMatch({
        server: side, tmdbId, mediaType, correctTmdbId: selected.id,
        ...(canonicalGuid ? { canonicalGuid } : {}),
        ...(instance ? { serverInstance: instance } : {}),
        issueId, issueTitle: selected.title,
      }, { signal: ac.signal });
      const resolved = outcome.issueResolved ?? await resolveIssue(selected.title);
      setState({ status: "done", warning: fixWarning(outcome, resolved, t) });
      // Resolving is announced over SSE too; the shared refresh makes the two one.
      requestPageRefresh(() => router.refresh());
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return; // unmounted; job runs on
      // Codes → translated lines; the server's own message passes through.
      setState({ status: "error", error: fixMatchErrorMessage(err, t) });
    }
  }

  const anyFixDone = plexState.status === "done" || jellyfinState.status === "done";

  async function addWrongItemAsRequest() {
    const gen = ++addGen.current;
    setAddWrongState("adding");
    let next: "done" | "conflict" | "error";
    try {
      // A failed token fetch is returned as its own non-ok answer (nothing is
      // posted).
      const res = await postMediaRequest({
        tmdbId,
        mediaType,
        // Stored on the MediaRequest and rendered in the queue — translated.
        note: t("adminQueue.fixMatch.autoRequestNote"),
      });
      next = res.status === 409 ? "conflict" : res.ok ? "done" : "error";
    } catch {
      next = "error";
    }
    // The dialog was closed (reset) meanwhile: this answer belongs to that session.
    if (gen === addGen.current) setAddWrongState(next);
  }

  const busy = plexState.status === "fetching" || plexState.status === "applying" || jellyfinState.status === "applying";

  const plexPath = pathOf(fileInfo, "plex", plexInstance);
  const jellyfinPath = pathOf(fileInfo, "jellyfin", jellyfinInstance);
  const plexInstanceLabel = instanceLabelOf("plex", plexInstance);
  const jellyfinInstanceLabel = instanceLabelOf("jellyfin", jellyfinInstance);
  const arrTmdbId = fileInfo?.arrTmdbId ?? null;
  const q = query.trim();

  function goBack() {
    if (phase === "plex-candidates") { setPhase("confirm"); setPlexState({ status: "idle" }); setPlexCandidates(null); setPlexPick(null); }
    else { setPhase("search"); setSelected(null); }
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium
          bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 hover:bg-indigo-500/20 transition-colors"
      >
        <Wrench className="w-3 h-3" />
        {t("adminQueue.fixMatch.button")}
      </button>

      {/* While an apply is in flight the dialog HIDES rather than resetting
          (matches the sibling FixMatchModal's onHide): reopening shows the
          settled state. The job closes the issue itself, mounted or not. Only
          a not-busy close resets. */}
      <Dialog open={open} onOpenChange={(o) => { if (!o) { if (busy) setOpen(false); else close(); } }}>
        <DialogPortal>
          <DialogBackdrop />
          <DialogPopup className="max-w-3xl" initialFocus={inputRef}>

            <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-700 flex-shrink-0">
              <div className="flex items-center gap-3">
                {phase !== "search" && (
                  <button
                    onClick={goBack}
                    disabled={busy}
                    aria-label={t("adminQueue.fixMatch.back")}
                    title={t("adminQueue.fixMatch.back")}
                    className="text-zinc-500 hover:text-zinc-300 disabled:opacity-40 transition-colors"
                  >
                    <ChevronLeft className="w-5 h-5" />
                  </button>
                )}
                <DialogTitle className="text-base font-semibold text-zinc-100">
                  {phase === "search" && t("adminQueue.fixMatch.titleSearch")}
                  {phase === "confirm" && t("adminQueue.fixMatch.titleConfirm")}
                  {phase === "plex-candidates" && t("adminQueue.fixMatch.titlePlex")}
                </DialogTitle>
              </div>
              {/* Not disabled while busy: closing during an apply HIDES the
                  dialog (see onOpenChange) so the admin isn't trapped for the
                  minutes a real remap takes; the background job runs on. */}
              <DialogClose aria-label={busy ? t("adminQueue.fixMatch.hide") : t("adminQueue.common.close")} title={busy ? t("adminQueue.fixMatch.hideTitle") : t("adminQueue.common.close")} className="text-zinc-500 hover:text-zinc-300 disabled:opacity-40 transition-colors">
                <X className="w-5 h-5" />
              </DialogClose>
            </div>

            <CurrentMatchInfo
              title={title}
              tmdbId={tmdbId}
              fileInfoError={fileInfoError}
              plexPath={plexPath}
              plexLabel={plexInstanceLabel || BRAND.plex.name}
              jellyfinPath={jellyfinPath}
              jellyfinLabel={jellyfinInstanceLabel || BRAND.jellyfin.name}
              arrName={arrName}
              arrTmdbId={arrTmdbId}
              arrTitle={fileInfo?.arrTitle ?? null}
              busy={busy}
              onUseArr={pickResult}
            />

            {phase === "search" && (
              <>
                <div className="px-6 pt-4 pb-3 flex-shrink-0">
                  <div className="relative">
                    <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500 pointer-events-none" />
                    <input
                      ref={inputRef}
                      type="text"
                      // The search route refuses a longer query.
                      maxLength={200}
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder={mediaType === "MOVIE" ? t("adminQueue.fixMatch.searchMovies") : t("adminQueue.fixMatch.searchTv")}
                      aria-label={mediaType === "MOVIE" ? t("adminQueue.fixMatch.searchMovies") : t("adminQueue.fixMatch.searchTv")}
                      className="w-full bg-zinc-800 border border-zinc-700 rounded-md pl-10 pr-3 py-2.5
                        text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-indigo-500/60"
                    />
                    {searching && (
                      <Loader2 aria-hidden className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 animate-spin text-zinc-500" />
                    )}
                  </div>
                  {searchError && <p className="text-xs text-red-400 mt-1.5">{searchError}</p>}
                </div>

                <div className="overflow-y-auto flex-1 divide-y divide-zinc-800/60">
                  {searchResults.length === 0 && !searching && !searchError && q && resultsFor === q && (
                    <p className="px-6 py-8 text-sm text-zinc-500 text-center">{t("adminQueue.fixMatch.noResults")}</p>
                  )}
                  {searchResults.length === 0 && !q && (
                    <p className="px-6 py-8 text-sm text-zinc-500 text-center">{t("adminQueue.fixMatch.typeToSearch")}</p>
                  )}
                  {searchResults.map((r) => (
                    <SearchResultRow key={r.id} result={r} isCurrent={r.id === tmdbId} onPick={pickResult} />
                  ))}
                </div>
              </>
            )}

            {phase === "confirm" && selected && (
              <div className="overflow-y-auto flex-1 flex flex-col">
                <SelectedMatchHeader selected={selected} arrName={arrName} arrConfirmed={arrTmdbId === selected.id} />

                <div className="px-6 py-4 space-y-3 flex-1">
                  {onPlex && (
                    <ServerFixPanel
                      side="plex"
                      instanceLabel={plexInstanceLabel}
                      state={plexState}
                      rows={fileInfo?.plexInstances ?? []}
                      instance={plexInstance}
                      onInstance={setPlexInstance}
                      pickerDisabled={busy || plexState.status === "done"}
                      actionLabel={t("adminQueue.fixMatch.searchPlex", { id: selected.id })}
                      onAction={() => void fetchPlexCandidates()}
                    />
                  )}

                  {onJellyfin && (
                    <ServerFixPanel
                      side="jellyfin"
                      instanceLabel={jellyfinInstanceLabel}
                      state={jellyfinState}
                      rows={fileInfo?.jellyfinInstances ?? []}
                      instance={jellyfinInstance}
                      onInstance={setJellyfinInstance}
                      pickerDisabled={busy || jellyfinState.status === "done"}
                      actionLabel={t("adminQueue.fixMatch.fixJellyfin", { id: selected.id })}
                      onAction={() => void applyFix("jellyfin")}
                    />
                  )}

                  {!onPlex && !onJellyfin && (
                    <p className="text-sm text-zinc-500 text-center py-6">
                      {t("adminQueue.fixMatch.notInLibrary")}
                    </p>
                  )}

                  {anyFixDone && (
                    <AddWrongAsRequest title={title} tmdbId={tmdbId} state={addWrongState} onAdd={() => void addWrongItemAsRequest()} />
                  )}
                </div>
              </div>
            )}

            {phase === "plex-candidates" && plexCandidates && selected && (
              <PlexCandidatesList
                candidates={plexCandidates}
                selectedId={selected.id}
                instanceLabel={plexInstanceLabel}
                pick={plexPick}
                applying={plexState.status === "applying"}
                onPick={setPlexPick}
              />
            )}

            <div className="px-6 py-4 border-t border-zinc-700 flex justify-end gap-2 flex-shrink-0">
              {/* Mirrors the header X: never disabled — while an apply runs it
                  HIDES the dialog (onOpenChange) and says so, instead of the
                  same dialog answering "can I close?" two different ways. */}
              <DialogClose
                title={busy ? t("adminQueue.fixMatch.hideTitle") : undefined}
                className="text-sm px-4 py-2 rounded border border-zinc-600 text-zinc-400
                  hover:bg-zinc-800 hover:text-zinc-200 transition-colors"
              >
                {busy ? t("adminQueue.fixMatch.hide") : t("adminQueue.common.close")}
              </DialogClose>
              {phase === "plex-candidates" && plexCandidates && (
                <button
                  onClick={() => { if (plexPick) void applyFix("plex", plexPick); }}
                  disabled={plexPick === null || plexState.status === "applying"}
                  className="ds-hover-tint text-sm px-4 py-2 rounded border font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  style={{
                    background: `color-mix(in oklab, ${BRAND.plex.tint} 12%, transparent)`,
                    borderColor: `color-mix(in oklab, ${BRAND.plex.tint} 35%, var(--ds-border))`,
                    color: BRAND.plex.text,
                  }}
                >
                  {t("adminQueue.fixMatch.applyMatch")}
                </button>
              )}
            </div>
          </DialogPopup>
        </DialogPortal>
      </Dialog>
    </>
  );
}
