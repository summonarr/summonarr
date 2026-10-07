"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Loader2, AlertTriangle, Send } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import { useT } from "@/components/i18n/i18n-provider";

export function AnnounceUpdateButton() {
  const t = useT();
  const [phase, setPhase] = useState<"idle" | "confirm" | "sending" | "done" | "error">("idle");
  const [summary, setSummary] = useState<string | null>(null);
  // Timer that clears the result 10s after a send. Kept in a ref so it can be
  // cancelled — otherwise an old timer could close a confirm box the admin
  // opened again within those 10 seconds.
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (resetTimer.current) clearTimeout(resetTimer.current); }, []);

  function openConfirm() {
    if (resetTimer.current) clearTimeout(resetTimer.current);
    setSummary(null);
    setPhase("confirm");
  }

  async function handleSend() {
    if (resetTimer.current) clearTimeout(resetTimer.current);
    setPhase("sending");
    setSummary(null);
    try {
      const res = await fetch(withBasePath("/api/push/announce-update"), { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; sent?: number; failed?: number; error?: string };
      if (res.ok && data.ok) {
        setPhase("done");
        const sent = data.sent ?? 0;
        const failed = data.failed ?? 0;
        // One key carries both numbers so a translation can reorder the two
        // clauses and pick its own joiner; the plural form follows `sent`.
        setSummary(failed > 0
          ? t("settings.form.announce.sentWithFailures", { count: sent, sent, failed })
          : t("settings.form.announce.sent", { count: sent }));
      } else {
        setPhase("error");
        setSummary(typeof data.error === "string" ? data.error : t("settings.form.announce.sendFailed"));
      }
    } catch {
      setPhase("error");
      setSummary(t("settings.form.announce.sendFailed"));
    }
    resetTimer.current = setTimeout(() => { setPhase("idle"); setSummary(null); }, 10_000);
  }

  if (phase === "confirm") {
    return (
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 space-y-3">
        <div className="flex items-start gap-2.5">
          <AlertTriangle className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
          <div className="space-y-1.5">
            <p className="text-sm font-medium text-zinc-100">
              {t("settings.form.announce.confirmTitle")}
            </p>
            <p className="text-xs text-zinc-400">
              {t("settings.form.announce.confirmHelp")}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={handleSend}
            className="bg-amber-600 text-black hover:bg-amber-600/90 h-7 px-4 text-xs"
          >
            {t("settings.form.announce.confirmSend")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setPhase("idle")}
            className="border-zinc-600 text-zinc-400 hover:text-zinc-100 h-7 px-3 text-xs"
          >
            {t("settings.form.common.cancel")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-3 flex-wrap">
        <Button
          type="button"
          variant="outline"
          onClick={openConfirm}
          disabled={phase === "sending"}
          className="border-zinc-700 text-zinc-300 hover:text-zinc-100 gap-2"
        >
          {phase === "sending" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          {phase === "sending" ? t("settings.form.common.sending") : t("settings.form.announce.button")}
        </Button>
        {summary && (
          <span role={phase === "error" ? "alert" : "status"} aria-live={phase === "error" ? "assertive" : "polite"} className={`text-xs ${phase === "error" ? "text-red-400" : "text-green-400"}`}>
            {summary}
          </span>
        )}
      </div>
      {phase === "idle" && (
        <p className="text-xs text-zinc-500">
          {t("settings.form.announce.help")}
        </p>
      )}
    </div>
  );
}
