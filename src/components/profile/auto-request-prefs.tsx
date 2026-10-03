"use client";

import { useState } from "react";
import { withBasePath } from "@/lib/base-path";
import { useT } from "@/components/i18n/i18n-provider";
import { Switch } from "@/components/ui/switch";

// "Auto-request from my Plex watchlist" — the user's own switch for the Plex half
// of watchlist auto-request (src/lib/auto-request.ts). Rendered only while the
// feature is on and the user holds an AUTO_REQUEST* bit. Saves on flip and rolls
// back if the save fails.
//
// With the admin's server-token source on (guardrail 34b), a user WITHOUT their
// own token can be read through the server owner's token — but only once they
// switch this on themselves (the stored toggle defaults on, which is not
// consent). So for such a user the switch shows the EFFECTIVE state: off until
// they have opted in, and switching it on is the opt-in.
export function AutoRequestPrefs({
  initialPlexWatchlist,
  plexConnected,
  serverSource,
  serverOptedIn,
  serverStatus,
}: {
  initialPlexWatchlist: boolean;
  plexConnected: boolean;
  serverSource: boolean;
  serverOptedIn: boolean;
  serverStatus: "ok" | "private" | "error" | null;
}) {
  const t = useT();
  const needsOptIn = serverSource && !plexConnected && !serverOptedIn;
  const [on, setOn] = useState(initialPlexWatchlist && !needsOptIn);
  const [optedIn, setOptedIn] = useState(serverOptedIn);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    if (saving) return;
    const next = !on;
    setOn(next);
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(withBasePath("/api/profile/auto-request"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plexWatchlist: next }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setOn(!next);
        setError(data?.error ?? t("profile.error.saveFailed"));
      } else {
        setOptedIn(next);
      }
    } catch {
      setOn(!next);
      setError(t("profile.error.network"));
    } finally {
      setSaving(false);
    }
  }

  let hint: string;
  if (plexConnected) hint = t("profile.autoRequest.plexConnected");
  else if (!serverSource) hint = t("profile.autoRequest.plexNotConnected");
  else if (!optedIn || !on) hint = t("profile.autoRequest.plexServerOptIn");
  else if (serverStatus === "ok") hint = t("profile.autoRequest.plexServerConnected");
  else if (serverStatus === "private") hint = t("profile.autoRequest.plexServerPrivate");
  else hint = t("profile.autoRequest.plexServerPending");

  return (
    <div>
      <p className="text-xs text-zinc-500" style={{ marginBottom: 8 }}>
        {t("profile.autoRequest.summonarrHint")}
      </p>
      <div className="flex items-start justify-between gap-4 py-3">
        <div>
          <p className="text-sm font-medium text-zinc-200">{t("profile.autoRequest.plexLabel")}</p>
          <p className="text-xs text-zinc-500 mt-0.5">{hint}</p>
        </div>
        <Switch checked={on} disabled={saving} onCheckedChange={toggle} aria-label={t("profile.autoRequest.plexLabel")} />
      </div>
      {error && (
        <p role="alert" className="text-xs text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
