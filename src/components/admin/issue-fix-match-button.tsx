"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Wrench, Search, X, Check, ChevronLeft } from "@/components/icons";
import { Dialog, DialogBackdrop, DialogClose, DialogPopup, DialogPortal, DialogTitle } from "@/components/ui/dialog";
import { posterUrl } from "@/lib/tmdb-types";
import type { TmdbMedia } from "@/lib/tmdb-types";
import type { PlexCandidate, CandidatesResponse } from "@/app/api/admin/fix-match/candidates/route";
import type { FileInfoInstance, FileInfoResponse } from "@/app/api/admin/fix-match/file-info/route";
import { withBasePath } from "@/lib/base-path";
import { runFixMatch } from "@/lib/client/fix-match";
import { DEFAULT_MEDIA_INSTANCE, mediaInstanceLabel } from "@/lib/media-instances";

type ServerStatus = "idle" | "fetching" | "selecting" | "applying" | "done" | "error";

interface ServerState {
  status: ServerStatus;
  error?: string;
}

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

  isAdmin:      boolean;

  userProvider?: string;

  requestToken?: string;

  // Preferred server for the fix. This dialog starts from a tmdbId with no
  // library row in hand, so it's only a HINT: the real instance is resolved from
  // the file-info response (which lists every server holding the title).
  serverInstance?: string;
}

// Picks which configured server to act on: the caller's hint if that server
// actually holds the title, else the default server, else the first one that
// does. null when no server holds it (nothing to fix on that side).
function resolveInstance(rows: FileInfoInstance[], hint: string): string | null {
  if (rows.length === 0) return null;
  if (rows.some((r) => r.serverInstance === hint)) return hint;
  if (rows.some((r) => r.serverInstance === DEFAULT_MEDIA_INSTANCE)) return DEFAULT_MEDIA_INSTANCE;
  return rows[0].serverInstance;
}

// Seeds a side's instance from a (re)fetched file-info response. A pick the
// admin already made survives as long as some refetched row still holds it;
// only then does the hint/default resolution run. The file-info effect fires
// on every open — including the reopen after a busy HIDE (see onOpenChange),
// which keeps state on purpose — so seeding unconditionally with
// resolveInstance discarded a named-server choice made in the picker and the
// next "Fix" ran against the default server. A not-busy close nulls both
// picks via reset(), so a fresh open still resolves from scratch.
function seedInstance(cur: string | null, rows: FileInfoInstance[], hint: string): string | null {
  if (cur !== null && rows.some((r) => r.serverInstance === cur)) return cur;
  return resolveInstance(rows, hint);
}

const LEVEL_STYLES: Record<string, { border: string; bg: string; badge: string; label: string }> = {
  exact:    { border: "border-l-2 border-green-500",       bg: "bg-green-500/5 hover:bg-green-500/10",     badge: "bg-green-500/20 text-green-400 border-green-500/40",     label: "Exact"    },
  strong:   { border: "border-l-2 border-emerald-500/70",  bg: "bg-emerald-500/5 hover:bg-emerald-500/10", badge: "bg-emerald-500/20 text-emerald-400 border-emerald-500/40", label: "Strong"   },
  likely:   { border: "border-l-2 border-yellow-500/70",   bg: "bg-yellow-500/5 hover:bg-yellow-500/10",   badge: "bg-yellow-500/20 text-yellow-400 border-yellow-500/40",   label: "Likely"   },
  possible: { border: "border-l-2 border-zinc-500/50",     bg: "hover:bg-zinc-800",                        badge: "bg-zinc-700 text-zinc-400 border-zinc-600",               label: "Possible" },
  wrong:    { border: "border-l-2 border-red-500/70",      bg: "bg-red-500/5 hover:bg-red-500/10",         badge: "bg-red-500/20 text-red-400 border-red-500/40",            label: "Wrong"    },
  unknown:  { border: "border-l-2 border-transparent",     bg: "hover:bg-zinc-800",                        badge: "bg-zinc-800 text-zinc-500 border-zinc-700",               label: "Unknown"  },
};

