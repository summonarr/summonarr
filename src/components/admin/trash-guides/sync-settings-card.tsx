"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useDelayed } from "@/hooks/use-delayed";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AlertTriangle, CheckCircle, Clock, Loader2, Play, RefreshCw, XCircle } from "@/components/icons";
import type { ActionState, ApplyResult, TrashSettings } from "./types";
import { withBasePath } from "@/lib/base-path";
import { RefreshErrorBanner } from "./banners";
import { ApplyLog } from "./apply-log";
import { useCatalogRefresh, type RunError } from "./use-catalog-refresh";
import { syncOutcome } from "./outcomes";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import { useHasMounted } from "@/hooks/use-has-mounted";
import { formatRelativeTimeLocalized } from "@/lib/relative-time";

interface SyncSettingsCardProps {
  initialSettings: TrashSettings;
  // ISO timestamp of the last catalog refresh (the `trashLastRefreshAt`
  // Setting, read by the server page); null when the catalog was never pulled.
  // The card re-reads the page (router.refresh) after a refresh or sync, so a
  // new stamp shows without a reload.
  lastRefreshAt?: string | null;
  // Notifies the parent page so it can re-fetch specs after a refresh / sync-now run.
  onAfterAction?: (results: ApplyResult[]) => void;
}

export function SyncSettingsCard({ initialSettings, lastRefreshAt = null, onAfterAction }: SyncSettingsCardProps) {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  // Relative time is client-only (guardrail 16): empty until mounted.
  const mounted = useHasMounted();
  const [settings, setSettings] = useState<TrashSettings>(initialSettings);
  const [saveState, setSaveState] = useState<ActionState>("idle");
  // The route's own reason for a refused save (the per-key 10 s cooldown, the
  // admin-settings rate limit) — "Save failed" alone hid why a quick second
  // toggle was refused.
  const [saveError, setSaveError] = useState("");
  const [syncState, setSyncState] = useState<ActionState>("idle");
  // Why Sync Now ran nothing: the trash lock was held, or the feature is off
  // on the server (another admin or tab turned it off since this page loaded).
  const [syncSkipped, setSyncSkipped] = useState<"running" | "disabled" | null>(null);
  const [syncError, setSyncError] = useState<RunError | null>(null);
  const [syncLog, setSyncLog] = useState<ApplyResult[]>([]);
  // One timer per message, each cancelled when its action starts again, so an
  // earlier run's reset never lands on a later one.
  const laterSave = useDelayed();
  const laterSync = useDelayed();
  const laterSyncSkipped = useDelayed();
  const refresh = useCatalogRefresh(() => {
    onAfterAction?.([]);
    router.refresh();
  });

  async function patchSettings(partial: Partial<TrashSettings>) {
    // The toggles ignore clicks while a save is in flight (ToggleRow `busy`);
    // this is the backstop.
    if (saveState === "running") return;
    laterSave.cancel();
    setSaveState("running");
    setSaveError("");
    const body: Record<string, string> = {};
    if (partial.enabled !== undefined) body.trashGuidesEnabled = String(partial.enabled);
    if (partial.syncCustomFormats !== undefined) body.trashSyncCustomFormats = String(partial.syncCustomFormats);
    if (partial.syncCustomFormatGroups !== undefined) body.trashSyncCustomFormatGroups = String(partial.syncCustomFormatGroups);
    if (partial.syncQualityProfiles !== undefined) body.trashSyncQualityProfiles = String(partial.syncQualityProfiles);
    if (partial.syncNaming !== undefined) body.trashSyncNaming = String(partial.syncNaming);
    if (partial.syncQualitySizes !== undefined) body.trashSyncQualitySizes = String(partial.syncQualitySizes);

    try {
      const res = await fetch(withBasePath(`/api/settings`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: unknown } | null;
        setSaveError(typeof data?.error === "string" ? data.error : "");
        setSaveState("error");
        // Long enough to read a reason ("wait N seconds").
        laterSave(() => setSaveState((s) => (s === "error" ? "idle" : s)), 6000);
        return;
      }
      setSettings((prev) => ({ ...prev, ...partial }));
      setSaveState("ok");
    } catch {
      setSaveState("error");
      laterSave(() => setSaveState((s) => (s === "error" ? "idle" : s)), 6000);
      return;
    }
    laterSave(() => setSaveState((s) => (s === "ok" ? "idle" : s)), 2000);
  }

  async function handleSyncNow() {
    laterSync.cancel();
    laterSyncSkipped.cancel();
    setSyncState("running");
    setSyncSkipped(null);
    setSyncError(null);
    setSyncLog([]);
    try {
      const res = await fetch(withBasePath(`/api/cron/trash-sync`), { method: "POST" });
      const body = (await res.json().catch(() => null)) as unknown;
      const outcome = syncOutcome(res.status, body, t("trash.banner.stoppedEarly"));
      // A skip (the trash lock is held, or the feature is off server-side) ran
      // nothing, so it is neither a success nor a failure. The route's reason
      // says which (guardrail 6: the cron envelope).
      if (outcome.kind === "skipped") {
        setSyncState("idle");
        setSyncSkipped(outcome.reason);
        // The toggles were stale: show the server's state.
        if (outcome.reason === "disabled") setSettings((prev) => ({ ...prev, enabled: false }));
        laterSyncSkipped(() => setSyncSkipped(null), outcome.reason === "disabled" ? 6000 : 3000);
        return;
      }
      // A degraded run is a 200 with ok:false, so the body decides, not the status.
      setSyncState(outcome.failed ? "error" : "ok");
      if (outcome.errors.length > 0) setSyncError({ errors: outcome.errors });
      if (outcome.applied.some((r) => !r.ok)) setSyncLog(outcome.applied);
      onAfterAction?.(outcome.applied);
      if (outcome.refreshed > 0) router.refresh();
    } catch (err) {
      setSyncState("error");
      setSyncError({ errors: [err instanceof Error ? err.message : String(err)] });
    }
    // Clear a success message after 3s; an error stays until dismissed or the
    // next click.
    laterSync(() => setSyncState((s) => (s === "ok" ? "idle" : s)), 3000);
  }

  // The inline "Sync failed" goes once the run's banner and log are both gone.
  function dismissSyncError() {
    setSyncError(null);
    if (syncLog.length === 0) setSyncState((s) => (s === "error" ? "idle" : s));
  }
  function dismissSyncLog() {
    setSyncLog([]);
    if (!syncError) setSyncState((s) => (s === "error" ? "idle" : s));
  }

  const saving = saveState === "running";

  return (
    <Card className="bg-zinc-900 border-zinc-800 p-6">
      <div className="mb-5">
        <h2 className="font-semibold text-zinc-100 text-lg">{t("trash.sync.title")}</h2>
        <p className="text-sm text-zinc-500 mt-0.5">
          {t("trash.sync.subtitle")}
        </p>
      </div>

      <div className="space-y-3">
        <ToggleRow
          label={t("trash.sync.toggle.enabled.label")}
          description={t("trash.sync.toggle.enabled.description")}
          checked={settings.enabled}
          onChange={(v) => patchSettings({ enabled: v })}
          busy={saving}
        />
        <ToggleRow
          label={t("trash.sync.toggle.customFormats.label")}
          description={t("trash.sync.toggle.customFormats.description")}
          checked={settings.syncCustomFormats}
          onChange={(v) => patchSettings({ syncCustomFormats: v })}
          busy={saving}
          indent
          disabled={!settings.enabled}
        />
        <ToggleRow
          label={t("trash.sync.toggle.customFormatGroups.label")}
          description={t("trash.sync.toggle.customFormatGroups.description")}
          checked={settings.syncCustomFormatGroups}
          onChange={(v) => patchSettings({ syncCustomFormatGroups: v })}
          busy={saving}
          indent
          disabled={!settings.enabled}
        />
        <ToggleRow
          label={t("trash.sync.toggle.qualityProfiles.label")}
          description={t("trash.sync.toggle.qualityProfiles.description")}
          checked={settings.syncQualityProfiles}
          onChange={(v) => patchSettings({ syncQualityProfiles: v })}
          busy={saving}
          indent
          disabled={!settings.enabled}
        />
        <ToggleRow
          label={t("trash.sync.toggle.naming.label")}
          description={t("trash.sync.toggle.naming.description")}
          checked={settings.syncNaming}
          onChange={(v) => patchSettings({ syncNaming: v })}
          busy={saving}
          indent
          disabled={!settings.enabled}
        />
        <ToggleRow
          label={t("trash.sync.toggle.qualitySizes.label")}
          description={t("trash.sync.toggle.qualitySizes.description")}
          checked={settings.syncQualitySizes}
          onChange={(v) => patchSettings({ syncQualitySizes: v })}
          busy={saving}
          indent
          disabled={!settings.enabled}
        />
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-2 border-t border-zinc-800 pt-4">
        <Button
          type="button"
          onClick={() => void refresh.run()}
          disabled={refresh.state === "running"}
          className="bg-zinc-800 hover:bg-zinc-700 text-zinc-100"
        >
          {refresh.state === "running"
            ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />{t("trash.sync.refreshing")}</>
            : <><RefreshCw className="w-4 h-4 mr-2" />{t("trash.sync.refreshCatalog")}</>}
        </Button>
        <Button
          type="button"
          onClick={handleSyncNow}
          disabled={syncState === "running" || !settings.enabled}
          className="bg-indigo-600 hover:bg-indigo-500 text-[var(--ds-accent-fg)]"
        >
          {syncState === "running"
            ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />{t("trash.sync.syncing")}</>
            : <><Play className="w-4 h-4 mr-2" />{t("trash.sync.syncNow")}</>}
        </Button>

        {saveState === "ok"    && <span className="text-xs text-green-400 flex items-center gap-1.5"><CheckCircle className="w-3.5 h-3.5" />{t("trash.common.saved")}</span>}
        {saveState === "error" && <span className="text-xs text-red-400 flex items-center gap-1.5"><XCircle className="w-3.5 h-3.5" />{saveError || t("trash.common.saveFailed")}</span>}
        {refresh.state === "ok"    && <span className="text-xs text-green-400 flex items-center gap-1.5"><CheckCircle className="w-3.5 h-3.5" />{t("trash.sync.catalogRefreshed")}</span>}
        {refresh.state === "error" && <span className="text-xs text-red-400 flex items-center gap-1.5"><XCircle className="w-3.5 h-3.5" />{t("trash.sync.refreshFailed")}</span>}
        {syncState === "ok"    && <span className="text-xs text-green-400 flex items-center gap-1.5"><CheckCircle className="w-3.5 h-3.5" />{t("trash.sync.syncComplete")}</span>}
        {syncState === "error" && <span className="text-xs text-red-400 flex items-center gap-1.5"><XCircle className="w-3.5 h-3.5" />{t("trash.sync.syncFailed")}</span>}
        {refresh.skipped && <span className="text-xs text-amber-400 flex items-center gap-1.5"><Clock className="w-3.5 h-3.5" />{t("trash.sync.refreshAlreadyRunning")}</span>}
        {syncSkipped === "running" && <span className="text-xs text-amber-400 flex items-center gap-1.5"><Clock className="w-3.5 h-3.5" />{t("trash.sync.alreadyRunning")}</span>}
        {syncSkipped === "disabled" && <span className="text-xs text-amber-400 flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5" />{t("trash.sync.disabledOnServer")}</span>}
      </div>
      <p className="mt-2 text-xs text-zinc-500">
        {lastRefreshAt
          ? mounted
            ? t("trash.sync.lastRefreshed", { ago: formatRelativeTimeLocalized(lastRefreshAt, locale) })
            : ""
          : t("trash.sync.neverRefreshed")}
      </p>

      {refresh.error && (
        <div className="mt-4">
          <RefreshErrorBanner error={refresh.error} onDismiss={refresh.dismiss} />
        </div>
      )}
      {syncError && (
        <div className="mt-4">
          <RefreshErrorBanner error={syncError} title={t("trash.banner.syncFailed")} onDismiss={dismissSyncError} />
        </div>
      )}
      {syncLog.length > 0 && (
        <div className="mt-4">
          <ApplyLog results={syncLog} onDismiss={dismissSyncLog} />
        </div>
      )}
    </Card>
  );
}

// `busy` (a save is in flight) ignores a change rather than disabling the box:
// a disabled control drops keyboard focus (AdminToggleRow's rule). The box only
// moves once its save lands, so a second click used to send a duplicate PATCH
// that the route's per-key cooldown then refused.
function ToggleRow({
  label,
  description,
  checked,
  onChange,
  indent,
  disabled,
  busy,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  indent?: boolean;
  disabled?: boolean;
  busy?: boolean;
}) {
  return (
    <label
      className={`flex items-start gap-3 cursor-pointer group ${indent ? "ml-6" : ""} ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => { if (!busy) onChange(e.target.checked); }}
        aria-busy={busy || undefined}
        disabled={disabled}
        className="mt-0.5 w-4 h-4 rounded border-zinc-600 bg-zinc-800 accent-indigo-500"
      />
      <div>
        <p className="text-sm text-zinc-300 font-medium group-hover:text-zinc-100 transition-colors">{label}</p>
        <p className="text-xs text-zinc-500">{description}</p>
      </div>
    </label>
  );
}
