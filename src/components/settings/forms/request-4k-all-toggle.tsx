"use client";

import { useState } from "react";
import { CheckCircle, XCircle, Loader2 } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import type { SaveStatus } from "./shared";
import { Switch } from "@/components/ui/switch";

export function Request4kAllToggle({ initialEnabled }: { initialEnabled: boolean }) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [status, setStatus] = useState<SaveStatus>("idle");

  // One write at a time. request4kAll is exempt from the settings route's
  // per-key cooldown (so a corrective second click isn't 429'd back to the
  // state the admin just left), and nothing else serialises this control —
  // two overlapping PATCHes could commit out of order and leave the switch
  // showing OFF while the server still grants everyone 4K.
  async function toggle() {
    const next = !enabled;
    const prev = enabled;
    setEnabled(next);
    setStatus("saving");
    try {
      const res = await fetch(withBasePath("/api/settings"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request4kAll: next ? "true" : "false" }),
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
    <div className="flex items-center justify-between gap-4">
      <div>
        <p className="text-sm font-medium text-zinc-200">Allow everyone to request 4K</p>
        <p className="text-xs text-zinc-500 mt-0.5">
          When on, any user who can request a given media type can also request it in 4K — no
          per-user “Request 4K” permission needed. When off, 4K requires the per-user permission
          (or admin). Either way a 4K Radarr/Sonarr instance must be configured above.
        </p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {status === "saving" && <Loader2 className="w-3.5 h-3.5 animate-spin text-zinc-500" />}
        {status === "ok"     && <CheckCircle className="w-3.5 h-3.5 text-green-400" />}
        {status === "error"  && <XCircle className="w-3.5 h-3.5 text-red-400" />}
        <Switch checked={enabled} onCheckedChange={toggle} disabled={status === "saving"} />
      </div>
    </div>
  );
}
