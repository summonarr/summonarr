"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "@/components/icons";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/components/i18n/i18n-provider";
import { SaveStatusMessage } from "./forms/save-status";
import { useSettingsSave, type SettingsPatchResult } from "./forms/shared";

// Admin settings form for play-history tracking: toggles, thresholds,
// retention and the statistics time zone, PATCHed to /api/settings on submit.
export function PlayHistorySettingsForm({
  initialEnabled,
  initialPlexEnabled,
  initialJellyfinEnabled,
  initialWatchedThreshold,
  initialCompletionThreshold,
  initialArcGapDays,
  initialPollingInterval,
  initialRetentionDays,
  initialConcurrentStreamLimit,
  initialStatsTimeZone,
  defaultStatsTimeZone,
}: {
  initialEnabled: string;
  initialPlexEnabled: string;
  initialJellyfinEnabled: string;
  initialWatchedThreshold: string;
  initialCompletionThreshold: string;
  initialArcGapDays: string;
  initialPollingInterval: string;
  initialRetentionDays: string;
  initialConcurrentStreamLimit: string;
  // The stored statsTimeZone ("" = unset) and the zone that means: the server
  // process's own, from the server, so nothing here reads the browser's.
  initialStatsTimeZone: string;
  defaultStatsTimeZone: string;
}) {
  const [enabled, setEnabled] = useState(initialEnabled === "true");
  const [plexEnabled, setPlexEnabled] = useState(initialPlexEnabled === "true");
  const [jellyfinEnabled, setJellyfinEnabled] = useState(initialJellyfinEnabled === "true");
  const [watchedThreshold, setWatchedThreshold] = useState(initialWatchedThreshold);
  const [completionThreshold, setCompletionThreshold] = useState(initialCompletionThreshold);
  const [arcGapDays, setArcGapDays] = useState(initialArcGapDays);
  const [pollingInterval, setPollingInterval] = useState(initialPollingInterval);
  const [retentionDays, setRetentionDays] = useState(initialRetentionDays);
  const [concurrentLimit, setConcurrentLimit] = useState(initialConcurrentStreamLimit);
  const [statsTimeZone, setStatsTimeZone] = useState(initialStatsTimeZone);
  const t = useT();
  const enabledId = useId();
  const plexId = useId();
  const jellyfinId = useId();
  // An edit during a save keeps Save locked and isn't reported as saved
  // (useSettingsSave). Only the success line fades; an error stays until the
  // next edit or save.
  const { status, message, save, edited } = useSettingsSave();
  const failureText = (r: SettingsPatchResult) =>
    r.status === 0 ? t("settings.common.networkError") : t("settings.common.saveFailedStatus", { status: r.status });

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    await save({
      playHistoryEnabled: enabled ? "true" : "false",
      playHistoryPlexEnabled: plexEnabled ? "true" : "false",
      playHistoryJellyfinEnabled: jellyfinEnabled ? "true" : "false",
      playHistoryWatchedThreshold: watchedThreshold,
      playHistoryCompletionThreshold: completionThreshold,
      playHistoryArcGapDays: arcGapDays,
      playHistoryPollingInterval: pollingInterval,
      playHistoryRetentionDays: retentionDays,
      concurrentStreamLimit: concurrentLimit,
      // Blank clears it (back to the server's zone); the server canonicalizes
      // and validates the name and answers a bad one with a 400.
      statsTimeZone: statsTimeZone.trim(),
    }, failureText);
  }

  return (
    <form onSubmit={handleSave} className="space-y-5">
      <div className="flex items-center gap-3">
        <Switch id={enabledId} size="lg" checked={enabled} onCheckedChange={() => { setEnabled(!enabled); edited(); }} />
        <Label htmlFor={enabledId} className="cursor-pointer">
          {t("settings.playHistory.enable")}
        </Label>
      </div>

      {enabled && (
        <>
          <div className="space-y-3 pl-1">
            <div className="flex items-center gap-3">
              <Switch id={plexId} aria-label={t("settings.playHistory.trackPlex")} checked={plexEnabled} onCheckedChange={() => { setPlexEnabled(!plexEnabled); edited(); }} />
              <Label htmlFor={plexId} className="cursor-pointer text-sm text-zinc-300">Plex</Label>
            </div>
            <div className="flex items-center gap-3">
              <Switch id={jellyfinId} aria-label={t("settings.playHistory.trackJellyfin")} checked={jellyfinEnabled} onCheckedChange={() => { setJellyfinEnabled(!jellyfinEnabled); edited(); }} />
              <Label htmlFor={jellyfinId} className="cursor-pointer text-sm text-zinc-300">Jellyfin</Label>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="watched-threshold">{t("settings.playHistory.watchedThreshold")}</Label>
            <Input
              id="watched-threshold"
              type="number"
              min={0}
              max={100}
              value={watchedThreshold}
              onChange={(e) => { setWatchedThreshold(e.target.value); edited(); }}
              className="bg-zinc-800 border-zinc-700 w-32"
            />
            <p className="text-xs text-zinc-500">{t("settings.playHistory.watchedThresholdHelp")}</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="completion-threshold">{t("settings.playHistory.completionThreshold")}</Label>
            <Input
              id="completion-threshold"
              type="number"
              min={0}
              max={100}
              value={completionThreshold}
              onChange={(e) => { setCompletionThreshold(e.target.value); edited(); }}
              className="bg-zinc-800 border-zinc-700 w-32"
            />
            <p className="text-xs text-zinc-500">{t("settings.playHistory.completionThresholdHelp")}</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="arc-gap-days">{t("settings.playHistory.arcGap")}</Label>
            <Input
              id="arc-gap-days"
              type="number"
              min={1}
              max={365}
              value={arcGapDays}
              onChange={(e) => { setArcGapDays(e.target.value); edited(); }}
              className="bg-zinc-800 border-zinc-700 w-32"
            />
            <p className="text-xs text-zinc-500">{t("settings.playHistory.arcGapHelp")}</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="polling-interval">{t("settings.playHistory.pollingInterval")}</Label>
            <Input
              id="polling-interval"
              type="number"
              // 5 is both the default and the lowest value the container's
              // cron loop accepts. A higher min would make the browser reject
              // the default value and block saving the whole form.
              min={5}
              max={600}
              value={pollingInterval}
              onChange={(e) => { setPollingInterval(e.target.value); edited(); }}
              className="bg-zinc-800 border-zinc-700 w-32"
            />
            <p className="text-xs text-zinc-500">{t("settings.playHistory.pollingIntervalHelp")}</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="retention-days">{t("settings.playHistory.retention")}</Label>
            <Input
              id="retention-days"
              type="number"
              min={0}
              value={retentionDays}
              onChange={(e) => { setRetentionDays(e.target.value); edited(); }}
              className="bg-zinc-800 border-zinc-700 w-32"
            />
            <p className="text-xs text-zinc-500">{t("settings.playHistory.retentionHelp")}</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="concurrent-stream-limit">{t("settings.playHistory.concurrentLimit")}</Label>
            <Input
              id="concurrent-stream-limit"
              type="number"
              min={0}
              max={50}
              value={concurrentLimit}
              onChange={(e) => { setConcurrentLimit(e.target.value); edited(); }}
              className="bg-zinc-800 border-zinc-700 w-32"
            />
            <p className="text-xs text-zinc-500">{t("settings.playHistory.concurrentLimitHelp")}</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="stats-time-zone">{t("settings.playHistory.timeZone")}</Label>
            <Input
              id="stats-time-zone"
              type="text"
              autoComplete="off"
              spellCheck={false}
              maxLength={64}
              placeholder={defaultStatsTimeZone}
              value={statsTimeZone}
              onChange={(e) => { setStatsTimeZone(e.target.value); edited(); }}
              className="bg-zinc-800 border-zinc-700 w-64"
            />
            <p className="text-xs text-zinc-500">
              {t("settings.playHistory.timeZoneHelp", { zone: defaultStatsTimeZone })}
            </p>
          </div>

          <div className="space-y-2 pt-2 border-t border-zinc-800">
            <h3 className="text-sm font-medium text-zinc-300 pt-2">{t("settings.playHistory.howTitle")}</h3>
            <p className="text-xs text-zinc-500">
              {t("settings.playHistory.howBody")}
            </p>
          </div>
        </>
      )}

      <div className="flex items-center gap-3 pt-2">
        <Button type="submit" disabled={status === "saving"} className="bg-indigo-600 hover:bg-indigo-500">
          {status === "saving" ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
          {t("settings.common.save")}
        </Button>
        {/* Announced either way: "Saved" in a polite live region, the error
            in an assertive one. */}
        <SaveStatusMessage status={status} errorLabel={message || undefined} />
      </div>
    </form>
  );
}
