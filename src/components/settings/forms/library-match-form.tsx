"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, RefreshCw } from "@/components/icons";
import { SaveStatusMessage } from "./save-status";
import { withBasePath } from "@/lib/base-path";
import type { SaveStatus } from "./shared";

type MediaSampleData = { mountPoint: string; samples: string[] };
type ServerSamples   = { movie: MediaSampleData; tv: MediaSampleData };

// Strips a leading prefix (trailing slash tolerated) from a path — client-side preview of the server's path-strip logic.
function applyPrefix(path: string, prefix: string): string {
  if (!prefix) return path;
  const p = prefix.endsWith("/") ? prefix : prefix + "/";
  return path.startsWith(p) ? path.slice(p.length) : path;
}

function LibraryMatchMediaBlock({
  mediaLabel, data, prefix, onChangePrefix, placeholder,
}: {
  mediaLabel: string; data: MediaSampleData | null;
  prefix: string; onChangePrefix: (v: string) => void; placeholder: string;
}) {
  return (
    <div className="space-y-2">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">{mediaLabel}</p>

      {data && (
        <>
          <div className="rounded bg-zinc-800/60 border border-zinc-700/60 px-3 py-2 space-y-0.5">
            <p className="text-[10px] text-zinc-500 uppercase tracking-wide">Mount point (auto-stripped)</p>
            <p className="text-xs text-zinc-300 font-mono">{data.mountPoint || "(none detected)"}</p>
          </div>

          <div className="rounded bg-zinc-800/60 border border-zinc-700/60 px-3 py-2 space-y-1">
            <p className="text-[10px] text-zinc-500 uppercase tracking-wide mb-1">Sample relative paths</p>
            {data.samples.length === 0
              ? <p className="text-[11px] text-zinc-500 italic">No paths found</p>
              : data.samples.map((s, i) => (
                  <p key={i} className="text-[11px] text-zinc-400 font-mono truncate" title={s}>{s}</p>
                ))
            }
          </div>
        </>
      )}

      <div className="space-y-1">
        <Label className="text-xs text-zinc-400">Additional prefix to strip</Label>
        <Input
          value={prefix}
          onChange={(e) => onChangePrefix(e.target.value)}
          placeholder={placeholder}
          className="bg-zinc-800 border-zinc-700 font-mono text-sm h-8"
        />
      </div>

      {data && prefix && (
        <div className="rounded bg-zinc-800/60 border border-zinc-700/60 px-3 py-2 space-y-1">
          <p className="text-[10px] text-zinc-500 uppercase tracking-wide mb-1">Preview after stripping</p>
          {data.samples.map((s, i) => {
            const after   = applyPrefix(s, prefix);
            const changed = after !== s;
            return (
              <p key={i} className={`text-[11px] font-mono truncate ${changed ? "text-green-400" : "text-zinc-500"}`} title={after}>
                {after}
              </p>
            );
          })}
        </div>
      )}
    </div>
  );
}

function LibraryMatchServerBlock({
  label, accent, data, moviePrefix, tvPrefix,
  onChangeMoviePrefix, onChangeTvPrefix, loading, loadError,
}: {
  label: string; accent: string; data: ServerSamples | null;
  moviePrefix: string; tvPrefix: string;
  onChangeMoviePrefix: (v: string) => void; onChangeTvPrefix: (v: string) => void;
  loading: boolean; loadError: string;
}) {
  return (
    <div className="space-y-4">
      <p className={`text-xs font-semibold uppercase tracking-wide ${accent}`}>{label}</p>

      {!data && !loading && (
        <p className="text-xs text-zinc-500 italic">Click &quot;Load examples&quot; to see sample paths.</p>
      )}
      {loadError && <p className="text-xs text-red-400">{loadError}</p>}

      {data && (
        <div className="space-y-5">
          <LibraryMatchMediaBlock
            mediaLabel="Movies"
            data={data.movie}
            prefix={moviePrefix}
            onChangePrefix={onChangeMoviePrefix}
            placeholder="e.g. movies/"
          />
          <div className="border-t border-zinc-800" />
          <LibraryMatchMediaBlock
            mediaLabel="TV Shows"
            data={data.tv}
            prefix={tvPrefix}
            onChangePrefix={onChangeTvPrefix}
            placeholder="e.g. tv/"
          />
        </div>
      )}
    </div>
  );
}

