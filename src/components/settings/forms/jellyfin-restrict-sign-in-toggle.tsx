"use client";

import { useEffect, useId, useRef, useState } from "react";
import { CheckCircle, XCircle, Loader2 } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import type { SaveStatus } from "./shared";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/components/i18n/i18n-provider";

export function JellyfinRestrictSignInToggle({ initialRestrict }: { initialRestrict: boolean }) {
  const t = useT();
  const [restrict, setRestrict] = useState(initialRestrict);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const descId = useId();
  // A new save cancels the old ✓ fade timer so it can't blank this save's
  // result (or unlock the switch) mid-flight — same shape as the sibling
  // toggles. Only the ✓ fades; an error (e.g. the 10s write cooldown's
  // "wait 9s") stays until the next flip. Cleared on unmount.
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (idleTimer.current) clearTimeout(idleTimer.current); }, []);

  async function toggle() {
    const next = !restrict;
    const prev = restrict;
    setRestrict(next);
    if (idleTimer.current) clearTimeout(idleTimer.current);
    setStatus("saving");
    setError(null);
    try {
      const res = await fetch(withBasePath("/api/settings"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jellyfinRestrictSignIn: next ? "true" : "false" }),
      });
      const data: { ok?: boolean; error?: string } = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        setRestrict(prev);
        setError(data.error ?? t("settings.form.common.saveFailed"));
        setStatus("error");
      } else {
        setStatus("ok");
        idleTimer.current = setTimeout(() => setStatus("idle"), 3000);
      }
    } catch {
      setRestrict(prev);
      setError(t("settings.form.common.saveFailed"));
      setStatus("error");
    }
  }

  // Row recipe shared with the sibling toggles: the parent card owns the
  // dividers (divide-y), the row owns its padding, and a server error wraps
  // onto its own full-width line.
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0 flex-1">
        <p id={titleId} className="text-sm font-medium text-zinc-200">{t("settings.form.jellyfinRestrict.title")}</p>
        <p id={descId} className="text-xs text-zinc-500 mt-0.5">
          {t("settings.form.jellyfinRestrict.help")}
        </p>
      </div>
      <div className="flex items-center gap-2">
        {status === "saving" && <Loader2 className="w-3.5 h-3.5 animate-spin text-zinc-500" />}
        {status === "ok"     && <CheckCircle className="w-3.5 h-3.5 text-green-400" />}
        <Switch
          checked={restrict}
          onCheckedChange={toggle}
          disabled={status === "saving"}
          aria-labelledby={titleId}
          aria-describedby={descId}
          className="shrink-0"
        />
      </div>
      {status === "error" && (
        <span role="alert" className="basis-full flex items-center gap-1 text-xs text-red-400">
          <XCircle className="w-3.5 h-3.5 shrink-0" aria-hidden />
          {error}
        </span>
      )}
    </div>
  );
}
