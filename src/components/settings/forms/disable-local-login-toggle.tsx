"use client";

import { useEffect, useId, useRef, useState } from "react";
import { CheckCircle, XCircle, Loader2 } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import type { SaveStatus } from "./shared";
import { Switch } from "@/components/ui/switch";

export function DisableLocalLoginToggle({ initialDisabled }: { initialDisabled: boolean }) {
  const [disabled, setDisabled] = useState(initialDisabled);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const titleId = useId();
  const descId = useId();

  useEffect(() => () => {
    if (resetTimer.current) clearTimeout(resetTimer.current);
  }, []);

  async function toggle() {
    const next = !disabled;
    const prev = disabled;
    setDisabled(next);
    setStatus("saving");
    setError(null);
    if (resetTimer.current) clearTimeout(resetTimer.current);
    try {
      const res = await fetch(withBasePath("/api/settings"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ disableLocalLogin: next ? "true" : "false" }),
      });
      const data: { ok?: boolean; error?: string } = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        // The switch was flipped before the server answered. Flip it back so it
        // doesn't show a setting the server rejected or never saved.
        setDisabled(prev);
        setError(data.error ?? "Failed to save");
        setStatus("error");
      } else {
        setStatus("ok");
        resetTimer.current = setTimeout(() => setStatus("idle"), 3000);
      }
    } catch {
      setDisabled(prev);
      setError("Failed to save");
      setStatus("error");
    }
  }

  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <p id={titleId} className="text-sm font-medium text-zinc-200">Disable local login</p>
        <p id={descId} className="text-xs text-zinc-500 mt-0.5">
          Hides the password sign-in form and blocks local registration. Users must sign in via an external provider (Plex, Jellyfin, or SSO/OIDC). Make sure at least one external provider is configured before enabling.
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
            checked={disabled}
            onCheckedChange={toggle}
            disabled={status === "saving"}
            aria-labelledby={titleId}
            aria-describedby={descId}
          />
      </div>
    </div>
  );
}