interface LibraryMatchFormProps {
  initialPlexMoviePrefix:     string;
  initialPlexTvPrefix:        string;
  initialJellyfinMoviePrefix: string;
  initialJellyfinTvPrefix:    string;
}

export function LibraryMatchForm({
  initialPlexMoviePrefix,
  initialPlexTvPrefix,
  initialJellyfinMoviePrefix,
  initialJellyfinTvPrefix,
}: LibraryMatchFormProps) {
  const [plexMoviePrefix,     setPlexMoviePrefix]     = useState(initialPlexMoviePrefix);
  const [plexTvPrefix,        setPlexTvPrefix]        = useState(initialPlexTvPrefix);
  const [jellyfinMoviePrefix, setJellyfinMoviePrefix] = useState(initialJellyfinMoviePrefix);
  const [jellyfinTvPrefix,    setJellyfinTvPrefix]    = useState(initialJellyfinTvPrefix);
  const [saveStatus,          setSaveStatus]          = useState<SaveStatus>("idle");
  const [loading,             setLoading]             = useState(false);
  const [plex,                setPlex]                = useState<ServerSamples | null>(null);
  const [jellyfin,            setJellyfin]            = useState<ServerSamples | null>(null);
  const [loadError,           setLoadError]           = useState("");

  async function loadSamples() {
    setLoading(true);
    setLoadError("");
    try {
      const res = await fetch(withBasePath("/api/admin/library-sample-paths"));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { plex: ServerSamples; jellyfin: ServerSamples };
      setPlex(data.plex);
      setJellyfin(data.jellyfin);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaveStatus("saving");
    try {
      const res = await fetch(withBasePath("/api/settings"), {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          plexMoviePathStripPrefix:     plexMoviePrefix,
          plexTvPathStripPrefix:        plexTvPrefix,
          jellyfinMoviePathStripPrefix: jellyfinMoviePrefix,
          jellyfinTvPathStripPrefix:    jellyfinTvPrefix,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean };
      setSaveStatus(res.ok && data.ok !== false ? "ok" : "error");
    } catch {
      setSaveStatus("error");
    }
    setTimeout(() => setSaveStatus("idle"), 3000);
  }

  const onChangePlexMoviePrefix     = (v: string) => { setPlexMoviePrefix(v);     setSaveStatus("idle"); };
  const onChangePlexTvPrefix        = (v: string) => { setPlexTvPrefix(v);        setSaveStatus("idle"); };
  const onChangeJellyfinMoviePrefix = (v: string) => { setJellyfinMoviePrefix(v); setSaveStatus("idle"); };
  const onChangeJellyfinTvPrefix    = (v: string) => { setJellyfinTvPrefix(v);    setSaveStatus("idle"); };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm text-zinc-400">
          Strip prefixes per server and media type so relative paths align when comparing Plex and Jellyfin for bad-match detection.
        </p>
        <Button
          type="button"
          variant="outline"
          onClick={loadSamples}
          disabled={loading}
          className="border-zinc-700 text-zinc-400 hover:text-white gap-2 shrink-0"
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          Load examples
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <LibraryMatchServerBlock
          label="Plex" accent="text-yellow-400"
          data={plex}
          moviePrefix={plexMoviePrefix} tvPrefix={plexTvPrefix}
          onChangeMoviePrefix={onChangePlexMoviePrefix} onChangeTvPrefix={onChangePlexTvPrefix}
          loading={loading} loadError={loadError}
        />
        <LibraryMatchServerBlock
          label="Jellyfin" accent="text-purple-400"
          data={jellyfin}
          moviePrefix={jellyfinMoviePrefix} tvPrefix={jellyfinTvPrefix}
          onChangeMoviePrefix={onChangeJellyfinMoviePrefix} onChangeTvPrefix={onChangeJellyfinTvPrefix}
          loading={loading} loadError={loadError}
        />
      </div>

      <form onSubmit={handleSave} className="flex items-center gap-3 flex-wrap">
        <Button type="submit" disabled={saveStatus === "saving"} className="bg-indigo-600 hover:bg-indigo-500">
          {saveStatus === "saving" ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Saving…</> : "Save"}
        </Button>
        <SaveStatusMessage status={saveStatus} />
      </form>
    </div>
  );
}
