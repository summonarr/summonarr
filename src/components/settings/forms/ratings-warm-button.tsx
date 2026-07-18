"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { CheckCircle, Loader2, RefreshCw } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";

export function RatingsWarmButton() {
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [results, setResults] = useState<{ omdb?: string; mdblist?: string } | null>(null);

  type MdblistWarmData = { fetched?: number; skipped?: number; total?: number; failed?: number; purged?: number; error?: string };

  async function runWarm(force: boolean) {
    setStatus("loading");
    setResults(null);
    try {
      const [omdbRes, mdblistRes] = await Promise.all([
        fetch(withBasePath("/api/admin/omdb-warm"), { method: "POST" }),
        fetch(withBasePath("/api/admin/mdblist-warm"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ force }),
        }),
      ]);

      const omdbData: { fetched?: number; skipped?: number; total?: number; failed?: number; error?: string } = await omdbRes.json();
      const mdblistData: MdblistWarmData = await mdblistRes.json();

      const omdbErr    = omdbData.error;
      const mdblistErr = mdblistData.error;

      const mdblistSummary = mdblistErr
        ?? `Fetched ${mdblistData.fetched ?? 0}, skipped ${mdblistData.skipped ?? 0}${(mdblistData.purged ?? 0) > 0 ? `, purged ${mdblistData.purged}` : ""}`;

      if (omdbErr || mdblistErr) {
        setStatus("error");
        setResults({
          omdb: omdbErr ?? `Fetched ${omdbData.fetched ?? 0}, skipped ${omdbData.skipped ?? 0}`,
          mdblist: mdblistSummary,
        });
      } else {
        setStatus("done");
        setResults({
          omdb: `Fetched ${omdbData.fetched ?? 0}, skipped ${omdbData.skipped ?? 0}`,
          mdblist: mdblistSummary,
        });
      }
    } catch {
      setStatus("error");
      setResults({ omdb: "Request failed" });
    }
    setTimeout(() => setStatus("idle"), 10000);
  }

  return (
    <div className="flex items-center gap-3 flex-wrap">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => runWarm(false)}
        disabled={status === "loading"}
        className="border-zinc-700 text-zinc-300 hover:text-white gap-2"
      >
        {status === "loading"
          ? <><Loader2 className="w-4 h-4 animate-spin" />Warming…</>
          : <><RefreshCw className="w-4 h-4" />Warm Ratings</>
        }
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => runWarm(true)}
        disabled={status === "loading"}
        className="border-zinc-700 text-zinc-400 hover:text-white gap-2"
        title="Purge all MDBList sentinels and re-fetch the entire library"
      >
        <RefreshCw className="w-4 h-4" />Full Sync
      </Button>
      {results && (
        <div role={status === "error" ? "alert" : "status"} aria-live={status === "error" ? "assertive" : "polite"} className={`text-xs ${status === "error" ? "text-red-400" : "text-zinc-400"}`}>
          <div>OMDB: {results.omdb}</div>
          <div>MDBList: {results.mdblist}</div>
        </div>
      )}
      {status === "done" && (
        <CheckCircle className="w-4 h-4 text-green-400" />
      )}
    </div>
  );
}
