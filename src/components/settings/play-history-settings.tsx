"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CheckCircle, XCircle, Loader2 } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import { Switch } from "@/components/ui/switch";

type SaveStatus = "idle" | "saving" | "ok" | "error";

// Admin settings form for play-history tracking: toggles, thresholds, and
// retention, PATCHed to /api/settings on submit.
export function PlayHistorySettingsForm({
  initialEnabled,
  initialPlexEnabled,
  initialJellyfinEnabled,
  initialWatchedThreshold,
  initialCompletionThreshold,
  initialArcGapDays,
  initialPollingInterval,
  initialRetentionDays,
}: {
  initialEnabled: string;
  initialPlexEnabled: string;
  initialJellyfinEnabled: string;
  initialWatchedThreshold: string;
  initialCompletionThreshold: string;
  initialArcGapDays: string;
  initialPollingInterval: string;
  initialRetentionDays: string;
}) {
  const [enabled, setEnabled] = useState(initialEnabled === "true");
  const [plexEnabled, setPlexEnabled] = useState(initialPlexEnabled === "true");
  const [jellyfinEnabled, setJellyfinEnabled] = useState(initialJellyfinEnabled === "true");
  const [watchedThreshold, setWatchedThreshold] = useState(initialWatchedThreshold);
  const [completionThreshold, setCompletionThreshold] = useState(initialCompletionThreshold);
  const [arcGapDays, setArcGapDays] = useState(initialArcGapDays);
  const [pollingInterval, setPollingInterval] = useState(initialPollingInterval);
  const [retentionDays, setRetentionDays] = useState(initialRetentionDays);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const enabledId = useId();
  const plexId = useId();
  const jellyfinId = useId();

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setStatus("saving");
    setError(null);
    try {
      const res = await fetch(withBasePath("/api/settings"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          playHistoryEnabled: enabled ? "true" : "false",
          playHistoryPlexEnabled: plexEnabled ? "true" : "false",
          playHistoryJellyfinEnabled: jellyfinEnabled ? "true" : "false",
          playHistoryWatchedThreshold: watchedThreshold,
          playHistoryCompletionThreshold: completionThreshold,
          playHistoryArcGapDays: arcGapDays,
          playHistoryPollingInterval: pollingInterval,
          playHistoryRetentionDays: retentionDays,
        }),
      });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (res.ok && data?.ok) {
        setStatus("ok");
        // Only the success tick fades; an error stays until the next save.
        setTimeout(() => setStatus((s) => (s === "ok" ? "idle" : s)), 3000);
      } else {
        setError(data?.error ?? `Save failed (${res.status})`);
        setStatus("error");
      }
    } catch {
      setError("Network error — please try again");
      setStatus("error");
    }
  }

  return (
    <form onSubmit={handleSave} className="space-y-5">
      <div className="flex items-center gap-3">
        <Switch id={enabledId} size="lg" checked={enabled} onCheckedChange={() => setEnabled(!enabled)} />
        <Label htmlFor={enabledId} className="cursor-pointer">
          Enable play history tracking
        </Label>
      </div>

      {enabled && (
        <>
          <div className="space-y-3 pl-1">
            <div className="flex items-center gap-3">
              <Switch id={plexId} aria-label="Track Plex play history" checked={plexEnabled} onCheckedChange={() => setPlexEnabled(!plexEnabled)} />
              <Label htmlFor={plexId} className="cursor-pointer text-sm text-zinc-300">Plex</Label>
            </div>
            <div className="flex items-center gap-3">
              <Switch id={jellyfinId} aria-label="Track Jellyfin play history" checked={jellyfinEnabled} onCheckedChange={() => setJellyfinEnabled(!jellyfinEnabled)} />
              <Label htmlFor={jellyfinId} className="cursor-pointer text-sm text-zinc-300">Jellyfin</Label>
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
            <p className="text-xs text-zinc-500">Minimum percentage of media that must be played to count as &quot;watched&quot;</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="completion-threshold">Completion Threshold (%)</Label>
            <Input
              id="completion-threshold"
              type="number"
              min={0}
              max={100}
              value={completionThreshold}
              onChange={(e) => { setCompletionThreshold(e.target.value); setStatus("idle"); }}
              className="bg-zinc-800 border-zinc-700 text-sm w-32"
            />
            <p className="text-xs text-zinc-500">Cumulative watch percentage across one viewing arc to count as a completion in &quot;Popular on Server&quot;. Stricter than the per-session Watched threshold.</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="arc-gap-days">Arc Gap (days)</Label>
            <Input
              id="arc-gap-days"
              type="number"
              min={1}
              max={365}
              value={arcGapDays}
              onChange={(e) => { setArcGapDays(e.target.value); setStatus("idle"); }}
              className="bg-zinc-800 border-zinc-700 text-sm w-32"
            />
            <p className="text-xs text-zinc-500">Sessions on the same media farther apart than this start a new viewing arc. A weekend chunked watch stays one arc; a months-later rewatch starts a new one.</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="polling-interval">Polling Interval (seconds)</Label>
            <Input
              id="polling-interval"
              type="number"
              // 5 is both the default and the lowest value the container's
              // cron loop accepts. A higher min would make the browser reject
              // the default value and block saving the whole form.
              min={5}
              max={600}
              value={pollingInterval}
              onChange={(e) => { setPollingInterval(e.target.value); setStatus("idle"); }}
              className="bg-zinc-800 border-zinc-700 text-sm w-32"
            />
            <p className="text-xs text-zinc-500">How often to check for active sessions (default: 5s). The live cadence comes from the PLAY_HISTORY_SYNC_INTERVAL environment variable and applies on container restart — saving here records the value but does not change it.</p>
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
            <p className="text-xs text-zinc-500">Delete play history older than this many days. 0 = keep forever.</p>
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
        {status === "error" && <XCircle className="w-4 h-4 shrink-0 text-red-500" aria-hidden="true" />}
        {status === "error" && error && <span role="alert" className="text-xs text-red-400">{error}</span>}
      </div>
    </form>
  );
}
