"use client";

import { useId, useRef, useState } from "react";
import { CheckCircle, XCircle, Loader2 } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import type { SaveStatus } from "./shared";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/components/i18n/i18n-provider";

export function JellyfinRestrictSignInToggle({ initialRestrict }: { initialRestrict: boolean }) {
  const t = useT();
  const [restrict, setRestrict] = useState(initialRestrict);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const titleId = useId();
  const descId = useId();
  // A new save cancels the old ✓/✗ fade timer so it can't blank this save's
  // result (or unlock the switch) mid-flight — same shape as Request4kAllToggle.
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function toggle() {
    const next = !restrict;
    const prev = restrict;
    setRestrict(next);
    if (idleTimer.current) clearTimeout(idleTimer.current);
    setStatus("saving");
    try {
      const res = await fetch(withBasePath("/api/settings"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jellyfinRestrictSignIn: next ? "true" : "false" }),
      });
      const data: { ok: boolean } = await res.json().catch(() => ({ ok: false }));
      if (!data.ok) {
        setRestrict(prev);
        setStatus("error");
      } else {
        setStatus("ok");
      }
    } catch {
      setRestrict(prev);
      setStatus("error");
    }
    idleTimer.current = setTimeout(() => setStatus("idle"), 3000);
  }

  return (
    <div className="flex items-center justify-between gap-4 mt-4">
      <div>
        <p id={titleId} className="text-sm font-medium text-zinc-200">{t("settings.form.jellyfinRestrict.title")}</p>
        <p id={descId} className="text-xs text-zinc-500 mt-0.5">
          {t("settings.form.jellyfinRestrict.help")}
        </p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {status === "saving" && <Loader2 className="w-3.5 h-3.5 animate-spin text-zinc-500" />}
        {status === "ok"     && <CheckCircle className="w-3.5 h-3.5 text-green-400" />}
        {status === "error"  && <XCircle className="w-3.5 h-3.5 text-red-400" />}
        <Switch
          checked={restrict}
          onCheckedChange={toggle}
          disabled={status === "saving"}
          aria-labelledby={titleId}
          aria-describedby={descId}
        />
      </div>
    </div>
  );
}
