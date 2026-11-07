"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Database, Loader2, AlertTriangle } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import { isNoAnswer, jobAnswerError, runLibrarySyncs, type LibrarySyncServer } from "@/lib/client/library-sync";
import { runReplaceFileJob } from "@/lib/client/replace-file-job";
import { librarySyncText } from "./library-sync-text";

// "pending": nothing failed, but a step has not answered yet and may still be
// running on the server — never shown as a failure.
type Phase = "idle" | "confirm" | "phase1" | "phase2" | "done" | "pending" | "error";

// The warm is polled every 3 s for up to 30 minutes (a cold large library);
// running out is "no answer", never a failure.
const WARM_POLL_MS = 3_000;
const WARM_MAX_POLLS = 600;

export function MasterDbFillButton({
  servers,
}: {
  /** Every CONFIGURED Plex/Jellyfin server, default and named (guardrails 35, 36). */
  servers: LibrarySyncServer[];
}) {
  const t = useT();
  const locale = useLocale();
  const [phase, setPhase] = useState<Phase>("idle");
  const [summary, setSummary] = useState<string | null>(null);
  // The end-of-run reset has to be cancellable: a rerun started inside the 15-20s
  // window would otherwise be flipped to "idle" mid-flight — spinner and summary
  // gone, button live again — inviting a second concurrent full fill.
  const resetTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(resetTimer.current), []);
  // Both phases are polled background jobs; leaving the page stops the polls.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

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
    let libraryPending = false;
    try {
      // Only the servers that are configured (the page lists them). Deciding
      // this up front tells "not set up" apart from "broken": an unconfigured
      // server is skipped, while a configured one that fails is always
      // reported (guardrail 36). Every configured instance, default and named.
      if (servers.length === 0) {
        setPhase("error");
        setSummary(t("adminManage.library.fill.noServers"));
        scheduleReset(15_000);
        return;
      }

      const outcomes = await runLibrarySyncs(servers, {
        url: (service) => withBasePath(`/api/sync/${service}`),
        isAlive: () => alive.current,
      });
      if (!outcomes) return;
      const texts = outcomes.map((o) => librarySyncText(o.server, o.outcome, t, locale));

      // Every configured server FAILED ⇒ there is no library to warm from, so
      // stop rather than running phase 2 over nothing and calling it a success.
      // A server with no answer yet may still be syncing, so it doesn't stop it.
      if (outcomes.every((o) => o.outcome.kind === "failed")) {
        setPhase("error");
        setSummary(t("adminManage.library.fill.libraryFailedWith", { detail: texts.join(" · ") }));
        scheduleReset(15_000);
        return;
      }
      // A partial failure carries on to the TMDB warm — the server that did
      // sync has real rows worth warming — but its text rides along in the
      // summary so it cannot be mistaken for a clean run.
      libraryParts.push(...texts);
      libraryDegraded = outcomes.some((o) => o.outcome.kind === "failed");
      libraryPending = outcomes.some((o) => o.outcome.kind === "noAnswer");
    } catch {
      setPhase("error");
      setSummary(t("adminManage.library.fill.libraryFailed"));
      scheduleReset(15_000);
      return;
    }

    setPhase("phase2");
    try {
      // A background job too: a cold warm of a large library outlasts a
      // reverse proxy's hold (guardrail 37a).
      const warm = await runReplaceFileJob(fetch, withBasePath("/api/admin/library-warm"), {}, {
        intervalMs: WARM_POLL_MS,
        maxPolls: WARM_MAX_POLLS,
        isAlive: () => alive.current,
      });
      if (!warm) return;
      // Name every configured server, even one that scanned 0 items, so a
      // failed server can never silently drop out of the summary.
      const parts: string[] = [...libraryParts];
      if (isNoAnswer(warm)) {
        // No answer is not a failure: the warm may still be running.
        parts.push(t("adminManage.library.fill.warmNoAnswer"));
        setPhase(libraryDegraded ? "error" : "pending");
        setSummary(parts.join(" · "));
        scheduleReset(20_000);
        return;
      }
      const warmError = jobAnswerError(warm);
      if (warm.status < 200 || warm.status >= 300 || warmError) {
        setPhase("error");
        setSummary(warmError ?? t("adminManage.library.fill.warmFailedStatus", { status: warm.status }));
        scheduleReset(15_000);
        return;
      }
      const warmData = (warm.data ?? {}) as { fetched?: number; backfilled?: number; skipped?: number; failed?: number };
      const fetched    = warmData.fetched    ?? 0;
      const backfilled = warmData.backfilled ?? 0;
      const skipped    = warmData.skipped    ?? 0;
      const failed     = warmData.failed     ?? 0;
      const tmdbParts: string[] = [];
      if (fetched    > 0) tmdbParts.push(t("adminManage.library.fill.fetched", { value: fetched.toLocaleString(locale) }));
      if (backfilled > 0) tmdbParts.push(t("adminManage.library.fill.backfilled", { value: backfilled.toLocaleString(locale) }));
      if (skipped    > 0) tmdbParts.push(t("adminManage.library.fill.cached", { value: skipped.toLocaleString(locale) }));
      if (failed     > 0) tmdbParts.push(t("adminManage.library.fill.failed", { value: failed.toLocaleString(locale) }));
      parts.push(`TMDB: ${tmdbParts.join(", ") || t("adminManage.library.btn.items", { count: 0, formatted: "0" })}`);
      // A summary that names a failed server or failed TMDB items must not
      // render green — the two together read as "this worked" over the top of
      // "this did not". A server with no answer yet isn't green either.
      setPhase(libraryDegraded || failed > 0 ? "error" : libraryPending ? "pending" : "done");
      setSummary(parts.join(" · "));
    } catch {
      setPhase("error");
      setSummary(t("adminManage.library.fill.warmFailed"));
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
              {t("adminManage.library.fill.confirmTitle")}
            </p>
            <ul className="text-xs text-zinc-400 space-y-0.5 list-disc list-inside">
              <li>{t("adminManage.library.fill.phase1Desc")}</li>
              <li>{t("adminManage.library.fill.phase2Desc")}</li>
            </ul>
            <p className="text-xs text-amber-400">
              {t("adminManage.library.fill.confirmNote")}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={handleFill}
            className="bg-amber-600 text-black hover:bg-amber-600/90 h-7 px-4 text-xs"
          >
            {t("adminManage.library.fill.run")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setPhase("idle")}
            className="border-zinc-600 text-zinc-400 hover:text-zinc-100 h-7 px-3 text-xs"
          >
            {t("adminManage.common.cancel")}
          </Button>
        </div>
      </div>
    );
  }

  const loading = phase === "phase1" || phase === "phase2";
  const phaseLabel =
    phase === "phase1" ? t("adminManage.library.fill.phase1") :
    phase === "phase2" ? t("adminManage.library.fill.phase2") :
    null;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-3 flex-wrap">
        <Button
          variant="outline"
          size="sm"
          onClick={() => { clearTimeout(resetTimer.current); setPhase("confirm"); }}
          disabled={loading}
          className="border-zinc-700 text-zinc-300 hover:text-zinc-100 gap-2"
        >
          {loading
            ? <Loader2 className="w-4 h-4 animate-spin" />
            : <Database className="w-4 h-4" />}
          {phaseLabel ?? t("adminManage.library.fill.button")}
        </Button>
        {summary && (
          <span
            role={phase === "error" ? "alert" : "status"}
            aria-live={phase === "error" ? "assertive" : "polite"}
            className={`text-xs ${phase === "error" ? "text-red-400" : phase === "pending" ? "text-zinc-400" : "text-green-400"}`}
          >
            {summary}
          </span>
        )}
      </div>
      {phase === "idle" && (
        <p className="text-xs text-zinc-500">
          {t("adminManage.library.fill.hint")}
        </p>
      )}
    </div>
  );
}
