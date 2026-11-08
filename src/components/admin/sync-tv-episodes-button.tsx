"use client";

import { Button } from "@/components/ui/button";
import { Tv2 } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import { fetchJson } from "@/lib/client/fetch-json";
import { useAsyncAction } from "@/hooks/use-async-action";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import { SyncResultText, useSyncButtonState } from "./sync-button-state";
import { TV_EPISODE_SYNC_ANSWER, tvEpisodeSyncOutcome } from "./tv-episode-sync-text";

export function SyncTVEpisodesButton() {
  const t = useT();
  const locale = useLocale();
  const run = useSyncButtonState();
  const { status, result } = run;
  // Unmounting aborts the request and drops its answer (the server's rebuild
  // carries on regardless).
  const action = useAsyncAction();

  async function handleSync() {
    run.begin();
    // The rebuild walks every episode of every server synchronously (the route
    // allows 5 minutes), so no client timeout: one would call a slow success a
    // failure while the server still finishes.
    const res = await action.run("sync", (signal) =>
      fetchJson(withBasePath("/api/sync/tv-episodes"), {
        init: { method: "POST", headers: { "Content-Type": "application/json" } },
        schema: TV_EPISODE_SYNC_ANSWER,
        timeoutMs: Infinity,
        signal,
      }), { ifBusy: "skip" });
    if (!res) return;
    const outcome = tvEpisodeSyncOutcome(res, t, locale);
    if (!outcome) return;
    // Refresh whenever a cache was rewritten — the page's counts read it.
    run.finish(outcome.status, outcome.text, outcome.refresh);
  }

  return (
    <div className="flex items-center gap-3">
      <Button
        variant="outline"
        size="sm"
        onClick={handleSync}
        disabled={status === "loading"}
        className="border-zinc-700 text-zinc-300 hover:text-zinc-100 gap-2"
      >
        <Tv2 className={`w-4 h-4 ${status === "loading" ? "animate-pulse" : ""}`} />
        {status === "loading" ? t("adminManage.library.btn.syncingEpisodes") : t("adminManage.library.btn.syncEpisodes")}
      </Button>
      <SyncResultText status={status} result={result} />
    </div>
  );
}
