"use client";

import { Button } from "@/components/ui/button";
import { Tv2 } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import { runReplaceFileJob } from "@/lib/client/replace-file-job";
import { useAsyncAction } from "@/hooks/use-async-action";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import { SyncResultText, useSyncButtonState } from "./sync-button-state";
import { tvEpisodeJobOutcome } from "./tv-episode-sync-text";

// The rebuild walks every episode of every server and outlasts a reverse
// proxy's hold, so it runs as a background job polled every 3 s, for up to 20
// minutes (guardrail 37a); running out is "no answer", never a failure.
const EPISODE_POLL_MS = 3_000;
const EPISODE_MAX_POLLS = 400;

export function SyncTVEpisodesButton() {
  const t = useT();
  const locale = useLocale();
  const run = useSyncButtonState();
  const { status, result } = run;
  // Unmounting stops the polls and drops the answer (the server's rebuild
  // carries on regardless).
  const action = useAsyncAction();

  async function handleSync() {
    run.begin();
    let answer: { status: number; data: unknown } | null | undefined;
    try {
      answer = await action.run("sync", (signal) =>
        runReplaceFileJob(fetch, withBasePath("/api/sync/tv-episodes"), {}, {
          intervalMs: EPISODE_POLL_MS,
          maxPolls: EPISODE_MAX_POLLS,
          isAlive: () => !signal.aborted,
        }), { ifBusy: "skip" });
    } catch {
      // The start request itself got no answer: nothing was started.
      run.finish("error", t("adminManage.library.btn.syncFailed"), false);
      return;
    }
    if (!answer) return;
    const outcome = tvEpisodeJobOutcome(answer, t, locale);
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