function PlexCandidateRow({
  candidate, onSelect, disabled, serverInstance,
}: {
  candidate:      PlexCandidate;
  onSelect:       (guid: string) => void;
  disabled:       boolean;
  serverInstance: string;
}) {
  const style   = LEVEL_STYLES[candidate.matchLevel] ?? LEVEL_STYLES.unknown;
  // Relative Plex thumb paths are server-local — proxy them against the same
  // instance the candidates came from. Omitted when default.
  const thumbSrc = candidate.thumb
    ? withBasePath(`/api/admin/fix-match/thumb?${new URLSearchParams({
        path: candidate.thumb,
        ...(serverInstance ? { serverInstance } : {}),
      })}`)
    : null;

  return (
    <button
      onClick={() => onSelect(candidate.guid)}
      disabled={disabled}
      className={`w-full text-left px-5 py-3.5 flex items-start gap-4 transition-colors
        disabled:opacity-50 disabled:cursor-not-allowed ${style.border} ${style.bg}`}
    >
      <div className="flex-shrink-0 w-14 h-[84px] rounded overflow-hidden bg-zinc-800 flex items-center justify-center mt-0.5">
        {thumbSrc
          // eslint-disable-next-line @next/next/no-img-element
          ? <img src={thumbSrc} alt={candidate.name || "thumb"} className="w-full h-full object-cover" />
          : <span className="text-zinc-500 text-xs">?</span>}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-base font-medium text-zinc-200 leading-tight">
            {(candidate.tmdbTitle ?? candidate.name) || "(untitled)"}
          </span>
          {candidate.year && <span className="text-sm text-zinc-500">({candidate.year})</span>}
          <span className={`text-xs px-1.5 py-0.5 rounded border font-medium ${style.badge}`}>
            {candidate.matchLevel === "exact" ? "Exact ✓" : style.label}
          </span>
          {candidate.confidence > 0 && candidate.matchLevel !== "exact" && (
            <span className="text-xs text-zinc-500">{candidate.confidence}%</span>
          )}
        </div>
        <div className="flex items-center gap-3 mt-1 flex-wrap">
          {candidate.tmdbId && <span className="text-xs font-mono text-zinc-500">tmdb:{candidate.tmdbId}</span>}
          {candidate.imdbId && <span className="text-xs font-mono text-zinc-500">{candidate.imdbId}</span>}
          {candidate.tmdbRuntime && <span className="text-xs text-zinc-500">{candidate.tmdbRuntime} min</span>}
        </div>
      </div>
      <div className="flex-shrink-0 text-xs text-zinc-500 mt-1">Apply →</div>
    </button>
  );
}

// Minimal inline server picker — rendered only when more than one configured
// server holds the title, i.e. only when "fix the match" is genuinely ambiguous.
// A single-server deployment never sees it.
function InstancePicker({
  service, rows, value, onChange, disabled,
}: {
  service:  "plex" | "jellyfin";
  rows:     FileInfoInstance[];
  value:    string | null;
  onChange: (slug: string) => void;
  disabled: boolean;
}) {
  if (rows.length < 2) return null;
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <span className="text-xs text-zinc-500 shrink-0">Server</span>
      {rows.map((r) => (
        <button
          key={r.serverInstance}
          onClick={() => onChange(r.serverInstance)}
          disabled={disabled}
          title={r.filePath ?? undefined}
          className={`text-xs px-2 py-0.5 rounded border font-medium transition-colors disabled:opacity-50
            ${r.serverInstance === value
              ? "bg-indigo-500/20 border-indigo-500/50 text-indigo-300"
              : "bg-zinc-900 border-zinc-700 text-zinc-400 hover:bg-zinc-800"}`}
        >
          {mediaInstanceLabel(service, r.serverInstance)}
        </button>
      ))}
    </div>
  );
}

