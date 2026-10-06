"use client";

import { useEffect, useId, useRef, useState } from "react";
import { CheckCircle, XCircle, Loader2 } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import type { SaveStatus } from "./shared";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/components/i18n/i18n-provider";

// Admin → Settings → Authentication: "Prompt administrators to set up two-factor"
// (Setting key requireMfaForAdmins).
// See src/lib/mfa/policy.ts for exactly what it enforces (an /admin redirect to
// enrollment — never a sign-in lockout).
export function RequireAdminMfaToggle({ initialRequired, envOverride }: { initialRequired: boolean; envOverride: boolean }) {
  const t = useT();
  const [required, setRequired] = useState(initialRequired);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const titleId = useId();
  const descId = useId();

  useEffect(() => () => {
    if (resetTimer.current) clearTimeout(resetTimer.current);
  }, []);

  async function toggle() {
    const next = !required;
    const prev = required;
    setRequired(next);
    setStatus("saving");
    setError(null);
    if (resetTimer.current) clearTimeout(resetTimer.current);
    try {
      const res = await fetch(withBasePath("/api/settings"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requireMfaForAdmins: next ? "true" : "false" }),
      });
      const data: { ok?: boolean; error?: string } = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        setRequired(prev);
        setError(data.error ?? t("settings.form.common.saveFailed"));
        setStatus("error");
      } else {
        setStatus("ok");
        resetTimer.current = setTimeout(() => setStatus("idle"), 3000);
      }
    } catch {
      setRequired(prev);
      setError(t("settings.form.common.saveFailed"));
      setStatus("error");
    }
  }

  // Same row recipe as the three sibling toggles in the Authentication card:
  // the card owns the dividers (divide-y), each row owns its vertical padding,
  // and a server error wraps onto its own full-width line instead of pushing
  // the switch off-card at 375px.
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0 flex-1">
        <p id={titleId} className="text-sm font-medium text-zinc-200">{t("settings.form.requireAdminMfa.title")}</p>
        <p id={descId} className="text-xs text-zinc-500 mt-0.5">
          {t("settings.form.requireAdminMfa.help")}
          {envOverride && (
            <span className="block mt-1 text-amber-400">
              {t("settings.form.requireAdminMfa.envOverride", { env: "SUMMONARR_DISABLE_MFA_ENFORCEMENT=true" })}
            </span>
          )}
        </p>
      </div>
      <div className="flex items-center gap-2">
        {status === "saving" && <Loader2 className="w-3.5 h-3.5 animate-spin text-zinc-500" aria-hidden />}
        {status === "ok"     && <CheckCircle className="w-3.5 h-3.5 text-green-400" aria-hidden />}
        <Switch
          checked={required}
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
