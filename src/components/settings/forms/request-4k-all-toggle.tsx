"use client";

import { useRef, useState } from "react";
import { CheckCircle, XCircle, Loader2 } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import type { SaveStatus } from "./shared";
import { Switch } from "@/components/ui/switch";

export function Request4kAllToggle({ initialEnabled }: { initialEnabled: boolean }) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [status, setStatus] = useState<SaveStatus>("idle");
  // The timer that fades the ✓/✗ back to idle. A new save cancels the old
  // timer; otherwise it could fire mid-save, set "idle", and unlock the control
  // while the request is still in flight.
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Only one save at a time: the switch is disabled while a save is running.
  // request4kAll skips the settings route's per-key cooldown (so a quick
  // second click to undo isn't rejected with a 429), which means nothing else
  // stops two saves overlapping. Two overlapping saves could finish in the
  // wrong order and leave the switch showing OFF while the server still lets
  // everyone request 4K.
  async function toggle() {
    const next = !enabled;
    const prev = enabled;
    setEnabled(next);
    if (idleTimer.current) clearTimeout(idleTimer.current);
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
    idleTimer.current = setTimeout(() => setStatus("idle"), 3000);
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
