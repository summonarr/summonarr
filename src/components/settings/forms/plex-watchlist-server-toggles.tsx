"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Loader2 } from "@/components/icons";
import { SaveStatusMessage } from "./save-status";
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
  const t = useT();
  const [enabled, setEnabled] = useState(initialEnabled);
  const [status, setStatus] = useState<SaveStatus>("idle");
  // The route's own reason — shown in place of the bare "Failed to save".
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const descId = useId();
  // Only an "ok" fades; an error stays until the next flip. The ref keeps an
  // earlier flip's timer from firing into a later save.
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (idleTimer.current) clearTimeout(idleTimer.current);
  }, []);

  async function toggle() {
    const next = !enabled;
    const prev = enabled;
    setEnabled(next);
    if (idleTimer.current) clearTimeout(idleTimer.current);
    setStatus("saving");
    setError(null);
    try {
      const res = await fetch(withBasePath("/api/settings"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [settingKey]: next ? "true" : "false" }),
      });
      const data: { ok?: boolean; error?: string } = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        setEnabled(prev);
        setError(data.error ?? t("settings.form.common.saveFailed"));
        setStatus("error");
      } else {
        setStatus("ok");
      }
    } catch {
      setEnabled(prev);
      setError(t("settings.form.common.saveFailed"));
      setStatus("error");
    }
    idleTimer.current = setTimeout(() => setStatus((s) => (s === "ok" ? "idle" : s)), 3000);
  }

  // A server error wraps onto its own full-width line (SaveStatusMessage is
  // the shared live region) instead of pushing the switch off-card at 375px.
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <div className="min-w-0 flex-1">
        <p id={titleId} className="text-sm font-medium text-zinc-200">{title}</p>
        <p id={descId} className="text-xs text-zinc-500 mt-0.5">{help}</p>
      </div>
      <div className="flex items-center gap-2">
        {status === "saving" && <Loader2 className="w-3.5 h-3.5 animate-spin text-zinc-500" aria-hidden />}
        {status === "ok" && <SaveStatusMessage status="ok" />}
        <Switch
          checked={enabled}
          onCheckedChange={toggle}
          disabled={status === "saving"}
          aria-labelledby={titleId}
          aria-describedby={descId}
          className="shrink-0"
        />
      </div>
      {status === "error" && (
        <div className="basis-full">
          <SaveStatusMessage status="error" errorLabel={error ?? t("settings.form.common.saveFailed")} />
        </div>
      )}
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
