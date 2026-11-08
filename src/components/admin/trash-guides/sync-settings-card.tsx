"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, Play, RefreshCw } from "@/components/icons";
import {
  TRASH_SYNC_TOGGLES,
  sameTrashSettings,
  trashSettingsPatch,
  type ApplyResult,
  type TrashSettings,
} from "./types";
import { withBasePath } from "@/lib/base-path";
import { fetchJson, LONG_RUN_TIMEOUT_MS } from "@/lib/client/fetch-json";
import { useSettingsSave } from "@/components/settings/forms/shared";
import { RefreshErrorBanner } from "./banners";
import { ApplyLog } from "./apply-log";
import { useCatalogRefresh } from "./use-catalog-refresh";
import { useTrashRun } from "./use-trash-run";
import { answerOf, syncOutcome } from "./outcomes";
import { StatusNote } from "./status-note";
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
  // The card re-reads the page (router.refresh) after a refresh or a sync, and
  // the server hands it the stored switches: follow them, so a change made
  // elsewhere (another admin, TRaSH switched off server-side) shows here
  // instead of the values this page first loaded with.
  const [serverSettings, setServerSettings] = useState<TrashSettings>(initialSettings);
  if (!sameTrashSettings(serverSettings, initialSettings)) {
    setServerSettings(initialSettings);
    setSettings(initialSettings);
  }
  // A switch saves on flip through the house settings save: the route's own
  // reason when it refuses (the per-key 10 s cooldown, the admin-settings rate
  // limit), and "Saved" only for a 2xx that says ok.
  const saver = useSettingsSave(2000);
  // Sync Now's run: a skip (the trash lock is held, or the feature is off on
  // the server — another admin or tab turned it off since this page loaded)
  // ran nothing; a degraded run is a 200 with ok:false, so the body decides.
  const sync = useTrashRun();
  const refresh = useCatalogRefresh(() => {
    onAfterAction?.([]);
    router.refresh();
  });

  async function patchSettings(change: Partial<TrashSettings>) {
    // The toggles ignore clicks while a save is in flight (ToggleRow `busy`);
    // this is the backstop.
    if (saver.status === "saving") return;
    const result = await saver.save(trashSettingsPatch(change));
    if (result.ok) setSettings((prev) => ({ ...prev, ...change }));
  }

  async function handleSyncNow() {
    if (sync.busy()) return;
    sync.begin();
    // The run refreshes the catalog and re-applies every managed spec on
    // every instance: no client timeout, or a slow success reads as a failure.
    const res = await sync.request((signal) =>
      fetchJson(withBasePath(`/api/cron/trash-sync`), { init: { method: "POST" }, timeoutMs: LONG_RUN_TIMEOUT_MS, signal }),
    );
    if (!res) return;
    const answer = answerOf(res);
    if (answer === undefined) return;
    if (answer === null) {
      sync.fail(t("trash.spec.error.network"));
      return;
    }
    const outcome = syncOutcome(answer.status, answer.body, t("trash.banner.stoppedEarly"));
    // The route's reason says which skip (guardrail 6: the cron envelope).
    if (outcome.kind === "skipped") {
      sync.skip(outcome.reason, outcome.reason === "disabled" ? 6000 : 3000);
      // The toggles were stale: show the server's state.
      if (outcome.reason === "disabled") setSettings((prev) => ({ ...prev, enabled: false }));
      return;
    }
    sync.done(
      outcome.failed,
      outcome.errors.length > 0 ? { errors: outcome.errors } : null,
      outcome.applied.some((r) => !r.ok) ? outcome.applied : [],
    );
    onAfterAction?.(outcome.applied);
    if (outcome.refreshed > 0) router.refresh();
  }

  const saving = saver.status === "saving";

  return (
    <Card className="bg-zinc-900 border-zinc-800 p-6">
      <div className="mb-5">
        <h2 className="font-semibold text-zinc-100 text-lg">{t("trash.sync.title")}</h2>
        <p className="text-sm text-zinc-500 mt-0.5">
          {t("trash.sync.subtitle")}
        </p>
      </div>

      <div className="space-y-3">
        {TRASH_SYNC_TOGGLES.map(({ field, labelKey, descriptionKey }) => {
          // The master switch first; every sync kind only matters while it is on.
          const master = field === "enabled";
          return (
            <ToggleRow
              key={field}
              label={t(labelKey)}
              description={t(descriptionKey)}
              checked={settings[field]}
              onChange={(v) => patchSettings({ [field]: v })}
              busy={saving}
              indent={!master}
              disabled={!master && !settings.enabled}
            />
          );
        })}
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
          disabled={sync.running || !settings.enabled}
          className="bg-indigo-600 hover:bg-indigo-500 text-[var(--ds-accent-fg)]"
        >
          {sync.running
            ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />{t("trash.sync.syncing")}</>
            : <><Play className="w-4 h-4 mr-2" />{t("trash.sync.syncNow")}</>}
        </Button>

        {saver.status === "ok" && <StatusNote tone="ok">{t("trash.common.saved")}</StatusNote>}
        {saver.status === "error" && <StatusNote tone="error">{saver.message || t("trash.common.saveFailed")}</StatusNote>}
        {refresh.state === "ok" && <StatusNote tone="ok">{t("trash.sync.catalogRefreshed")}</StatusNote>}
        {refresh.state === "error" && <StatusNote tone="error">{t("trash.sync.refreshFailed")}</StatusNote>}
        {sync.state === "ok" && <StatusNote tone="ok">{t("trash.sync.syncComplete")}</StatusNote>}
        {sync.state === "error" && <StatusNote tone="error">{t("trash.sync.syncFailed")}</StatusNote>}
        {refresh.skipped && <StatusNote tone="running">{t("trash.sync.refreshAlreadyRunning")}</StatusNote>}
        {sync.skipped === "running" && <StatusNote tone="running">{t("trash.sync.alreadyRunning")}</StatusNote>}
        {sync.skipped === "disabled" && <StatusNote tone="disabled">{t("trash.sync.disabledOnServer")}</StatusNote>}
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
      {sync.error && (
        <div className="mt-4">
          <RefreshErrorBanner error={sync.error} title={t("trash.banner.syncFailed")} onDismiss={sync.dismissError} />
        </div>
      )}
      {sync.log.length > 0 && (
        <div className="mt-4">
          <ApplyLog results={sync.log} onDismiss={sync.dismissLog} />
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
