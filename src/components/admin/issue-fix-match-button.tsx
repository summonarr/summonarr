"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { Wrench, Search, X, Check, ChevronLeft } from "lucide-react";
import { posterUrl } from "@/lib/tmdb-types";
import type { TmdbMedia } from "@/lib/tmdb-types";
import type { PlexCandidate, CandidatesResponse } from "@/app/api/admin/fix-match/candidates/route";
import type { FileInfoResponse } from "@/app/api/admin/fix-match/file-info/route";

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
  candidate, onSelect, disabled,
}: {
  candidate: PlexCandidate;
  onSelect:  (guid: string) => void;
  disabled:  boolean;
}) {
  const style   = LEVEL_STYLES[candidate.matchLevel] ?? LEVEL_STYLES.unknown;
  const thumbSrc = candidate.thumb
    ? `/api/admin/fix-match/thumb?path=${encodeURIComponent(candidate.thumb)}`
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
          : <span className="text-zinc-600 text-xs">?</span>}
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
            <span className="text-xs text-zinc-600">{candidate.confidence}%</span>
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

export function IssueFixMatchButton({ issueId, tmdbId, mediaType, title, onPlex, onJellyfin, isAdmin, userProvider, requestToken }: Props) {
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

  const inputRef = useRef<HTMLInputElement>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
  }, [title]);

  const close = useCallback(() => {
    setOpen(false);
    reset();
  }, [reset]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, close]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    fetch(`/api/admin/fix-match/file-info?tmdbId=${tmdbId}&mediaType=${mediaType}`, {
      signal: controller.signal,
    })
      .then((r) => r.ok ? r.json() as Promise<FileInfoResponse> : null)
      .then((data) => { if (data) setFileInfo(data); })
      .catch(() => null);
    return () => controller.abort();
  }, [open, tmdbId, mediaType]);

  useEffect(() => {
    if (open && phase === "search") {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open, phase]);

  useEffect(() => {
    if (!open || phase !== "search") return;
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (!query.trim()) { setSearchResults([]); setSearchError(""); return; }
    searchTimer.current = setTimeout(async () => {
      setSearching(true);
      setSearchError("");
      try {
        const type = mediaType === "MOVIE" ? "movie" : "tv";
        const res = await fetch(`/api/search?q=${encodeURIComponent(query.trim())}&type=${type}`);
        const json = await res.json() as TmdbMedia[] | { error: string };
        if (!res.ok || "error" in json) throw new Error("error" in json ? json.error : `HTTP ${res.status}`);
        setSearchResults(json as TmdbMedia[]);
      } catch (err) {
        setSearchError(err instanceof Error ? err.message : "Search failed");
      } finally {
        setSearching(false);
      }
    }, 350);
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
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
      const res  = await fetch(`/api/admin/fix-match/candidates?${params}`);
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
    await fetch(`/api/issues/${issueId}`, {
      method:  "PATCH",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ status: "RESOLVED", resolution: `Match corrected to "${correctedTitle}"` }),
    }).catch(() => null);
  }

  async function applyPlex(canonicalGuid: string) {
    if (!selected) return;
    setPlexState({ status: "applying" });
    setPhase("confirm");
    try {
      const res  = await fetch("/api/admin/fix-match", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ server: "plex", tmdbId, mediaType, correctTmdbId: selected.id, canonicalGuid }),
      });
      const json = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setPlexState({ status: "done" });
      await resolveIssue(selected.title);
      router.refresh();
    } catch (err) {
      setPlexState({ status: "error", error: err instanceof Error ? err.message : "Failed" });
    }
  }

  async function applyJellyfin() {
    if (!selected) return;
    setJellyfinState({ status: "applying" });
    try {
      const res  = await fetch("/api/admin/fix-match", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ server: "jellyfin", tmdbId, mediaType, correctTmdbId: selected.id }),
      });
      const json = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setJellyfinState({ status: "done" });
      await resolveIssue(selected.title);
      router.refresh();
    } catch (err) {
      setJellyfinState({ status: "error", error: err instanceof Error ? err.message : "Failed" });
    }
  }

  const [addWrongState, setAddWrongState] = useState<"idle" | "adding" | "done" | "conflict" | "error">("idle");

  const anyFixDone = plexState.status === "done" || jellyfinState.status === "done";

  async function addWrongItemAsRequest() {
    setAddWrongState("adding");
    try {

      let token = requestToken;
      if (!token) {
        const tokenRes = await fetch(`/api/requests/token?tmdbId=${tmdbId}&mediaType=${mediaType}`);
        if (tokenRes.ok) token = (await tokenRes.json()).token;
      }
      const res = await fetch("/api/requests", {
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

      {open && createPortal(
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
          onClick={(e) => { if (e.target === e.currentTarget && !busy) close(); }}
        >
          <div className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col">

            <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-700 flex-shrink-0">
              <div className="flex items-center gap-3">
                {phase !== "search" && (
                  <button
                    onClick={() => {
                      if (phase === "plex-candidates") { setPhase("confirm"); setPlexState({ status: "idle" }); setPlexCandidates(null); }
                      else { setPhase("search"); setSelected(null); }
                    }}
                    disabled={busy}
                    className="text-zinc-500 hover:text-zinc-300 disabled:opacity-40 transition-colors"
                  >
                    <ChevronLeft className="w-5 h-5" />
                  </button>
                )}
                <p className="text-base font-semibold text-zinc-100">
                  {phase === "search" && "Find correct match"}
                  {phase === "confirm" && "Apply fix"}
                  {phase === "plex-candidates" && "Select Plex item"}
                </p>
              </div>
              <button onClick={close} disabled={busy} className="text-zinc-500 hover:text-zinc-300 disabled:opacity-40 transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="px-6 py-3 border-b border-zinc-800 flex-shrink-0 space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-xs text-zinc-600 font-mono uppercase shrink-0">Current</span>
                <span className="text-sm text-zinc-400 truncate">{title}</span>
                <span className="text-xs font-mono text-zinc-600 shrink-0">#{tmdbId}</span>
              </div>
              {fileInfo?.plexFilePath && (
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-yellow-500/70 w-16 shrink-0">Plex</span>
                  <p className="text-xs font-mono text-zinc-500 truncate" title={fileInfo.plexFilePath}>
                    {fileInfo.plexFilePath.replace(/\\/g, "/").split("/").pop()}
                  </p>
                </div>
              )}
              {fileInfo?.jellyfinFilePath && (
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-purple-500/70 w-16 shrink-0">Jellyfin</span>
                  <p className="text-xs font-mono text-zinc-500 truncate" title={fileInfo.jellyfinFilePath}>
                    {fileInfo.jellyfinFilePath.replace(/\\/g, "/").split("/").pop()}
                  </p>
                </div>
              )}
              {fileInfo?.arrTmdbId !== null && fileInfo?.arrTmdbId !== undefined && fileInfo.arrTmdbId !== tmdbId && (
                <div className="flex items-center gap-2 pt-0.5">
                  <span className="text-xs font-semibold text-zinc-600 w-16 shrink-0">
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
                  <span className="text-xs font-semibold text-zinc-600 w-16 shrink-0">
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
                    <p className="px-6 py-8 text-sm text-zinc-600 text-center">Type to search…</p>
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
                            {isCurrentMatch && <span className="text-xs text-zinc-600">current</span>}
                          </div>
                          <span className="text-xs font-mono text-zinc-600 mt-0.5 block">TMDB #{r.id}</span>
                          {r.overview && (
                            <p className="text-xs text-zinc-500 mt-1 line-clamp-2 leading-snug">{r.overview}</p>
                          )}
                        </div>
                        <div className="flex-shrink-0 text-xs text-zinc-600 mt-1">Select →</div>
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
                          {}
                          <img src={thumb} alt={selected.title} className="w-full h-full object-cover" />
                        </div>
                      : <div className="flex-shrink-0 w-16 h-[96px] rounded bg-zinc-800" />;
                  })()}
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-zinc-500 uppercase tracking-wide mb-1">Correct match</p>
                    <p className="text-base font-semibold text-zinc-100 leading-tight">{selected.title}</p>
                    {selected.releaseYear && <p className="text-sm text-zinc-400 mt-0.5">{selected.releaseYear}</p>}
                    <p className="text-xs font-mono text-zinc-600 mt-0.5">TMDB #{selected.id}</p>
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
                        <span className="text-sm font-semibold text-yellow-400">Plex</span>
                        {plexState.status === "done" && (
                          <span className="flex items-center gap-1.5 text-xs text-green-400"><Check className="w-3.5 h-3.5" /> Fixed</span>
                        )}
                        {plexState.status === "error" && (
                          <span className="text-xs text-red-400">{plexState.error}</span>
                        )}
                      </div>
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
                        <span className="text-sm font-semibold text-purple-400">Jellyfin</span>
                        {jellyfinState.status === "done" && (
                          <span className="flex items-center gap-1.5 text-xs text-green-400"><Check className="w-3.5 h-3.5" /> Fixed</span>
                        )}
                        {jellyfinState.status === "error" && (
                          <span className="text-xs text-red-400">{jellyfinState.error}</span>
                        )}
                      </div>
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
                        <span className="font-mono text-zinc-600">#{tmdbId}</span>{" "}
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
                      />
                    ))
                  )}
                </div>
              </>
            )}

            <div className="px-6 py-4 border-t border-zinc-700 flex justify-end flex-shrink-0">
              <button
                onClick={close}
                disabled={busy}
                className="text-sm px-4 py-2 rounded border border-zinc-600 text-zinc-400
                  hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-50 transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
