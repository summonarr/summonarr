"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { XCircle, Loader2, RefreshCw, RefreshCcw, Trash2, Database } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";

// Cache Management: a Clear and a Refetch button for each metadata source, plus
// one "Clear & Refetch All" button.
//
// "Clear" calls DELETE /api/admin/clear-cache?source=<id>. "Refetch" POSTs to the
// source's warm route, which re-downloads data for the whole library. The TMDB
// details cache holds most of the metadata (country, language, keywords, watch
// providers, genres).

type CacheSourceId = "tmdb" | "mdblist" | "omdb";

interface CacheSourceDef {
  id: CacheSourceId;
  label: string;
  description: string;
  warmUrl: string;
  // Extra JSON body for the warm route. MDBList takes { force: true } to also
  // delete its saved "not found" markers first, so those titles are retried.
  warmBody?: Record<string, unknown>;
}

const CACHE_SOURCES: CacheSourceDef[] = [
  {
    id: "tmdb",
    label: "TMDB",
    description: "Titles, overviews, genres, country, language, keywords, watch providers. Also resets grid metadata and the For You suggestion graph.",
    warmUrl: "/api/admin/library-warm",
  },
  {
    id: "mdblist",
    label: "MDBList",
    description: "IMDb, Rotten Tomatoes, Audience, Metacritic, Trakt, Letterboxd ratings.",
    warmUrl: "/api/admin/mdblist-warm",
    warmBody: { force: true },
  },
  {
    id: "omdb",
    label: "OMDB",
    description: "IMDb rating fallback when MDBList has no key configured.",
    warmUrl: "/api/admin/omdb-warm",
  },
];

type WarmResult = { fetched?: number; skipped?: number; total?: number; failed?: number; purged?: number; cleared?: number; error?: string };

// A clear also resets other tables that keep copies of the same data (the grid
// metadata table and the "For You" recommendation graph), so the cache-row count
// alone would under-report what the button did.
type ClearResult = WarmResult & { coreCleared?: number; edgesCleared?: number; verdictsCleared?: number };

function summarizeClear(d: ClearResult): string {
  const parts = [`${d.cleared ?? 0} cache entries`];
  if ((d.coreCleared ?? 0) > 0) parts.push(`${d.coreCleared} metadata rows`);
  if ((d.edgesCleared ?? 0) > 0) parts.push(`${d.edgesCleared} suggestion links`);
  if ((d.verdictsCleared ?? 0) > 0) parts.push(`${d.verdictsCleared} rating verdicts`);
  return `Cleared ${parts.join(", ")}`;
}

function summarizeWarm(d: WarmResult): string {
  if (d.error) return d.error;
  const parts: string[] = [`fetched ${d.fetched ?? 0}`, `skipped ${d.skipped ?? 0}`];
  if ((d.purged ?? 0) > 0) parts.push(`purged ${d.purged}`);
  if ((d.failed ?? 0) > 0) parts.push(`failed ${d.failed}`);
  return parts.join(", ");
}

function CacheSourceRow({ source }: { source: CacheSourceDef }) {
  const [busy, setBusy] = useState<null | "clear" | "refetch">(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  // Kept in a ref so a new action cancels the previous action's timer (which
  // would otherwise wipe the newer result early) and unmount cancels it too.
  const msgTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (msgTimer.current) clearTimeout(msgTimer.current); }, []);

  async function doClear() {
    setBusy("clear");
    setConfirmClear(false);
    if (msgTimer.current) clearTimeout(msgTimer.current);
    setMsg(null);
    try {
      const res = await fetch(withBasePath(`/api/admin/clear-cache?source=${source.id}`), { method: "DELETE" });
      const data: ClearResult = await res.json().catch(() => ({}));
      if (res.ok) setMsg({ kind: "ok", text: summarizeClear(data) });
      else setMsg({ kind: "err", text: data.error ?? "Clear failed" });
    } catch {
      setMsg({ kind: "err", text: "Request failed" });
    }
    setBusy(null);
    msgTimer.current = setTimeout(() => setMsg(null), 8000);
  }

  async function doRefetch() {
    setBusy("refetch");
    if (msgTimer.current) clearTimeout(msgTimer.current);
    setMsg(null);
    try {
      const res = await fetch(withBasePath(source.warmUrl), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(source.warmBody ?? {}),
      });
      const data: WarmResult = await res.json().catch(() => ({}));
      if (res.ok && !data.error) setMsg({ kind: "ok", text: summarizeWarm(data) });
      else setMsg({ kind: "err", text: data.error ?? "Refetch failed" });
    } catch {
      setMsg({ kind: "err", text: "Request failed" });
    }
    setBusy(null);
    msgTimer.current = setTimeout(() => setMsg(null), 10000);
  }

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2.5">
      <div className="min-w-[7rem] flex-1">
        <div className="text-sm font-medium text-zinc-200">{source.label}</div>
        <div className="text-xs text-zinc-500">{source.description}</div>
      </div>

      {confirmClear ? (
        <div className="flex items-center gap-2">
          <span className="text-xs text-zinc-300">Clear {source.label}?</span>
          <Button type="button" size="sm" onClick={doClear} className="bg-red-600 text-[var(--ds-on-status)] hover:bg-[var(--ds-danger-hover)] h-8 px-3 text-xs">Clear</Button>
          <Button type="button" size="sm" variant="outline" onClick={() => setConfirmClear(false)} className="border-zinc-600 text-zinc-400 hover:text-zinc-100 h-8 px-3 text-xs">Cancel</Button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setConfirmClear(true)}
            disabled={busy !== null}
            className="border-zinc-700 text-zinc-400 hover:text-zinc-100 gap-1.5 h-8 px-3 text-xs"
          >
            {busy === "clear" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
            Clear
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={doRefetch}
            disabled={busy !== null}
            className="border-zinc-700 text-zinc-300 hover:text-zinc-100 gap-1.5 h-8 px-3 text-xs"
          >
            {busy === "refetch" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            Refetch
          </Button>
        </div>
      )}

      {msg && (
        <span role={msg.kind === "err" ? "alert" : "status"} aria-live={msg.kind === "err" ? "assertive" : "polite"} className={`text-xs w-full sm:w-auto ${msg.kind === "err" ? "text-red-400" : "text-green-400"}`}>
          {msg.text}
        </span>
      )}
    </div>
  );
}

