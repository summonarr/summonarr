"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { CheckCircle, Loader2, RefreshCw } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import { useT } from "@/components/i18n/i18n-provider";

export function RatingsWarmButton() {
  const t = useT();
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

      // A reply that isn't JSON (e.g. a reverse proxy's timeout page on a long
      // warm) becomes an error line for that source instead of throwing.
      const omdbData: { fetched?: number; skipped?: number; total?: number; failed?: number; error?: string } =
        await omdbRes.json().catch(() => ({ error: t("settings.form.common.requestFailedHttp", { status: omdbRes.status }) }));
      const mdblistData: MdblistWarmData =
        await mdblistRes.json().catch(() => ({ error: t("settings.form.common.requestFailedHttp", { status: mdblistRes.status }) }));

      const omdbErr    = omdbData.error;
      const mdblistErr = mdblistData.error;

      const mdblistSummary = mdblistErr
        ?? ((mdblistData.purged ?? 0) > 0
          ? t("settings.form.ratingsWarm.summaryPurged", { fetched: mdblistData.fetched ?? 0, skipped: mdblistData.skipped ?? 0, purged: mdblistData.purged ?? 0 })
          : t("settings.form.ratingsWarm.summary", { fetched: mdblistData.fetched ?? 0, skipped: mdblistData.skipped ?? 0 }));

      if (omdbErr || mdblistErr) {
        setStatus("error");
        setResults({
          omdb: omdbErr ?? t("settings.form.ratingsWarm.summary", { fetched: omdbData.fetched ?? 0, skipped: omdbData.skipped ?? 0 }),
          mdblist: mdblistSummary,
        });
      } else {
        setStatus("done");
        setResults({
          omdb: t("settings.form.ratingsWarm.summary", { fetched: omdbData.fetched ?? 0, skipped: omdbData.skipped ?? 0 }),
          mdblist: mdblistSummary,
        });
      }
    } catch {
      setStatus("error");
      setResults({ omdb: t("settings.form.common.requestFailed") });
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
        className="border-zinc-700 text-zinc-300 hover:text-zinc-100 gap-2"
      >
        {status === "loading"
          ? <><Loader2 className="w-4 h-4 animate-spin" />{t("settings.form.activityWarm.warming")}</>
          : <><RefreshCw className="w-4 h-4" />{t("settings.form.ratingsWarm.button")}</>
        }
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => runWarm(true)}
        disabled={status === "loading"}
        className="border-zinc-700 text-zinc-400 hover:text-zinc-100 gap-2"
        title={t("settings.form.ratingsWarm.fullSyncTitle")}
      >
        <RefreshCw className="w-4 h-4" />{t("settings.form.ratingsWarm.fullSync")}
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
