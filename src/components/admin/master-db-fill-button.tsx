"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Database, Loader2, AlertTriangle } from "lucide-react";

type Phase = "idle" | "confirm" | "phase1" | "phase2" | "done" | "error";

export function MasterDbFillButton() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [summary, setSummary] = useState<string | null>(null);

  async function handleFill() {
    setPhase("phase1");
    setSummary(null);

    let plexCount = 0;
    let jellyCount = 0;
    try {
      const [plexRes, jellyRes] = await Promise.all([
        fetch("/api/sync/plex", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ full: true }),
        }),
        fetch("/api/sync/jellyfin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ full: true }),
        }),
      ]);
      const plexData = await plexRes.json() as { scanned?: { movies: number; tv: number }; error?: string };
      const jellyData = await jellyRes.json() as { scanned?: { movies: number; tv: number }; error?: string };

      if (!plexRes.ok && !jellyRes.ok) {
        setPhase("error");
        setSummary(`Library sync failed — ${plexData.error ?? "Plex error"} · ${jellyData.error ?? "Jellyfin error"}`);
        setTimeout(() => { setPhase("idle"); setSummary(null); }, 15_000);
        return;
      }

      plexCount = (plexData.scanned?.movies ?? 0) + (plexData.scanned?.tv ?? 0);
      jellyCount = (jellyData.scanned?.movies ?? 0) + (jellyData.scanned?.tv ?? 0);
    } catch {
      setPhase("error");
      setSummary("Library sync failed — check server logs");
      setTimeout(() => { setPhase("idle"); setSummary(null); }, 15_000);
      return;
    }

    setPhase("phase2");
    try {
      const warmRes = await fetch("/api/admin/library-warm", { method: "POST" });
      const warmData = await warmRes.json() as { fetched?: number; backfilled?: number; skipped?: number; error?: string };
      if (warmData.error) {
        setPhase("error");
        setSummary(warmData.error);
        setTimeout(() => { setPhase("idle"); setSummary(null); }, 15_000);
        return;
      }
      const parts: string[] = [];
      if (plexCount > 0) parts.push(`Plex ${plexCount.toLocaleString()} items`);
      if (jellyCount > 0) parts.push(`Jellyfin ${jellyCount.toLocaleString()} items`);
      const fetched    = warmData.fetched    ?? 0;
      const backfilled = warmData.backfilled ?? 0;
      const skipped    = warmData.skipped    ?? 0;
      const tmdbParts: string[] = [];
      if (fetched    > 0) tmdbParts.push(`${fetched.toLocaleString()} fetched`);
      if (backfilled > 0) tmdbParts.push(`${backfilled.toLocaleString()} backfilled`);
      if (skipped    > 0) tmdbParts.push(`${skipped.toLocaleString()} already cached`);
      parts.push(`TMDB: ${tmdbParts.join(", ") || "0 items"}`);
      setPhase("done");
      setSummary(parts.join(" · "));
    } catch {
      setPhase("error");
      setSummary("TMDB warm failed — check server logs");
    }
    setTimeout(() => { setPhase("idle"); setSummary(null); }, 20_000);
  }

  if (phase === "confirm") {
    return (
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 space-y-3">
        <div className="flex items-start gap-2.5">
          <AlertTriangle className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
          <div className="space-y-1.5">
            <p className="text-sm font-medium text-zinc-100">
              This will re-scan your entire Plex and Jellyfin libraries, then fetch TMDB metadata for every item.
            </p>
            <ul className="text-xs text-zinc-400 space-y-0.5 list-disc list-inside">
              <li>Phase 1 — full library scan (fills contentRating, addedAt, communityRating)</li>
              <li>Phase 2 — TMDB metadata warm (populates TmdbMediaCore table)</li>
            </ul>
            <p className="text-xs text-amber-400/80">
              Large libraries may take several minutes. Intended for initial setup — routine syncs handle this automatically going forward.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={handleFill}
            className="bg-amber-600 hover:bg-amber-500 h-7 px-4 text-xs"
          >
            Run Full Fill
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setPhase("idle")}
            className="border-zinc-600 text-zinc-400 hover:text-white h-7 px-3 text-xs"
          >
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  const loading = phase === "phase1" || phase === "phase2";
  const phaseLabel =
    phase === "phase1" ? "Syncing libraries (1/2)…" :
    phase === "phase2" ? "Warming TMDB cache (2/2)…" :
    null;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-3 flex-wrap">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setPhase("confirm")}
          disabled={loading}
          className="border-zinc-700 text-zinc-300 hover:text-white gap-2"
        >
          {loading
            ? <Loader2 className="w-4 h-4 animate-spin" />
            : <Database className="w-4 h-4" />}
          {phaseLabel ?? "Initial DB Fill"}
        </Button>
        {summary && (
          <span className={`text-xs ${phase === "error" ? "text-red-400" : "text-green-400"}`}>
            {summary}
          </span>
        )}
      </div>
      {phase === "idle" && (
        <p className="text-xs text-zinc-600">
          Full library scan + TMDB metadata seed. One-time operation for new installs.
        </p>
      )}
    </div>
  );
}
