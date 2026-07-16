"use client";

import { useState } from "react";
import { CheckCircle, XCircle, Loader2 } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import type { SaveStatus } from "./shared";

export function EnableUserEmailsToggle({ initialEnabled }: { initialEnabled: boolean }) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [status, setStatus] = useState<SaveStatus>("idle");

  async function toggle() {
    const next = !enabled;
    const prev = enabled;
    setEnabled(next);
    setStatus("saving");
    try {
      const res = await fetch(withBasePath("/api/settings"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enableUserEmails: next ? "true" : "false" }),
      });
      const data: { ok: boolean } = await res.json().catch(() => ({ ok: false }));
      if (!data.ok) {
        setEnabled(prev);
        setStatus("error");
      } else {
        setStatus("ok");
      }
    } catch {
      setEnabled(prev);
      setStatus("error");
    }
    setTimeout(() => setStatus("idle"), 3000);
  }

  return (
    <div className="flex items-center justify-between gap-4 py-3 border-t border-zinc-800">
      <div>
        <p className="text-sm font-medium text-zinc-200">Send notification emails</p>
        <p className="text-xs text-zinc-500 mt-0.5">
          When enabled, users receive emails for approved, declined, and available events (based on their own preferences)
          and admins receive new request, issue, and deletion-vote alerts. When disabled, no notification emails are sent
          (saving the settings above still sends a configuration test email).
        </p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {status === "saving" && <Loader2 className="w-3.5 h-3.5 animate-spin text-zinc-500" />}
        {status === "ok"     && <CheckCircle className="w-3.5 h-3.5 text-green-400" />}
        {status === "error"  && <XCircle className="w-3.5 h-3.5 text-red-400" />}
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          onClick={toggle}
          className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 focus:ring-offset-zinc-900 ${enabled ? "bg-indigo-600" : "bg-zinc-700"}`}
        >
          <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${enabled ? "translate-x-4" : "translate-x-0.5"}`} />
        </button>
      </div>
    </div>
  );
}
