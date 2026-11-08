"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Loader2, AlertTriangle, Send } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import { fetchJson } from "@/lib/client/fetch-json";
import { v } from "@/lib/validate";
import { useDelayed } from "@/hooks/use-delayed";
import { useFocusReturn } from "@/hooks/use-focus-return";
import { useT } from "@/components/i18n/i18n-provider";

const SentAnswer = v.object({ ok: v.literal(true), sent: v.optional(v.number()), failed: v.optional(v.number()) });

// The send fans out to every registered device before it answers.
const SEND_TIMEOUT_MS = 5 * 60_000;

export function AnnounceUpdateButton() {
  const t = useT();
  const id = useId();
  const [phase, setPhase] = useState<"idle" | "confirm" | "sending" | "done" | "error">("idle");
  const [summary, setSummary] = useState<string | null>(null);
  // Clears the result 10s after a send. A new confirm cancels it — otherwise
  // an old timer could close a confirm box the admin opened again within those
  // 10 seconds — and nothing fires after unmount.
  const later = useDelayed();
  // The confirm panel replaces the trigger, so focus moves into it and back to
  // the trigger when it closes, never to <body>.
  const focus = useFocusReturn();

  function openConfirm() {
    later.cancel();
    setSummary(null);
    setPhase("confirm");
  }

  function cancel() {
    focus.returnTo("trigger");
    setPhase("idle");
  }

  async function handleSend() {
    later.cancel();
    setPhase("sending");
    setSummary(null);
    const res = await fetchJson(withBasePath("/api/push/announce-update"), {
      init: { method: "POST" },
      schema: SentAnswer,
      timeoutMs: SEND_TIMEOUT_MS,
      fallbackError: t("settings.form.announce.sendFailed"),
    });
    // The trigger was disabled while sending, so focus fell to <body>.
    focus.returnToIfLost("trigger");
    if (res.ok) {
      setPhase("done");
      const sent = res.data.sent ?? 0;
      const failed = res.data.failed ?? 0;
      // One key carries both numbers so a translation can reorder the two
      // clauses and pick its own joiner; the plural form follows `sent`.
      setSummary(failed > 0
        ? t("settings.form.announce.sentWithFailures", { count: sent, sent, failed })
        : t("settings.form.announce.sent", { count: sent }));
    } else {
      setPhase("error");
      setSummary(res.error || t("settings.form.announce.sendFailed"));
    }
    later(() => { setPhase("idle"); setSummary(null); }, 10_000);
  }

  if (phase === "confirm") {
    return (
      <div
        role="alertdialog"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-help`}
        className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 space-y-3"
        onKeyDown={(e) => {
          if (e.key === "Escape") cancel();
        }}
      >
        <div className="flex items-start gap-2.5">
          <AlertTriangle className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
          <div className="space-y-1.5">
            <p id={`${id}-title`} className="text-sm font-medium text-zinc-100">
              {t("settings.form.announce.confirmTitle")}
            </p>
            <p id={`${id}-help`} className="text-xs text-zinc-400">
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
          {/* Focus lands on Cancel, not Send: the send can't be recalled, so a
              stray Enter must not fire it. */}
          <Button
            size="sm"
            variant="outline"
            autoFocus
            onClick={cancel}
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
          ref={focus.refFor("trigger")}
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
