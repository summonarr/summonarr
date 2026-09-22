"use client";

import { useState } from "react";
import { CheckCircle, XCircle, Loader2 } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import type { SaveStatus } from "./shared";
import { Switch } from "@/components/ui/switch";

export function DisableLocalLoginToggle({ initialDisabled }: { initialDisabled: boolean }) {
  const [disabled, setDisabled] = useState(initialDisabled);
  const [status, setStatus] = useState<SaveStatus>("idle");

  async function toggle() {
    const next = !disabled;
    const prev = disabled;
    setDisabled(next);
    setStatus("saving");
    try {
      const res = await fetch(withBasePath("/api/settings"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ disableLocalLogin: next ? "true" : "false" }),
      });
      const data: { ok: boolean } = await res.json().catch(() => ({ ok: false }));
      if (!data.ok) {
        // Roll back the optimistic toggle so the switch doesn't show a state the
        // server rejected (or a network error never persisted).
        setDisabled(prev);
        setStatus("error");
      } else {
        setStatus("ok");
      }
    } catch {
      setDisabled(prev);
      setStatus("error");
    }
    setTimeout(() => setStatus("idle"), 3000);
  }

  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <p className="text-sm font-medium text-zinc-200">Disable local login</p>
        <p className="text-xs text-zinc-500 mt-0.5">
          Hides the password sign-in form and blocks local registration. Users must sign in via an external provider (Plex, Jellyfin, or SSO/OIDC). Make sure at least one external provider is configured before enabling.
        </p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {status === "saving" && <Loader2 className="w-3.5 h-3.5 animate-spin text-zinc-500" />}
        {status === "ok"     && <CheckCircle className="w-3.5 h-3.5 text-green-400" />}
        {status === "error"  && <XCircle className="w-3.5 h-3.5 text-red-400" />}
        <Switch checked={disabled} onCheckedChange={toggle} />
      </div>
    </div>
  );
}