// Multi-phase dialog (search → confirm → Plex candidates) for re-matching a mismatched library item to the correct TMDB ID and resolving the issue.
export function IssueFixMatchButton({
  issueId, tmdbId, mediaType, title, onPlex, onJellyfin, isAdmin, userProvider, requestToken,
  serverInstance = DEFAULT_MEDIA_INSTANCE,
}: Props) {
  const showPlex     = onPlex     && (isAdmin || userProvider === "plex");
  const showJellyfin = onJellyfin && (isAdmin || userProvider === "jellyfin" || userProvider === "jellyfin-quickconnect");
  const router = useRouter();
  const [open, setOpen] = useState(false);

  const [phase, setPhase]               = useState<Phase>("search");
  const [query, setQuery]               = useState(title);
  const [searching, setSearching]       = useState(false);
  const [searchResults, setSearchResults] = useState<TmdbMedia[]>([]);
  const [searchError, setSearchError]   = useState("");
  const [selected, setSelected]         = useState<TmdbMedia | null>(null);

  const [plexState, setPlexState]         = useState<ServerState>({ status: "idle" });
  const [jellyfinState, setJellyfinState] = useState<ServerState>({ status: "idle" });
  const [plexCandidates, setPlexCandidates] = useState<CandidatesResponse | null>(null);
  const [fileInfo, setFileInfo]           = useState<FileInfoResponse | null>(null);
  const [fileInfoError, setFileInfoError] = useState(false);
  // Which configured server each side's fix targets. Resolved from the file-info
  // response (the dialog has no library row to read it off), overridable by the
  // admin when several servers hold the title. null ⇒ no server holds it.
  const [plexInstance, setPlexInstance]         = useState<string | null>(null);
  const [jellyfinInstance, setJellyfinInstance] = useState<string | null>(null);
  const [addWrongState, setAddWrongState] = useState<"idle" | "adding" | "done" | "conflict" | "error">("idle");

  const inputRef = useRef<HTMLInputElement>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Aborts the runFixMatch poll loop on unmount (the server-side job keeps
  // running by design). One controller PER SIDE: neither apply button is gated on
  // the other being in flight, so a single shared ref would be overwritten by the
  // second apply and leave the first polling every 3s for its full 20-minute
  // deadline after unmount — then resolve the issue and refresh a page that has
  // moved on.
  const plexAbort = useRef<AbortController | null>(null);
  const jellyfinAbort = useRef<AbortController | null>(null);
  useEffect(() => () => {
    plexAbort.current?.abort();
    jellyfinAbort.current?.abort();
  }, []);

  const reset = useCallback(() => {
    setPhase("search");
    setQuery(title);
    setSearching(false);
    setSearchResults([]);
    setSearchError("");
    setSelected(null);
    setPlexState({ status: "idle" });
    setJellyfinState({ status: "idle" });
    setPlexCandidates(null);
    setAddWrongState("idle");
    setFileInfoError(false);
    setPlexInstance(null);
    setJellyfinInstance(null);
  }, [title]);

  const close = useCallback(() => {
    setOpen(false);
    reset();
  }, [reset]);

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
    fetch(withBasePath(`/api/admin/fix-match/file-info?${params}`), {
      signal: controller.signal,
    })
      .then((r) => r.ok ? r.json() as Promise<FileInfoResponse> : null)
      .then((data) => {
        if (data) {
          setFileInfo(data);
          setPlexInstance((cur) => seedInstance(cur, data.plexInstances, serverInstance));
          setJellyfinInstance((cur) => seedInstance(cur, data.jellyfinInstances, serverInstance));
        } else setFileInfoError(true);
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setFileInfoError(true);
      });
    return () => controller.abort();
  }, [open, tmdbId, mediaType, serverInstance]);

  useEffect(() => {
    if (open && phase === "search") {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open, phase]);

  useEffect(() => {
    if (!open || phase !== "search") return;
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (!query.trim()) { setSearchResults([]); setSearchError(""); return; }
    // AbortController in addition to the debounce timer: cancels the in-flight
    // fetch when the query changes mid-request OR the popover closes, so stale
    // results from a previous keystroke can't overwrite the current ones.
    const ac = new AbortController();
    searchTimer.current = setTimeout(async () => {
      setSearching(true);
      setSearchError("");
      try {
        const type = mediaType === "MOVIE" ? "movie" : "tv";
        const res = await fetch(withBasePath(`/api/search?q=${encodeURIComponent(query.trim())}&type=${type}`), { signal: ac.signal });
        const json = await res.json() as TmdbMedia[] | { error: string };
        if (!res.ok || "error" in json) throw new Error("error" in json ? json.error : `HTTP ${res.status}`);
        setSearchResults(json as TmdbMedia[]);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setSearchError(err instanceof Error ? err.message : "Search failed");
      } finally {
        setSearching(false);
      }
    }, 350);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
      ac.abort();
    };
  }, [query, open, phase, mediaType]);

  function pickResult(result: TmdbMedia) {
    setSelected(result);
    setPhase("confirm");
    setPlexState({ status: "idle" });
    setJellyfinState({ status: "idle" });
    setPlexCandidates(null);
  }

  async function fetchPlexCandidates() {
    if (!selected) return;
    setPlexState({ status: "fetching" });
    try {
      const params = new URLSearchParams({
        server: "plex",
        tmdbId: String(tmdbId),
        mediaType,
        correctTmdbId: String(selected.id),
      });
      // Same server the candidates (and their ratingKey) must come from as the
      // POST that applies them. Omitted when default — see the file-info fetch.
      if (plexInstance) params.set("serverInstance", plexInstance);
      const res  = await fetch(withBasePath(`/api/admin/fix-match/candidates?${params}`));
      const json = await res.json() as CandidatesResponse & { error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setPlexCandidates(json);
      setPlexState({ status: "selecting" });
      setPhase("plex-candidates");
    } catch (err) {
      setPlexState({ status: "error", error: err instanceof Error ? err.message : "Failed" });
    }
  }

  async function resolveIssue(correctedTitle: string) {
    await fetch(withBasePath(`/api/issues/${issueId}`), {
      method:  "PATCH",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ status: "RESOLVED", resolution: `Match corrected to "${correctedTitle}"` }),
    }).catch(() => null);
  }

  async function applyPlex(canonicalGuid: string) {
    if (!selected) return;
    setPlexState({ status: "applying" });
    setPhase("confirm");
    const ac = new AbortController();
    plexAbort.current = ac;
    try {
      // Background job + status poll (guardrail 37a).
      await runFixMatch({
        server: "plex", tmdbId, mediaType, correctTmdbId: selected.id, canonicalGuid,
        ...(plexInstance ? { serverInstance: plexInstance } : {}),
      }, { signal: ac.signal });
      setPlexState({ status: "done" });
      await resolveIssue(selected.title);
      router.refresh();
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return; // unmounted; job runs on
      setPlexState({ status: "error", error: err instanceof Error ? err.message : "Failed" });
    }
  }

  async function applyJellyfin() {
    if (!selected) return;
    setJellyfinState({ status: "applying" });
    const ac = new AbortController();
    jellyfinAbort.current = ac;
    try {
      // Background job + status poll (guardrail 37a).
      await runFixMatch({
        server: "jellyfin", tmdbId, mediaType, correctTmdbId: selected.id,
        ...(jellyfinInstance ? { serverInstance: jellyfinInstance } : {}),
      }, { signal: ac.signal });
      setJellyfinState({ status: "done" });
      await resolveIssue(selected.title);
      router.refresh();
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return; // unmounted; job runs on
      setJellyfinState({ status: "error", error: err instanceof Error ? err.message : "Failed" });
    }
  }

  const anyFixDone = plexState.status === "done" || jellyfinState.status === "done";

  async function addWrongItemAsRequest() {
    setAddWrongState("adding");
    try {

      let token = requestToken;
      if (!token) {
        const tokenRes = await fetch(withBasePath(`/api/requests/token?tmdbId=${tmdbId}&mediaType=${mediaType}`));
        if (tokenRes.ok) token = (await tokenRes.json()).token;
      }
      const res = await fetch(withBasePath("/api/requests"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tmdbId,
          mediaType,
          note: `Added from fix-match — was incorrectly matched in library`,
          _token: token,
        }),
      });
      if (res.status === 409) { setAddWrongState("conflict"); return; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setAddWrongState("done");
    } catch {
      setAddWrongState("error");
    }
  }

  const busy = plexState.status === "fetching" || plexState.status === "applying" || jellyfinState.status === "applying";

  // Path shown for whichever server each side is currently pointed at; falls back
  // to the path the route resolved for the requested instance.
  const plexPath     = (fileInfo?.plexInstances.find((r) => r.serverInstance === plexInstance)?.filePath)
    ?? fileInfo?.plexFilePath ?? null;
  const jellyfinPath = (fileInfo?.jellyfinInstances.find((r) => r.serverInstance === jellyfinInstance)?.filePath)
    ?? fileInfo?.jellyfinFilePath ?? null;
  // Empty for the default server, so a single-server deployment renders exactly
  // as before.
  const plexInstanceLabel = plexInstance && plexInstance !== DEFAULT_MEDIA_INSTANCE
    ? mediaInstanceLabel("plex", plexInstance) : "";
  const jellyfinInstanceLabel = jellyfinInstance && jellyfinInstance !== DEFAULT_MEDIA_INSTANCE
    ? mediaInstanceLabel("jellyfin", jellyfinInstance) : "";

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium
          bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 hover:bg-indigo-500/20 transition-colors"
      >
        <Wrench className="w-3 h-3" />
        Fix Match
      </button>

      {/* While an apply is in flight the dialog HIDES rather than resetting
          (matches the sibling FixMatchModal's onHide): the component stays
          mounted so runFixMatch's poll still resolves the issue and refreshes,
          and reopening shows the settled state. Only a not-busy close resets. */}
      <Dialog open={open} onOpenChange={(o) => { if (!o) { if (busy) setOpen(false); else close(); } }}>
        <DialogPortal>
          <DialogBackdrop />
          <DialogPopup className="max-w-3xl" initialFocus={inputRef}>

            <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-700 flex-shrink-0">
              <div className="flex items-center gap-3">
                {phase !== "search" && (
                  <button
                    onClick={() => {
                      if (phase === "plex-candidates") { setPhase("confirm"); setPlexState({ status: "idle" }); setPlexCandidates(null); }
                      else { setPhase("search"); setSelected(null); }
                    }}
                    disabled={busy}
                    aria-label="Back"
                    title="Back"
                    className="text-zinc-500 hover:text-zinc-300 disabled:opacity-40 transition-colors"
                  >
                    <ChevronLeft className="w-5 h-5" />
                  </button>
                )}
                <DialogTitle className="text-base font-semibold text-zinc-100">
                  {phase === "search" && "Find correct match"}
                  {phase === "confirm" && "Apply fix"}
                  {phase === "plex-candidates" && "Select Plex item"}
                </DialogTitle>
              </div>
              {/* Not disabled while busy: closing during an apply HIDES the
                  dialog (see onOpenChange) so the admin isn't trapped for the
                  minutes a real remap takes; the background job runs on. */}
              <DialogClose aria-label={busy ? "Hide" : "Close"} title={busy ? "Hide — the fix keeps running" : "Close"} className="text-zinc-500 hover:text-zinc-300 disabled:opacity-40 transition-colors">
                <X className="w-5 h-5" />
              </DialogClose>
            </div>

            <div className="px-6 py-3 border-b border-zinc-800 flex-shrink-0 space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-xs text-zinc-500 font-mono uppercase shrink-0">Current</span>
                <span className="text-sm text-zinc-400 truncate">{title}</span>
                <span className="text-xs font-mono text-zinc-500 shrink-0">#{tmdbId}</span>
              </div>
              {fileInfoError && (
                <p className="text-xs text-orange-400/80">
                  Couldn&apos;t load file details. Match info may be incomplete.
                </p>
              )}
              {plexPath && (
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-yellow-500/70 w-16 shrink-0">
                    {plexInstanceLabel || "Plex"}
                  </span>
                  <p className="text-xs font-mono text-zinc-500 truncate" title={plexPath}>
                    {plexPath.replace(/\\/g, "/").split("/").pop()}
                  </p>
                </div>
              )}
              {jellyfinPath && (
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-purple-500/70 w-16 shrink-0">
                    {jellyfinInstanceLabel || "Jellyfin"}
                  </span>
                  <p className="text-xs font-mono text-zinc-500 truncate" title={jellyfinPath}>
                    {jellyfinPath.replace(/\\/g, "/").split("/").pop()}
                  </p>
                </div>
              )}
              {fileInfo?.arrTmdbId !== null && fileInfo?.arrTmdbId !== undefined && fileInfo.arrTmdbId !== tmdbId && (
                <div className="flex items-center gap-2 pt-0.5">
                  <span className="text-xs font-semibold text-zinc-500 w-16 shrink-0">
                    {mediaType === "MOVIE" ? "Radarr" : "Sonarr"}
                  </span>
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-xs text-orange-400 font-mono shrink-0">→ TMDB #{fileInfo.arrTmdbId}</span>
                    {fileInfo.arrTitle && (
                      <span className="text-xs text-orange-300 truncate">{fileInfo.arrTitle}</span>
                    )}
                    <button
                      onClick={() => {
                        if (!fileInfo.arrTmdbId || !fileInfo.arrTitle) return;
                        pickResult({
                          id: fileInfo.arrTmdbId,
                          mediaType: mediaType === "MOVIE" ? "movie" : "tv",
                          title: fileInfo.arrTitle,
                          overview: "",
                          posterPath: null,
                          backdropPath: null,
                          releaseDate: null,
                          releaseYear: "",
                          voteAverage: 0,
                        });
                      }}
                      className="text-xs px-2 py-0.5 rounded border border-orange-600/30 bg-orange-500/10
                        text-orange-400 hover:bg-orange-500/20 transition-colors shrink-0 font-medium"
                    >
                      Use this →
                    </button>
                  </div>
                </div>
              )}
              {fileInfo?.arrTmdbId !== null && fileInfo?.arrTmdbId !== undefined && fileInfo.arrTmdbId === tmdbId && (
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-zinc-500 w-16 shrink-0">
                    {mediaType === "MOVIE" ? "Radarr" : "Sonarr"}
                  </span>
                  <span className="text-xs text-emerald-600">matches current — may be a different issue</span>
                </div>
              )}
            </div>

            {phase === "search" && (
              <>
                <div className="px-6 pt-4 pb-3 flex-shrink-0">
                  <div className="relative">
                    <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500 pointer-events-none" />
                    <input
                      ref={inputRef}
                      type="text"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder={`Search ${mediaType === "MOVIE" ? "movies" : "TV shows"}…`}
                      className="w-full bg-zinc-800 border border-zinc-700 rounded-md pl-10 pr-3 py-2.5
                        text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-indigo-500/60"
                    />
                    {searching && (
                      <div className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 border border-zinc-500 border-t-transparent rounded-full animate-spin" />
                    )}
                  </div>
                  {searchError && <p className="text-xs text-red-400 mt-1.5">{searchError}</p>}
                </div>

                <div className="overflow-y-auto flex-1 divide-y divide-zinc-800/60">
                  {searchResults.length === 0 && !searching && query.trim() && (
                    <p className="px-6 py-8 text-sm text-zinc-500 text-center">No results found.</p>
                  )}
                  {searchResults.length === 0 && !query.trim() && (
                    <p className="px-6 py-8 text-sm text-zinc-500 text-center">Type to search…</p>
                  )}
                  {searchResults.map((r) => {
                    const thumb = posterUrl(r.posterPath, "w342");
                    const isCurrentMatch = r.id === tmdbId;
                    return (
                      <button
                        key={r.id}
                        onClick={() => pickResult(r)}
                        disabled={isCurrentMatch}
                        className={`w-full text-left px-6 py-4 flex items-start gap-4 transition-colors
                          ${isCurrentMatch
                            ? "opacity-40 cursor-not-allowed"
                            : "hover:bg-zinc-800/70"}`}
                      >
                        <div className="flex-shrink-0 w-12 h-[72px] rounded overflow-hidden bg-zinc-800">
                          {thumb
                            // eslint-disable-next-line @next/next/no-img-element
                            ? <img src={thumb} alt={r.title} className="w-full h-full object-cover" />
                            : <div className="w-full h-full flex items-center justify-center text-zinc-700 text-xs">?</div>}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-base font-medium text-zinc-200 leading-tight">{r.title}</span>
                            {r.releaseYear && <span className="text-sm text-zinc-500">({r.releaseYear})</span>}
                            {isCurrentMatch && <span className="text-xs text-zinc-500">current</span>}
                          </div>
                          <span className="text-xs font-mono text-zinc-500 mt-0.5 block">TMDB #{r.id}</span>
                          {r.overview && (
                            <p className="text-xs text-zinc-500 mt-1 line-clamp-2 leading-snug">{r.overview}</p>
                          )}
                        </div>
                        <div className="flex-shrink-0 text-xs text-zinc-500 mt-1">Select →</div>
                      </button>
                    );
                  })}
                </div>
              </>
            )}

            {phase === "confirm" && selected && (
              <div className="overflow-y-auto flex-1 flex flex-col">
                <div className="px-6 py-4 border-b border-zinc-800 flex-shrink-0 flex gap-4 items-start">
                  {(() => {
                    const thumb = posterUrl(selected.posterPath, "w342");
                    return thumb
                      ? <div className="flex-shrink-0 w-16 h-[96px] rounded overflow-hidden">
                          {/* eslint-disable-next-line @next/next/no-img-element -- tiny 64×96 picker thumbnail; next/image overhead isn't worth it here */}
                          <img src={thumb} alt={selected.title} className="w-full h-full object-cover" />
                        </div>
                      : <div className="flex-shrink-0 w-16 h-[96px] rounded bg-zinc-800" />;
                  })()}
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-zinc-500 uppercase tracking-wide mb-1">Correct match</p>
                    <p className="text-base font-semibold text-zinc-100 leading-tight">{selected.title}</p>
                    {selected.releaseYear && <p className="text-sm text-zinc-400 mt-0.5">{selected.releaseYear}</p>}
                    <p className="text-xs font-mono text-zinc-500 mt-0.5">TMDB #{selected.id}</p>
                    {fileInfo?.arrTmdbId === selected.id && (
                      <p className="text-xs text-emerald-500 mt-0.5">
                        ✓ {mediaType === "MOVIE" ? "Radarr" : "Sonarr"} confirmed
                      </p>
                    )}
                    {selected.overview && (
                      <p className="text-xs text-zinc-500 mt-1.5 leading-snug line-clamp-3">{selected.overview}</p>
                    )}
                  </div>
                </div>

                <div className="px-6 py-4 space-y-3 flex-1">
                  {showPlex && (
                    <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4 space-y-2.5">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-semibold text-yellow-400">
                          Plex{plexInstanceLabel && <span className="ml-1.5 text-xs font-normal text-zinc-400">{plexInstanceLabel}</span>}
                        </span>
                        {plexState.status === "done" && (
                          <span className="flex items-center gap-1.5 text-xs text-green-400"><Check className="w-3.5 h-3.5" /> Fixed</span>
                        )}
                        {plexState.status === "error" && (
                          <span className="text-xs text-red-400">{plexState.error}</span>
                        )}
                      </div>
                      <InstancePicker
                        service="plex"
                        rows={fileInfo?.plexInstances ?? []}
                        value={plexInstance}
                        onChange={setPlexInstance}
                        disabled={busy || plexState.status === "done"}
                      />
                      {plexState.status === "idle" || plexState.status === "error" ? (
                        <button
                          onClick={fetchPlexCandidates}
                          className="w-full text-xs px-3 py-2 rounded border font-medium transition-colors
                            bg-yellow-500/10 border-yellow-600/30 text-yellow-400
                            hover:bg-yellow-500/20 hover:border-yellow-500/50"
                        >
                          Search Plex for TMDB #{selected.id} →
                        </button>
                      ) : plexState.status === "fetching" ? (
                        <p className="text-xs text-zinc-500">Loading Plex candidates…</p>
                      ) : plexState.status === "applying" ? (
                        <p className="text-xs text-zinc-500">Applying…</p>
                      ) : null}
                    </div>
                  )}

                  {showJellyfin && (
                    <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4 space-y-2.5">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-semibold text-purple-400">
                          Jellyfin{jellyfinInstanceLabel && <span className="ml-1.5 text-xs font-normal text-zinc-400">{jellyfinInstanceLabel}</span>}
                        </span>
                        {jellyfinState.status === "done" && (
                          <span className="flex items-center gap-1.5 text-xs text-green-400"><Check className="w-3.5 h-3.5" /> Fixed</span>
                        )}
                        {jellyfinState.status === "error" && (
                          <span className="text-xs text-red-400">{jellyfinState.error}</span>
                        )}
                      </div>
                      <InstancePicker
                        service="jellyfin"
                        rows={fileInfo?.jellyfinInstances ?? []}
                        value={jellyfinInstance}
                        onChange={setJellyfinInstance}
                        disabled={busy || jellyfinState.status === "done"}
                      />
                      {jellyfinState.status === "idle" || jellyfinState.status === "error" ? (
                        <button
                          onClick={applyJellyfin}
                          className="w-full text-xs px-3 py-2 rounded border font-medium transition-colors
                            bg-purple-500/10 border-purple-600/30 text-purple-400
                            hover:bg-purple-500/20 hover:border-purple-500/50"
                        >
                          Fix Jellyfin → TMDB #{selected.id}
                        </button>
                      ) : jellyfinState.status === "applying" ? (
                        <p className="text-xs text-zinc-500">Applying…</p>
                      ) : null}
                    </div>
                  )}

                  {!showPlex && !showJellyfin && (
                    <p className="text-sm text-zinc-500 text-center py-6">
                      This item is not in any synced library.
                    </p>
                  )}

                  {anyFixDone && (
                    <div className="rounded-lg border border-zinc-700 bg-zinc-900 p-4 space-y-2">
                      <p className="text-xs text-zinc-400 leading-snug">
                        The previously wrong match{" "}
                        <span className="font-medium text-zinc-200">{title}</span>{" "}
                        <span className="font-mono text-zinc-500">#{tmdbId}</span>{" "}
                        may still be a title users want. Add it as a new media request?
                      </p>
                      {addWrongState === "idle" && (
                        <button
                          onClick={addWrongItemAsRequest}
                          className="text-xs px-3 py-1.5 rounded border font-medium transition-colors
                            bg-zinc-800 border-zinc-600 text-zinc-300 hover:bg-zinc-700 hover:border-zinc-500"
                        >
                          Add &ldquo;{title}&rdquo; as new request
                        </button>
                      )}
                      {addWrongState === "adding" && (
                        <p className="text-xs text-zinc-500">Adding…</p>
                      )}
                      {addWrongState === "done" && (
                        <p className="flex items-center gap-1.5 text-xs text-green-400">
                          <Check className="w-3.5 h-3.5" /> Added as new request
                        </p>
                      )}
                      {addWrongState === "conflict" && (
                        <p className="text-xs text-zinc-500">Already exists as a request.</p>
                      )}
                      {addWrongState === "error" && (
                        <p className="text-xs text-red-400">Failed to add — try again.</p>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}

            {phase === "plex-candidates" && plexCandidates && selected && (
              <>
                <div className="px-6 pt-4 pb-3 border-b border-zinc-700 flex-shrink-0">
                  <p className="text-xs text-zinc-500 uppercase tracking-wide mb-1.5">
                    Plex candidates for TMDB #{selected.id} · {plexCandidates.candidates.length} found
                    {plexInstanceLabel && (
                      <span className="ml-1.5 normal-case text-orange-400">on {plexInstanceLabel}</span>
                    )}
                  </p>
                  {plexCandidates.arrConfirmedTmdbId !== null && (
                    <p className={`text-sm ${plexCandidates.arrConfirmedTmdbId === selected.id ? "text-emerald-400" : "text-yellow-400"}`}>
                      {plexCandidates.arrConfirmedTmdbId === selected.id
                        ? "✓ Radarr/Sonarr confirms this TMDB ID"
                        : `⚠ Radarr/Sonarr has TMDB #${plexCandidates.arrConfirmedTmdbId}`}
                    </p>
                  )}
                </div>

                <div className="overflow-y-auto flex-1 divide-y divide-zinc-800/60">
                  {plexCandidates.candidates.length === 0 ? (
                    <p className="px-6 py-8 text-sm text-zinc-500 text-center">No candidates found in Plex.</p>
                  ) : (
                    plexCandidates.candidates.map((c) => (
                      <PlexCandidateRow
                        key={c.guid}
                        candidate={c}
                        onSelect={applyPlex}
                        disabled={plexState.status === "applying"}
                        serverInstance={plexCandidates.serverInstance}
                      />
                    ))
                  )}
                </div>
              </>
            )}

            <div className="px-6 py-4 border-t border-zinc-700 flex justify-end flex-shrink-0">
              <DialogClose
                disabled={busy}
                className="text-sm px-4 py-2 rounded border border-zinc-600 text-zinc-400
                  hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-50 transition-colors"
              >
                Close
              </DialogClose>
            </div>
          </DialogPopup>
        </DialogPortal>
      </Dialog>
    </>
  );
}
