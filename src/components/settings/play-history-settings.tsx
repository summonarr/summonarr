"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CheckCircle, XCircle, Loader2 } from "lucide-react";

type SaveStatus = "idle" | "saving" | "ok" | "error";

export function PlayHistorySettingsForm({
  initialEnabled,
  initialPlexEnabled,
  initialJellyfinEnabled,
  initialWatchedThreshold,
  initialPollingInterval,
  initialRetentionDays,
}: {
  initialEnabled: string;
  initialPlexEnabled: string;
  initialJellyfinEnabled: string;
  initialWatchedThreshold: string;
  initialPollingInterval: string;
  initialRetentionDays: string;
}) {
  const [enabled, setEnabled] = useState(initialEnabled === "true");
  const [plexEnabled, setPlexEnabled] = useState(initialPlexEnabled === "true");
  const [jellyfinEnabled, setJellyfinEnabled] = useState(initialJellyfinEnabled === "true");
  const [watchedThreshold, setWatchedThreshold] = useState(initialWatchedThreshold);
  const [pollingInterval, setPollingInterval] = useState(initialPollingInterval);
  const [retentionDays, setRetentionDays] = useState(initialRetentionDays);
  const [status, setStatus] = useState<SaveStatus>("idle");

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setStatus("saving");
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          playHistoryEnabled: enabled ? "true" : "false",
          playHistoryPlexEnabled: plexEnabled ? "true" : "false",
          playHistoryJellyfinEnabled: jellyfinEnabled ? "true" : "false",
          playHistoryWatchedThreshold: watchedThreshold,
          playHistoryPollingInterval: pollingInterval,
          playHistoryRetentionDays: retentionDays,
        }),
      });
      const data: { ok: boolean } = await res.json();
      setStatus(data.ok ? "ok" : "error");
    } catch {
      setStatus("error");
    }
    setTimeout(() => setStatus("idle"), 3000);
  }

  return (
    <form onSubmit={handleSave} className="space-y-5">
      <div className="flex items-center gap-3">
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          onClick={() => setEnabled(!enabled)}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
            enabled ? "bg-indigo-600" : "bg-zinc-700"
          }`}
        >
          <span className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${
            enabled ? "translate-x-6" : "translate-x-1"
          }`} />
        </button>
        <Label className="cursor-pointer" onClick={() => setEnabled(!enabled)}>
          Enable play history tracking
        </Label>
      </div>

      {enabled && (
        <>
          <div className="space-y-3 pl-1">
            <div className="flex items-center gap-3">
              <button
                type="button"
                role="switch"
                aria-checked={plexEnabled}
                onClick={() => setPlexEnabled(!plexEnabled)}
                className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                  plexEnabled ? "bg-indigo-600" : "bg-zinc-700"
                }`}
              >
                <span className={`inline-block h-3 w-3 rounded-full bg-white transition-transform ${
                  plexEnabled ? "translate-x-5" : "translate-x-1"
                }`} />
              </button>
              <span className="text-sm text-zinc-300">Plex</span>
            </div>
            <div className="flex items-center gap-3">
              <button
                type="button"
                role="switch"
                aria-checked={jellyfinEnabled}
                onClick={() => setJellyfinEnabled(!jellyfinEnabled)}
                className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                  jellyfinEnabled ? "bg-indigo-600" : "bg-zinc-700"
                }`}
              >
                <span className={`inline-block h-3 w-3 rounded-full bg-white transition-transform ${
                  jellyfinEnabled ? "translate-x-5" : "translate-x-1"
                }`} />
              </button>
              <span className="text-sm text-zinc-300">Jellyfin</span>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="watched-threshold">Watched Threshold (%)</Label>
            <Input
              id="watched-threshold"
              type="number"
              min={0}
              max={100}
              value={watchedThreshold}
              onChange={(e) => { setWatchedThreshold(e.target.value); setStatus("idle"); }}
              className="bg-zinc-800 border-zinc-700 text-sm w-32"
            />
            <p className="text-xs text-zinc-600">Minimum percentage of media that must be played to count as &quot;watched&quot;</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="polling-interval">Polling Interval (seconds)</Label>
            <Input
              id="polling-interval"
              type="number"
              min={10}
              max={600}
              value={pollingInterval}
              onChange={(e) => { setPollingInterval(e.target.value); setStatus("idle"); }}
              className="bg-zinc-800 border-zinc-700 text-sm w-32"
            />
            <p className="text-xs text-zinc-600">How often to check for active sessions (default: 5s). Requires container restart via PLAY_HISTORY_SYNC_INTERVAL env var.</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="retention-days">Data Retention (days)</Label>
            <Input
              id="retention-days"
              type="number"
              min={0}
              value={retentionDays}
              onChange={(e) => { setRetentionDays(e.target.value); setStatus("idle"); }}
              className="bg-zinc-800 border-zinc-700 text-sm w-32"
            />
            <p className="text-xs text-zinc-600">Delete play history older than this many days. 0 = keep forever.</p>
          </div>

          <div className="space-y-2 pt-2 border-t border-zinc-800">
            <h3 className="text-sm font-medium text-zinc-300 pt-2">How tracking works</h3>
            <p className="text-xs text-zinc-500">
              Play history is tracked automatically by polling your Plex and Jellyfin servers every few seconds for active sessions. No configuration is needed in Plex or Jellyfin — it uses the same server connection already configured above.
            </p>
          </div>
        </>
      )}

      <div className="flex items-center gap-3 pt-2">
        <Button type="submit" disabled={status === "saving"} className="bg-indigo-600 hover:bg-indigo-500">
          {status === "saving" ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
          Save
        </Button>
        {status === "ok" && <CheckCircle className="w-4 h-4 text-green-500" />}
        {status === "error" && <XCircle className="w-4 h-4 text-red-500" />}
      </div>
    </form>
  );
}
