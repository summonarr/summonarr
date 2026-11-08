"use client";

import { useId } from "react";
import { Button } from "@/components/ui/button";
import { RefreshCw, XCircle } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import { runLibrarySyncs, type LibrarySyncServer } from "@/lib/client/library-sync";
import { useFocusReturn } from "@/hooks/use-focus-return";
import { librarySyncText } from "./library-sync-text";
import { SyncResultText, useSyncButtonState } from "./sync-button-state";

export function ResyncLibraryButton({
  servers,
}: {
  /** Every CONFIGURED Plex/Jellyfin server, default and named (guardrails 35, 36). */
  servers: LibrarySyncServer[];
}) {
  const t = useT();
  const locale = useLocale();
  // The resyncs are polled background jobs; leaving the page stops the polls
  // (isAlive) and the run's end applies nothing (sync-button-state.tsx).
  const run = useSyncButtonState();
  const { status, result } = run;
  const focus = useFocusReturn();
  const promptId = useId();

  // The trigger is disabled while the run goes; at its end focus returns to it
  // if the confirm's unmounting left it on <body>.
  function finish(next: "done" | "error", text: string, refresh: boolean) {
    focus.returnToIfLost("trigger");
    run.finish(next, text, refresh);
  }

  async function handleResync() {
    run.begin();
    // Only the servers that are configured: the page lists them, so an absent
    // one costs no request and can't read as a red failure (guardrail 36).
    // Every configured instance, default and named (guardrail 35) — each
    // request names its own server, so each full replace stays scoped to it
    // (guardrail 13).
    if (servers.length === 0) {
      // Not an error — nothing is misconfigured, there is simply nothing to
      // re-scan. Neutral styling says that; red would not.
      finish("done", t("adminManage.library.btn.noServers"), false);
      return;
    }
    try {
      const outcomes = await runLibrarySyncs(servers, {
        url: (service) => withBasePath(`/api/sync/${service}`),
        isAlive: run.isAlive,
      });
      if (!outcomes) return;
      // Red only when a CONFIGURED server failed — that is a real fault. A
      // server with no answer yet may still be syncing and is not one. Still
      // refresh if any server did sync: those rows are what the admin clicked
      // for, and withholding the refresh left the page showing pre-sync counts.
      finish(
        outcomes.some((o) => o.outcome.kind === "failed") ? "error" : "done",
        outcomes.map((o) => librarySyncText(o.server, o.outcome, t, locale)).join(" · "),
        outcomes.some((o) => o.outcome.kind === "synced"),
      );
    } catch {
      finish("error", t("adminManage.library.btn.syncFailed"), false);
    }
  }

  if (status === "confirm") {
    // Focus moves into the prompt (onto Cancel, the safe answer) so a keyboard
    // user keeps their place and hears the question; Cancel hands it back.
    return (
      <div
        role="group"
        aria-labelledby={promptId}
        className="flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-800/60 px-3 py-2 w-fit"
      >
        <XCircle className="w-4 h-4 text-amber-400 shrink-0" />
        <p id={promptId} className="text-sm text-zinc-200">{t("adminManage.library.btn.rescanConfirm")}</p>
        <Button
          size="sm"
          onClick={handleResync}
          className="bg-amber-600 text-black hover:bg-amber-600/90 h-7 px-3 text-xs"
        >
          {t("adminManage.library.btn.resync")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          autoFocus
          onClick={() => {
            focus.returnTo("trigger");
            run.cancel();
          }}
          className="border-zinc-600 text-zinc-400 hover:text-zinc-100 h-7 px-3 text-xs"
        >
          {t("adminManage.common.cancel")}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3">
      <Button
        ref={focus.refFor("trigger")}
        variant="outline"
        size="sm"
        onClick={run.confirm}
        disabled={status === "loading"}
        className="border-zinc-700 text-zinc-300 hover:text-zinc-100 gap-2"
      >
        <RefreshCw className={`w-4 h-4 ${status === "loading" ? "animate-spin" : ""}`} />
        {status === "loading" ? t("adminManage.library.btn.syncing") : t("adminManage.library.btn.resyncLibraries")}
      </Button>
      <SyncResultText status={status} result={result} />
    </div>
  );
}
