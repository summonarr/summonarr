"use client";

import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CheckCircle, Loader2, Play, RefreshCw, XCircle } from "lucide-react";
import type { ActionState, ApplyResult, TrashSettings } from "./types";

interface SyncSettingsCardProps {
  initialSettings: TrashSettings;
  // Notifies the parent page so it can re-fetch specs after a refresh / sync-now run.
  onAfterAction?: (results: ApplyResult[]) => void;
}

export function SyncSettingsCard({ initialSettings, onAfterAction }: SyncSettingsCardProps) {
  const [settings, setSettings] = useState<TrashSettings>(initialSettings);
  const [saveState, setSaveState] = useState<ActionState>("idle");
  const [refreshState, setRefreshState] = useState<ActionState>("idle");
  const [syncState, setSyncState] = useState<ActionState>("idle");

  async function patchSettings(partial: Partial<TrashSettings>) {
    setSaveState("running");
    const body: Record<string, string> = {};
    if (partial.enabled !== undefined) body.trashGuidesEnabled = String(partial.enabled);
    if (partial.syncCustomFormats !== undefined) body.trashSyncCustomFormats = String(partial.syncCustomFormats);
    if (partial.syncCustomFormatGroups !== undefined) body.trashSyncCustomFormatGroups = String(partial.syncCustomFormatGroups);
    if (partial.syncQualityProfiles !== undefined) body.trashSyncQualityProfiles = String(partial.syncQualityProfiles);
    if (partial.syncNaming !== undefined) body.trashSyncNaming = String(partial.syncNaming);
    if (partial.syncQualitySizes !== undefined) body.trashSyncQualitySizes = String(partial.syncQualitySizes);

    try {
      const res = await fetch(`/api/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error();
      setSettings((prev) => ({ ...prev, ...partial }));
      setSaveState("ok");
    } catch {
      setSaveState("error");
    }
    setTimeout(() => setSaveState("idle"), 2000);
  }

  async function handleRefresh() {
    setRefreshState("running");
    try {
      const res = await fetch(`/api/admin/trash-guides/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (res.status === 409) {
        setRefreshState("error");
        setTimeout(() => setRefreshState("idle"), 3000);
        return;
      }
      const data = (await res.json()) as { ok?: boolean; errors?: string[] };
      const hasErrors = !res.ok || !data.ok || (data.errors && data.errors.length > 0);
      setRefreshState(hasErrors ? "error" : "ok");
      onAfterAction?.([]);
    } catch {
      setRefreshState("error");
    }
    setTimeout(() => setRefreshState((s) => (s === "error" ? s : "idle")), 3000);
  }

  async function handleSyncNow() {
    setSyncState("running");
    try {
      const res = await fetch(`/api/cron/trash-sync`, { method: "POST" });
      const data = (await res.json()) as { applied?: ApplyResult[] };
      setSyncState(res.ok ? "ok" : "error");
      onAfterAction?.(data.applied ?? []);
    } catch {
      setSyncState("error");
    }
    setTimeout(() => setSyncState("idle"), 3000);
  }

  return (
    <Card className="bg-zinc-900 border-zinc-800 p-6">
      <div className="mb-5">
        <h2 className="font-semibold text-white text-lg">Sync Settings</h2>
        <p className="text-sm text-zinc-500 mt-0.5">
          Enable the master toggle, then pick which kinds of specs the cron job re-applies each run.
        </p>
      </div>

      <div className="space-y-3">
        <ToggleRow
          label="TRaSH Sync Enabled"
          description="Master switch. When off, the trash-sync cron job exits immediately."
          checked={settings.enabled}
          onChange={(v) => patchSettings({ enabled: v })}
        />
        <ToggleRow
          label="Sync Custom Formats"
          description="Re-apply managed CFs on every sync. Overwrites manual edits in Radarr/Sonarr."
          checked={settings.syncCustomFormats}
          onChange={(v) => patchSettings({ syncCustomFormats: v })}
          indent
          disabled={!settings.enabled}
        />
        <ToggleRow
          label="Sync Custom Format Groups"
          description="Re-apply managed TRaSH CF-Groups (HDR Formats, Release Groups HQ, etc.). Each group cascades to its member CFs."
          checked={settings.syncCustomFormatGroups}
          onChange={(v) => patchSettings({ syncCustomFormatGroups: v })}
          indent
          disabled={!settings.enabled}
        />
        <ToggleRow
          label="Sync Quality Profiles"
          description="Re-apply managed quality profiles."
          checked={settings.syncQualityProfiles}
          onChange={(v) => patchSettings({ syncQualityProfiles: v })}
          indent
          disabled={!settings.enabled}
        />
        <ToggleRow
          label="Sync Naming"
          description="Re-apply managed naming schemes."
          checked={settings.syncNaming}
          onChange={(v) => patchSettings({ syncNaming: v })}
          indent
          disabled={!settings.enabled}
        />
        <ToggleRow
          label="Sync Quality Sizes"
          description="Re-apply managed quality-size templates (Radarr/Sonarr quality definition sliders)."
          checked={settings.syncQualitySizes}
          onChange={(v) => patchSettings({ syncQualitySizes: v })}
          indent
          disabled={!settings.enabled}
        />
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-2 border-t border-zinc-800 pt-4">
        <Button
          type="button"
          onClick={handleRefresh}
          disabled={refreshState === "running"}
          className="bg-zinc-800 hover:bg-zinc-700 text-white"
        >
          {refreshState === "running"
            ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Refreshing…</>
            : <><RefreshCw className="w-4 h-4 mr-2" />Refresh Catalog</>}
        </Button>
        <Button
          type="button"
          onClick={handleSyncNow}
          disabled={syncState === "running" || !settings.enabled}
          className="bg-indigo-600 hover:bg-indigo-500 text-white"
        >
          {syncState === "running"
            ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Syncing…</>
            : <><Play className="w-4 h-4 mr-2" />Sync Now</>}
        </Button>

        {saveState === "ok"    && <span className="text-xs text-green-400 flex items-center gap-1.5"><CheckCircle className="w-3.5 h-3.5" />Saved</span>}
        {saveState === "error" && <span className="text-xs text-red-400 flex items-center gap-1.5"><XCircle className="w-3.5 h-3.5" />Save failed</span>}
        {refreshState === "ok"    && <span className="text-xs text-green-400 flex items-center gap-1.5"><CheckCircle className="w-3.5 h-3.5" />Catalog refreshed</span>}
        {refreshState === "error" && <span className="text-xs text-red-400 flex items-center gap-1.5"><XCircle className="w-3.5 h-3.5" />Refresh failed</span>}
        {syncState === "ok"    && <span className="text-xs text-green-400 flex items-center gap-1.5"><CheckCircle className="w-3.5 h-3.5" />Sync complete</span>}
        {syncState === "error" && <span className="text-xs text-red-400 flex items-center gap-1.5"><XCircle className="w-3.5 h-3.5" />Sync failed</span>}
      </div>
    </Card>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  onChange,
  indent,
  disabled,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  indent?: boolean;
  disabled?: boolean;
}) {
  return (
    <label
      className={`flex items-start gap-3 cursor-pointer group ${indent ? "ml-6" : ""} ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
        className="mt-0.5 w-4 h-4 rounded border-zinc-600 bg-zinc-800 accent-indigo-500"
      />
      <div>
        <p className="text-sm text-zinc-200 font-medium group-hover:text-white transition-colors">{label}</p>
        <p className="text-xs text-zinc-500">{description}</p>
      </div>
    </label>
  );
}
