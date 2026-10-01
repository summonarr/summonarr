"use client";

import { useState } from "react";
import { withBasePath } from "@/lib/base-path";
import { Switch } from "@/components/ui/switch";

// "Auto-request from my Plex watchlist" — the user's own switch for the Plex half
// of watchlist auto-request (src/lib/auto-request.ts). Rendered only while the
// feature is on and the user holds an AUTO_REQUEST* bit. Saves on flip and rolls
// back if the save fails.
export function AutoRequestPrefs({
  initialPlexWatchlist,
  plexConnected,
}: {
  initialPlexWatchlist: boolean;
  plexConnected: boolean;
}) {
  const [on, setOn] = useState(initialPlexWatchlist);
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
        setError(data?.error ?? "Failed to save — please try again");
      }
    } catch {
      setOn(!next);
      setError("Network error — please try again");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <p className="text-xs text-zinc-500" style={{ marginBottom: 8 }}>
        Titles you add to your Summonarr watchlist are requested for you automatically.
      </p>
      <div className="flex items-start justify-between gap-4 py-3">
        <div>
          <p className="text-sm font-medium text-zinc-200">Auto-request from my Plex watchlist</p>
          <p className="text-xs text-zinc-500 mt-0.5">
            {plexConnected
              ? "New titles on your Plex watchlist are requested periodically."
              : "Sign in with Plex once to connect your Plex watchlist."}
          </p>
        </div>
        <Switch checked={on} disabled={saving} onCheckedChange={toggle} aria-label="Auto-request from my Plex watchlist" />
      </div>
      {error && (
        <p role="alert" className="text-xs text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
