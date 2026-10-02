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

  return (
    <div className="flex items-center justify-between gap-4 mt-4">
      <div>
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
          checked={required}
          onCheckedChange={toggle}
          disabled={status === "saving"}
          aria-labelledby={titleId}
          aria-describedby={descId}
        />
      </div>
    </div>
  );
}
