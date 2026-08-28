"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Database, Loader2, AlertTriangle } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";

type Phase = "idle" | "confirm" | "phase1" | "phase2" | "done" | "error";

export function MasterDbFillButton({
  plexConfigured,
  jellyfinConfigured,
}: {
  plexConfigured: boolean;
  jellyfinConfigured: boolean;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [summary, setSummary] = useState<string | null>(null);
  // The end-of-run reset has to be cancellable: a rerun started inside the 15-20s
  // window would otherwise be flipped to "idle" mid-flight — spinner and summary
  // gone, button live again — inviting a second concurrent full fill.
  const resetTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(resetTimer.current), []);

  function scheduleReset(ms: number) {
    clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => { setPhase("idle"); setSummary(null); }, ms);
  }

  async function handleFill() {
    clearTimeout(resetTimer.current);
    setPhase("phase1");
    setSummary(null);

    const libraryParts: string[] = [];
    let libraryDegraded = false;
    try {
      // Only the servers that exist. The old code POSTed to both and gated the
      // failure on `!plexRes.ok && !jellyRes.ok` — a logical AND, so BOTH had to
      // fail before anything was reported. On a two-server deployment that
      // turned a real Jellyfin outage into green text: the Jellyfin error was
      // discarded, its count fell through to 0, and `if (jellyCount > 0)` simply
      // omitted the line, so the summary read as a clean fill.
      //
      // Note this is the opposite mistake from resync-library-button, which
      // took the FIRST error and so went red whenever either server was merely
      // absent. Neither could tell "not configured" from "broken"; both now
      // decide it before the request instead of from the response.
      const targets = [
        ...(plexConfigured ? [{ name: "Plex", path: "/api/sync/plex" }] : []),
        ...(jellyfinConfigured ? [{ name: "Jellyfin", path: "/api/sync/jellyfin" }] : []),
      ];

      if (targets.length === 0) {
        setPhase("error");
        setSummary("No media servers configured — set up Plex or Jellyfin first");
        scheduleReset(15_000);
        return;
      }

      const outcomes = await Promise.all(
        targets.map(async ({ name, path }) => {
          try {
            const res = await fetch(withBasePath(path), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ full: true }),
            });
            // .catch on the parse: a reverse proxy erroring mid-response sends
            // HTML, and a bare .json() would throw past the per-target guard
            // into the outer catch, losing the other server's result too.
            const data = (await res.json().catch(() => null)) as
              | { scanned?: { movies: number; tv: number }; error?: string }
              | null;
            if (!res.ok || data?.error) {
              return { ok: false, text: `${name} ${data?.error ?? `failed (${res.status})`}` };
            }
            const count = (data?.scanned?.movies ?? 0) + (data?.scanned?.tv ?? 0);
            return { ok: true, text: `${name} ${count.toLocaleString("en-US")} items` };
          } catch {
            return { ok: false, text: `${name} network error` };
          }
        }),
      );

      // Every configured server failed ⇒ there is no library to warm from, so
      // stop rather than running phase 2 over nothing and calling it a success.
      if (!outcomes.some((o) => o.ok)) {
        setPhase("error");
        setSummary(`Library sync failed — ${outcomes.map((o) => o.text).join(" · ")}`);
        scheduleReset(15_000);
        return;
      }
      // A partial failure carries on to the TMDB warm — the server that did
      // sync has real rows worth warming — but its text rides along in the
      // summary so it cannot be mistaken for a clean run.
      libraryParts.push(...outcomes.map((o) => o.text));
      libraryDegraded = outcomes.some((o) => !o.ok);
    } catch {
      setPhase("error");
      setSummary("Library sync failed — check server logs");
      scheduleReset(15_000);
      return;
    }

    setPhase("phase2");
    try {
      const warmRes = await fetch(withBasePath("/api/admin/library-warm"), { method: "POST" });
      const warmData = await warmRes.json() as { fetched?: number; backfilled?: number; skipped?: number; error?: string };
      if (warmData.error) {
        setPhase("error");
        setSummary(warmData.error);
        scheduleReset(15_000);
        return;
      }
      // Every configured server is named, including one that scanned 0 items —
      // the old `if (count > 0)` guard silently omitted such a line, which is
      // exactly how a failed server disappeared from the summary.
      const parts: string[] = [...libraryParts];
      const fetched    = warmData.fetched    ?? 0;
      const backfilled = warmData.backfilled ?? 0;
      const skipped    = warmData.skipped    ?? 0;
      const tmdbParts: string[] = [];
      if (fetched    > 0) tmdbParts.push(`${fetched.toLocaleString("en-US")} fetched`);
      if (backfilled > 0) tmdbParts.push(`${backfilled.toLocaleString("en-US")} backfilled`);
      if (skipped    > 0) tmdbParts.push(`${skipped.toLocaleString("en-US")} already cached`);
      parts.push(`TMDB: ${tmdbParts.join(", ") || "0 items"}`);
      // A summary that names a failed server must not render green — the two
      // together read as "this worked" over the top of "this did not".
      setPhase(libraryDegraded ? "error" : "done");
      setSummary(parts.join(" · "));
    } catch {
      setPhase("error");
      setSummary("TMDB warm failed — check server logs");
    }
    scheduleReset(20_000);
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
          onClick={() => { clearTimeout(resetTimer.current); setPhase("confirm"); }}
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
        <p className="text-xs text-zinc-500">
          Full library scan + TMDB metadata seed. One-time operation for new installs.
        </p>
      )}
    </div>
  );
}
