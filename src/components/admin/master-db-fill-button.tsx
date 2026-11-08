"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Database, Loader2, AlertTriangle } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import { runLibrarySyncs, type LibrarySyncServer } from "@/lib/client/library-sync";
import { runReplaceFileJob } from "@/lib/client/replace-file-job";
import { librarySyncText } from "./library-sync-text";
import {
  fillLibraryFailedEnd,
  fillLibraryStep,
  fillResetDelayMs,
  fillWarmEnd,
  fillWarmThrewEnd,
  type FillEnd,
  type FillLibraryStep,
} from "./master-db-fill";

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
  // The last run's line and how it ended: its colour follows the run, not the
  // button — a failure stays (red) while the admin opens and cancels the confirm.
  const [summary, setSummary] = useState<FillEnd | null>(null);
  // The end-of-run reset has to be cancellable: a rerun started inside the 20s
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

  // The confirm replaces the focused button: focus moves to its Cancel (the
  // safe choice beside a full fill) and back to the button when the confirm
  // closes — at once on Cancel, once the fill has answered on Run.
  const triggerRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  useEffect(() => {
    if (phase === "confirm") cancelRef.current?.focus();
    else if (refocus.current && phase !== "phase1" && phase !== "phase2") {
      refocus.current = false;
      triggerRef.current?.focus();
    }
  }, [phase]);

  function scheduleReset(ms: number) {
    clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => { setPhase("idle"); setSummary(null); }, ms);
  }

  // Every way a run ends lands here once: its line, its colour, and whether
  // the line clears itself (fillResetDelayMs — a failure stays).
  function finish(end: FillEnd) {
    setPhase(end.phase);
    setSummary(end);
    const delay = fillResetDelayMs(end.phase);
    if (delay !== null) scheduleReset(delay);
  }

  // Phase 1 (every configured server's full resync), then phase 2 (the TMDB
  // warm); null when the button unmounted mid-run.
  async function runFill(): Promise<FillEnd | null> {
    // Only the servers that are configured (the page lists them). Deciding
    // this up front tells "not set up" apart from "broken": an unconfigured
    // server is skipped, while a configured one that fails is always
    // reported (guardrail 36). Every configured instance, default and named.
    if (servers.length === 0) return { phase: "error", summary: t("adminManage.library.fill.noServers") };

    let step: FillLibraryStep;
    try {
      const outcomes = await runLibrarySyncs(servers, {
        url: (service) => withBasePath(`/api/sync/${service}`),
        isAlive: () => alive.current,
      });
      if (!outcomes) return null;
      step = fillLibraryStep(outcomes.map((o) => ({ outcome: o.outcome, text: librarySyncText(o.server, o.outcome, t, locale) })));
    } catch {
      return { phase: "error", summary: t("adminManage.library.fill.libraryFailed") };
    }
    // Every configured server FAILED ⇒ there is no library to warm from, so
    // stop rather than running phase 2 over nothing and calling it a success.
    // A server with no answer yet may still be syncing, so it doesn't stop it.
    // A partial failure carries on to the TMDB warm — the server that did sync
    // has real rows worth warming — and its text rides along in the summary.
    if (step.allFailed) return fillLibraryFailedEnd(step, t);

    setPhase("phase2");
    let warm: Awaited<ReturnType<typeof runReplaceFileJob>>;
    try {
      // A background job too: a cold warm of a large library outlasts a
      // reverse proxy's hold (guardrail 37a).
      warm = await runReplaceFileJob(fetch, withBasePath("/api/admin/library-warm"), {}, {
        intervalMs: WARM_POLL_MS,
        maxPolls: WARM_MAX_POLLS,
        isAlive: () => alive.current,
      });
    } catch {
      return fillWarmThrewEnd(step, t);
    }
    if (!warm) return null;
    return fillWarmEnd(step, warm, t, locale);
  }

  async function handleFill() {
    clearTimeout(resetTimer.current);
    refocus.current = true;
    setPhase("phase1");
    setSummary(null);
    const end = await runFill();
    if (end) finish(end);
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
            ref={cancelRef}
            size="sm"
            variant="outline"
            onClick={() => { refocus.current = true; setPhase("idle"); }}
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
          ref={triggerRef}
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
            role={summary.phase === "error" ? "alert" : "status"}
            aria-live={summary.phase === "error" ? "assertive" : "polite"}
            className={`text-xs ${summary.phase === "error" ? "text-red-400" : summary.phase === "pending" ? "text-zinc-400" : "text-green-400"}`}
          >
            {summary.summary}
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
