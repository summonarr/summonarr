"use client";

import { useId, useRef, useState } from "react";
import { CheckCircle, XCircle, Loader2 } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import type { SaveStatus } from "./shared";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/components/i18n/i18n-provider";

// The two switches for the Plex watchlist server-token source (guardrail 34b):
// plexWatchlistServerSource and plexWatchlistServerAutoEnroll. Same one-save-
// at-a-time shape as Request4kAllToggle (both keys skip the route's cooldown).
function SettingSwitch({
  settingKey,
  initialEnabled,
  title,
  help,
}: {
  settingKey: "plexWatchlistServerSource" | "plexWatchlistServerAutoEnroll";
  initialEnabled: boolean;
  title: string;
  help: string;
}) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const titleId = useId();
  const descId = useId();
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
        body: JSON.stringify({ [settingKey]: next ? "true" : "false" }),
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
        <p id={titleId} className="text-sm font-medium text-zinc-200">{title}</p>
        <p id={descId} className="text-xs text-zinc-500 mt-0.5">{help}</p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {status === "saving" && <Loader2 className="w-3.5 h-3.5 animate-spin text-zinc-500" />}
        {status === "ok" && <CheckCircle className="w-3.5 h-3.5 text-green-400" />}
        {status === "error" && <XCircle className="w-3.5 h-3.5 text-red-400" />}
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

export function PlexWatchlistServerToggles({
  initialServerSource,
  initialAutoEnroll,
}: {
  initialServerSource: boolean;
  initialAutoEnroll: boolean;
}) {
  const t = useT();
  return (
    <div className="space-y-5">
      <SettingSwitch
        settingKey="plexWatchlistServerSource"
        initialEnabled={initialServerSource}
        title={t("settings.form.plexWatchlistServer.title")}
        help={t("settings.form.plexWatchlistServer.help")}
      />
      <div className="border-t border-zinc-800 pt-5">
        <SettingSwitch
          settingKey="plexWatchlistServerAutoEnroll"
          initialEnabled={initialAutoEnroll}
          title={t("settings.form.plexWatchlistAutoEnroll.title")}
          help={t("settings.form.plexWatchlistAutoEnroll.help")}
        />
      </div>
    </div>
  );
}
