"use client";

import { useEffect, useId, useRef, useState } from "react";
import { CheckCircle, XCircle, Loader2 } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import type { SaveStatus } from "./shared";
import { Switch } from "@/components/ui/switch";

export function EnableUserEmailsToggle({ initialEnabled }: { initialEnabled: boolean }) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const titleId = useId();
  const descId = useId();

  useEffect(() => () => {
    if (resetTimer.current) clearTimeout(resetTimer.current);
  }, []);

  async function toggle() {
    const next = !enabled;
    const prev = enabled;
    setEnabled(next);
    setStatus("saving");
    setError(null);
    if (resetTimer.current) clearTimeout(resetTimer.current);
    try {
      const res = await fetch(withBasePath("/api/settings"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enableUserEmails: next ? "true" : "false" }),
      });
      const data: { ok?: boolean; error?: string } = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        setEnabled(prev);
        setError(data.error ?? "Failed to save");
        setStatus("error");
      } else {
        setStatus("ok");
        resetTimer.current = setTimeout(() => setStatus("idle"), 3000);
      }
    } catch {
      setEnabled(prev);
      setError("Failed to save");
      setStatus("error");
    }
  }

  return (
    <div className="flex items-center justify-between gap-4 py-3 border-t border-zinc-800">
      <div>
        <p id={titleId} className="text-sm font-medium text-zinc-200">Send notification emails</p>
        <p id={descId} className="text-xs text-zinc-500 mt-0.5">
          When enabled, users receive emails for approved, declined, and available events (based on their own preferences)
          and admins receive new request, issue, and deletion-vote alerts. When disabled, no notification emails are sent
          (saving the settings above still sends a configuration test email).
        </p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {status === "saving" && <Loader2 className="w-3.5 h-3.5 animate-spin text-zinc-500" />}
        {status === "ok"     && <CheckCircle className="w-3.5 h-3.5 text-green-400" />}
        {status === "error"  && (
            <span role="alert" className="flex max-w-xs items-center gap-1 text-right text-xs text-red-400">
              <XCircle className="w-3.5 h-3.5" aria-hidden />
              {error}
            </span>
          )}
        <Switch
            checked={enabled}
            onCheckedChange={toggle}
            disabled={status === "saving"}
            aria-labelledby={titleId}
            aria-describedby={descId}
          />
      </div>
    </div>
  );
}
