"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { RefreshCw, XCircle } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import { runLibrarySyncs, type LibrarySyncServer } from "@/lib/client/library-sync";
import { librarySyncText } from "./library-sync-text";

export function ResyncLibraryButton({
  servers,
}: {
  /** Every CONFIGURED Plex/Jellyfin server, default and named (guardrails 35, 36). */
  servers: LibrarySyncServer[];
}) {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [status, setStatus] = useState<"idle" | "confirm" | "loading" | "done" | "error">("idle");
  const [result, setResult] = useState<string | null>(null);
  // The end-of-run reset has to be cancellable: a prior run's timer landing mid-run
  // flips "loading" back to "idle", so the spinner and counts vanish and the button
  // re-enables while the full delete-and-replace is still POSTing.
  const resetTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(resetTimer.current), []);
  // The resyncs are polled background jobs; leaving the page stops the polls.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  function scheduleReset() {
    clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => { setStatus("idle"); setResult(null); }, 10_000);
  }

  async function handleResync() {
    clearTimeout(resetTimer.current);
    setStatus("loading");
    setResult(null);
    try {
      // Only the servers that are configured: the page lists them, so an absent
      // one costs no request and can't read as a red failure (guardrail 36).
      // Every configured instance, default and named (guardrail 35) — each
      // request names its own server, so each full replace stays scoped to it
      // (guardrail 13).
      if (servers.length === 0) {
        // Not an error — nothing is misconfigured, there is simply nothing to
        // re-scan. Neutral styling says that; red would not.
        setStatus("done");
        setResult(t("adminManage.library.btn.noServers"));
        scheduleReset();
        return;
      }

      const outcomes = await runLibrarySyncs(servers, {
        url: (service) => withBasePath(`/api/sync/${service}`),
        isAlive: () => alive.current,
      });
      if (!outcomes) return;

      // Red only when a CONFIGURED server failed — that is a real fault. A
      // server with no answer yet may still be syncing and is not one. Still
      // refresh if any server did sync: those rows are what the admin clicked
      // for, and withholding the refresh left the page showing pre-sync counts.
      setStatus(outcomes.some((o) => o.outcome.kind === "failed") ? "error" : "done");
      setResult(outcomes.map((o) => librarySyncText(o.server, o.outcome, t, locale)).join(" · "));
      if (outcomes.some((o) => o.outcome.kind === "synced")) {
        const search = searchParams.toString();
        router.push(pathname + (search ? `?${search}` : ""));
      }
    } catch {
      setStatus("error");
      setResult(t("adminManage.library.btn.syncFailed"));
    }
    scheduleReset();
  }

  if (status === "confirm") {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-800/60 px-3 py-2 w-fit">
        <XCircle className="w-4 h-4 text-amber-400 shrink-0" />
        <p className="text-sm text-zinc-200">{t("adminManage.library.btn.rescanConfirm")}</p>
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
          onClick={() => setStatus("idle")}
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
        variant="outline"
        size="sm"
        onClick={() => { clearTimeout(resetTimer.current); setStatus("confirm"); }}
        disabled={status === "loading"}
        className="border-zinc-700 text-zinc-300 hover:text-zinc-100 gap-2"
      >
        <RefreshCw className={`w-4 h-4 ${status === "loading" ? "animate-spin" : ""}`} />
        {status === "loading" ? t("adminManage.library.btn.syncing") : t("adminManage.library.btn.resyncLibraries")}
      </Button>
      {result && (
        <span
          role={status === "error" ? "alert" : "status"}
          aria-live={status === "error" ? "assertive" : "polite"}
          className={`text-xs ${status === "error" ? "text-red-400" : "text-zinc-400"}`}
        >
          {result}
        </span>
      )}
    </div>
  );
}