export function CacheManagementPanel() {
  const [status, setStatus] = useState<"idle" | "running" | "done" | "error">("idle");
  const [confirmAll, setConfirmAll] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (resetTimer.current) clearTimeout(resetTimer.current); }, []);

  async function runAll() {
    if (resetTimer.current) clearTimeout(resetTimer.current);
    setStatus("running");
    setConfirmAll(false);
    setLines([]);
    const out: string[] = [];
    let anyError = false;

    // Clear every source with one request, then refetch each source in turn.
    // Each refetch route has its own cooldown; if one answers 429 (too many
    // requests) it just shows as a failed line and the rest still run.
    try {
      const clearRes = await fetch(withBasePath("/api/admin/clear-cache?source=all"), { method: "DELETE" });
      const clearData: ClearResult = await clearRes.json().catch(() => ({}));
      if (clearRes.ok) out.push(summarizeClear(clearData));
      else { anyError = true; out.push(`Clear failed: ${clearData.error ?? clearRes.status}`); }
    } catch {
      anyError = true;
      out.push("Clear failed: request error");
    }
    setLines([...out]);

    for (const source of CACHE_SOURCES) {
      try {
        const res = await fetch(withBasePath(source.warmUrl), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(source.warmBody ?? {}),
        });
        const data: WarmResult = await res.json().catch(() => ({}));
        if (res.ok && !data.error) out.push(`${source.label}: ${summarizeWarm(data)}`);
        else { anyError = true; out.push(`${source.label}: ${data.error ?? "refetch failed"}`); }
      } catch {
        anyError = true;
        out.push(`${source.label}: request failed`);
      }
      setLines([...out]);
    }

    setStatus(anyError ? "error" : "done");
    resetTimer.current = setTimeout(() => { setStatus("idle"); setLines([]); }, 15000);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Database className="w-4 h-4 text-zinc-400" />
        <h3 className="text-sm font-medium text-zinc-300">Cache Management</h3>
      </div>
      <p className="text-xs text-zinc-500 -mt-1">
        Clear and refetch each metadata source. Clearing forces fresh data on the next page visit;
        refetch warms the cache for your whole library now. After changing API keys, clear then refetch.
      </p>

      <div className="space-y-2">
        {CACHE_SOURCES.map((s) => (
          <CacheSourceRow key={s.id} source={s} />
        ))}
      </div>

      <div className="pt-3 border-t border-zinc-800 space-y-2">
        {confirmAll ? (
          <div className="flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-800/60 px-3 py-2.5 w-fit">
            <XCircle className="w-4 h-4 text-amber-400 shrink-0" />
            <p className="text-sm text-zinc-200">Clear and refetch all sources?</p>
            <Button type="button" size="sm" onClick={runAll} className="bg-amber-600 text-black hover:bg-amber-600/90 h-8 px-3 text-xs">Run</Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setConfirmAll(false)} className="border-zinc-600 text-zinc-400 hover:text-zinc-100 h-8 px-3 text-xs">Cancel</Button>
          </div>
        ) : (
          <Button
            type="button"
            variant="outline"
            onClick={() => setConfirmAll(true)}
            disabled={status === "running"}
            className="border-zinc-700 text-zinc-300 hover:text-zinc-100 gap-2"
          >
            {status === "running" ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCcw className="w-4 h-4" />}
            {status === "running" ? "Running…" : "Clear & Refetch All"}
          </Button>
        )}

        {lines.length > 0 && (
          <div className="flex flex-col gap-0.5 text-xs">
            {lines.map((l, i) => (
              <span key={i} className={status === "error" ? "text-zinc-300" : "text-zinc-400"}>{l}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
