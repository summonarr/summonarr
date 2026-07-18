"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Loader2, AlertTriangle, Send } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";

export function AnnounceUpdateButton() {
  const [phase, setPhase] = useState<"idle" | "confirm" | "sending" | "done" | "error">("idle");
  const [summary, setSummary] = useState<string | null>(null);

  async function handleSend() {
    setPhase("sending");
    setSummary(null);
    try {
      const res = await fetch(withBasePath("/api/push/announce-update"), { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; sent?: number; failed?: number; error?: string };
      if (res.ok && data.ok) {
        setPhase("done");
        const sent = data.sent ?? 0;
        const failed = data.failed ?? 0;
        setSummary(`Sent to ${sent} device${sent === 1 ? "" : "s"}${failed > 0 ? `, ${failed} failed` : ""}`);
      } else {
        setPhase("error");
        setSummary(typeof data.error === "string" ? data.error : "Failed to send update notice");
      }
    } catch {
      setPhase("error");
      setSummary("Failed to send update notice");
    }
    setTimeout(() => { setPhase("idle"); setSummary(null); }, 10_000);
  }

  if (phase === "confirm") {
    return (
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 space-y-3">
        <div className="flex items-start gap-2.5">
          <AlertTriangle className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
          <div className="space-y-1.5">
            <p className="text-sm font-medium text-zinc-100">
              Send an &quot;Update Summonarr&quot; notification to every registered iOS device?
            </p>
            <p className="text-xs text-zinc-400">
              This goes to all users&apos; iOS devices at once and cannot be recalled. Limited to 2 sends per hour.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={handleSend}
            className="bg-amber-600 hover:bg-amber-500 h-7 px-4 text-xs"
          >
            Send to all devices
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setPhase("idle")}
            className="border-zinc-600 text-zinc-400 hover:text-white h-7 px-3 text-xs"
          >
            Cancel
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
          onClick={() => setPhase("confirm")}
          disabled={phase === "sending"}
          className="border-zinc-700 text-zinc-300 hover:text-white gap-2"
        >
          {phase === "sending" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          {phase === "sending" ? "Sending…" : "Send update notice to all iOS devices"}
        </Button>
        {summary && (
          <span role={phase === "error" ? "alert" : "status"} aria-live={phase === "error" ? "assertive" : "polite"} className={`text-xs ${phase === "error" ? "text-red-400" : "text-green-400"}`}>
            {summary}
          </span>
        )}
      </div>
      {phase === "idle" && (
        <p className="text-xs text-zinc-500">
          Pushes a generic &quot;a new version is available on the App Store&quot; alert to every iOS device registered on this server.
        </p>
      )}
    </div>
  );
}
