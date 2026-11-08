"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StyledSelect } from "@/components/ui/styled-select";
import { CheckCircle, XCircle, Loader2, RefreshCw, Download } from "@/components/icons";
import { SaveStatusMessage } from "./save-status";
import { withBasePath } from "@/lib/base-path";
import { fetchJson, LONG_RUN_TIMEOUT_MS } from "@/lib/client/fetch-json";
import { useAsyncAction } from "@/hooks/use-async-action";
import { useSettingsSave, type LoadStatus } from "./shared";
import { useT } from "@/components/i18n/i18n-provider";
import { SECRET_MASK_SENTINEL } from "@/lib/secret-mask";
import {
  MINIMUM_AVAILABILITY_OPTIONS,
  arrFormKeys,
  readArrOptions,
  type ArrFormKeys,
  type ArrOptions,
} from "../arr-options";
import { ArrProfileSelect } from "../arr-profile-select";

interface ArrFormProps {
  service: "radarr" | "sonarr";
  initialUrl: string;
  // The address a browser uses for the instance ("Open in Radarr" links). "" =
  // use initialUrl's address.
  initialExternalUrl?: string;
  // The settings page passes the mask when a key is saved, "" when none is.
  initialApiKey: string;
  initialRootFolder: string;
  initialQualityProfileId: string;
  // Radarr only. "" means "don't send it, let Radarr use its own default".
  initialMinimumAvailability?: string;
  // Sonarr v3 only. "" means "don't send it". The dropdown only appears when
  // the connected Sonarr actually has language profiles (Sonarr v4 removed them).
  initialLanguageProfileId?: string;
  // "4k" points the form at the optional second 4K instance (the radarr4k*/sonarr4k* settings).
  variant?: "hd" | "4k";
}

// A default/4K Radarr or Sonarr: the connection (Save & Test), the defaults
// read live from the instance once it is connected, and the one-off import.
export function ArrForm({
  service,
  initialUrl,
  initialExternalUrl = "",
  initialApiKey,
  initialRootFolder,
  initialQualityProfileId,
  initialMinimumAvailability = "",
  initialLanguageProfileId = "",
  variant = "hd",
}: ArrFormProps) {
  const keys = arrFormKeys(service, variant);
  const label = `${service === "radarr" ? "Radarr" : "Sonarr"}${variant === "4k" ? " 4K" : ""}`;
  // Whether a working connection is saved: the defaults and the import need
  // one, and stay up when a later options read fails.
  const [connected, setConnected] = useState(Boolean(initialUrl && initialApiKey));
  const [options, setOptions] = useState<ArrOptions | null>(null);
  const [optionsStatus, setOptionsStatus] = useState<LoadStatus>("idle");
  const action = useAsyncAction();

  // The mount read and the read after each Save & Test can overlap (a hung
  // first read against a wrong URL, then a quick one after the fix): each read
  // supersedes the last, whose answer is dropped, and unmount aborts it.
  // Radarr/Sonarr each get 30 s per call there (arrFetch), and Sonarr may need two.
  const fetchOptions = useCallback(async () => {
    setOptionsStatus("loading");
    const res = await action.run("options", (signal) =>
      fetchJson(withBasePath(`/api/settings/arr-options?service=${service}${variant === "4k" ? "&variant=4k" : ""}`), {
        signal,
        timeoutMs: 90_000,
      }));
    if (!res) return;
    const data = res.ok ? readArrOptions(res.data) : null;
    if (!data) {
      setOptionsStatus("error");
      return;
    }
    setOptions(data);
    setOptionsStatus("loaded");
  }, [action, service, variant]);

  useEffect(() => {
    if (initialUrl && initialApiKey) {
      void fetchOptions();
    }
  }, [initialUrl, initialApiKey, fetchOptions]);

  return (
    <div className="space-y-6">
      <ArrConnectionForm
        service={service}
        keys={keys}
        label={label}
        initialUrl={initialUrl}
        initialExternalUrl={initialExternalUrl}
        keySaved={initialApiKey.length > 0}
        onConnected={() => {
          setConnected(true);
          void fetchOptions();
        }}
      />

      {optionsStatus !== "idle" && (
        <ArrDefaultsSection
          service={service}
          keys={keys}
          label={label}
          options={options}
          optionsStatus={optionsStatus}
          onRefresh={() => void fetchOptions()}
          initial={{
            rootFolder: initialRootFolder,
            qualityProfileId: initialQualityProfileId,
            minimumAvailability: initialMinimumAvailability,
            languageProfileId: initialLanguageProfileId,
          }}
        />
      )}

      {/* The import reads the saved connection, not the options list, so a
          failed or slow options read doesn't hide it. */}
      {connected && variant !== "4k" && (
        <ArrImportSection service={service} />
      )}
    </div>
  );
}

function ArrConnectionForm({ service, keys, label, initialUrl, initialExternalUrl, keySaved: initialKeySaved, onConnected }: {
  service: "radarr" | "sonarr";
  keys: ArrFormKeys;
  label: string;
  initialUrl: string;
  initialExternalUrl: string;
  keySaved: boolean;
  onConnected: () => void;
}) {
  const t = useT();
  const [url, setUrl] = useState(initialUrl);
  const [externalUrl, setExternalUrl] = useState(initialExternalUrl);
  // Sent only when it changed since the last save, so an untouched blank
  // field doesn't write an empty row (and an audit entry) on every Save & Test.
  const [savedExternalUrl, setSavedExternalUrl] = useState(initialExternalUrl);
  // The field starts EMPTY even when a key is saved: the mask is only its
  // placeholder (ApiKeySettingForm's pattern). As the field's value, an edit
  // with the caret after it sent the mask plus the key, which the route refuses. An
  // empty field with a saved key sends the mask, which the route reads as
  // "keep it".
  const [apiKey, setApiKey] = useState("");
  const [keySaved, setKeySaved] = useState(initialKeySaved);
  // An edit during a save keeps Save locked until the answer lands, so a second
  // PATCH (and its connection test) can't race the first (useSettingsSave).
  const { status, message, save, edited } = useSettingsSave();
  const [okText, setOkText] = useState("");

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    // The URL is sent even when unchanged: it is what asks the route to test
    // the connection, and the route neither writes nor cooldowns a value equal
    // to the stored one, so pressing Save & Test again just re-tests. An
    // emptied external URL is sent as "" — the route clears it and the links
    // fall back to the connection URL.
    const sentExternal = externalUrl.trim();
    const result = await save(
      {
        [keys.url]: url,
        [keys.apiKey]: apiKey || SECRET_MASK_SENTINEL,
        ...(sentExternal !== savedExternalUrl ? { [keys.externalUrl]: sentExternal } : {}),
      },
      // A failed test answers 422 with only the variant key.
      (r) => {
        const reason = r.data[keys.error];
        return typeof reason === "string" && reason ? reason : t("settings.form.common.saveFailed");
      },
    );
    if (!result.ok) return;
    setSavedExternalUrl(sentExternal);
    if (apiKey) {
      setKeySaved(true);
      setApiKey("");
    }
    const version = result.data[keys.version];
    setOkText(typeof version === "string" && version
      ? t("settings.form.arr.connectedVersion", { version })
      : t("settings.form.common.saved"));
    onConnected();
  }

  return (
    <form onSubmit={handleSave} className="space-y-4">
      <div className="lg:grid lg:grid-cols-2 lg:gap-4 space-y-4 lg:space-y-0">
        <div className="space-y-1.5">
          <Label htmlFor={`${keys.idPrefix}-url`}>{t("settings.form.arr.url", { service: label })}</Label>
          <Input
            id={`${keys.idPrefix}-url`}
            type="url"
            value={url}
            onChange={(e) => { setUrl(e.target.value); edited(); }}
            placeholder={service === "radarr" ? "http://radarr:7878" : "http://sonarr:8989"}
            className="bg-zinc-800 border-zinc-700 font-mono"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${keys.idPrefix}-key`}>{t("settings.form.common.apiKey")}</Label>
          <Input
            id={`${keys.idPrefix}-key`}
            type="password"
            autoComplete="new-password"
            data-1p-ignore
            data-lpignore="true"
            value={apiKey}
            onChange={(e) => { setApiKey(e.target.value); edited(); }}
            placeholder={keySaved ? SECRET_MASK_SENTINEL : undefined}
            className="bg-zinc-800 border-zinc-700 font-mono"
          />
          {keySaved && !apiKey && (
            <p className="text-xs text-zinc-500">{t("settings.form.agents.secretKeep")}</p>
          )}
          <p className="text-xs text-zinc-500">{t("settings.form.arr.apiKeyHelp", { service: label })}</p>
        </div>
        <div className="space-y-1.5 lg:col-span-2">
          <Label htmlFor={`${keys.idPrefix}-external-url`}>{t("settings.form.arr.externalUrl")}</Label>
          <Input
            id={`${keys.idPrefix}-external-url`}
            type="url"
            value={externalUrl}
            onChange={(e) => { setExternalUrl(e.target.value); edited(); }}
            placeholder={service === "radarr" ? "https://radarr.example.com" : "https://sonarr.example.com"}
            className="bg-zinc-800 border-zinc-700 font-mono"
          />
          <p className="text-xs text-zinc-500">{t("settings.form.arr.externalUrlHelp", { service: label })}</p>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={status === "saving" || !url || (!apiKey && !keySaved)} className="bg-indigo-600 hover:bg-indigo-500">
          {status === "saving" ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />{t("settings.form.common.saving")}</> : t("settings.form.common.saveAndTest")}
        </Button>
        <SaveStatusMessage status={status} okLabel={okText || undefined} errorLabel={message || undefined} />
      </div>
    </form>
  );
}

interface ArrDefaults {
  rootFolder: string;
  qualityProfileId: string;
  minimumAvailability: string;
  languageProfileId: string;
}

function ArrDefaultsSection({ service, keys, label, options, optionsStatus, onRefresh, initial }: {
  service: "radarr" | "sonarr";
  keys: ArrFormKeys;
  label: string;
  options: ArrOptions | null;
  optionsStatus: LoadStatus;
  onRefresh: () => void;
  initial: ArrDefaults;
}) {
  const t = useT();
  const [rootFolder, setRootFolder] = useState(initial.rootFolder);
  const [qualityProfileId, setQualityProfileId] = useState(initial.qualityProfileId);
  const [minimumAvailability, setMinimumAvailability] = useState(initial.minimumAvailability);
  const [languageProfileId, setLanguageProfileId] = useState(initial.languageProfileId);
  // Save Defaults: only its "Saved" tick fades; an error stays until the next
  // edit or save, and an edit during a save keeps it locked (useSettingsSave).
  const { status, message, save, edited } = useSettingsSave();
  const languageProfiles = options?.languageProfiles ?? [];

  async function handleSaveOptions(e: React.FormEvent) {
    e.preventDefault();
    await save({
      [keys.rootFolder]: rootFolder,
      [keys.qualityProfileId]: qualityProfileId,
      // Sending "" clears the saved value, so new adds stop including the
      // field and Radarr/Sonarr fall back to their own default.
      ...(service === "radarr" ? { [keys.minimumAvailability]: minimumAvailability } : {}),
      ...(service === "sonarr" && languageProfiles.length > 0 ? { [keys.languageProfileId]: languageProfileId } : {}),
    });
  }

  return (
    <div className="border-t border-zinc-800 pt-5 space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-zinc-300">{t("settings.form.arr.defaults")}</p>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={onRefresh}
          disabled={optionsStatus === "loading"}
          className="text-zinc-500 hover:text-zinc-100"
        >
          <RefreshCw className={optionsStatus === "loading" ? "animate-spin" : ""} aria-hidden />
          {t("settings.form.arr.refresh")}
        </Button>
      </div>

      {optionsStatus === "error" && (
        <p role="alert" className="text-sm text-red-400">{t("settings.form.arr.optionsFailed")}</p>
      )}

      {optionsStatus === "loaded" && options && (
        <form onSubmit={handleSaveOptions} className="space-y-4">
          <div className="lg:grid lg:grid-cols-2 lg:gap-4 space-y-4 lg:space-y-0">
            <div className="space-y-1.5">
              <Label htmlFor={`${keys.idPrefix}-folder`}>{t("settings.form.arr.rootFolder")}</Label>
              <ArrProfileSelect
                id={`${keys.idPrefix}-folder`}
                value={rootFolder}
                onChange={(next) => { setRootFolder(next); edited(); }}
                defaultLabel={t("settings.form.arr.selectRootFolder")}
                options={options.rootFolders.map((f) => ({ value: f.path, label: f.path }))}
                staleLabel={(folder) => t("settings.form.arr.folderNotFound", { folder })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${keys.idPrefix}-profile`}>{t("settings.form.arr.qualityProfile")}</Label>
              <ArrProfileSelect
                id={`${keys.idPrefix}-profile`}
                value={qualityProfileId}
                onChange={(next) => { setQualityProfileId(next); edited(); }}
                defaultLabel={t("settings.form.arr.selectQualityProfile")}
                options={options.qualityProfiles.map((p) => ({ value: String(p.id), label: p.name }))}
                staleLabel={(id) => t("settings.form.arr.profileNotFound", { id })}
              />
            </div>

            {service === "radarr" && (
              <div className="space-y-1.5">
                <Label htmlFor={`${keys.idPrefix}-min-availability`}>{t("settings.form.arr.minimumAvailability")}</Label>
                <StyledSelect
                  compact
                  id={`${keys.idPrefix}-min-availability`}
                  value={minimumAvailability}
                  onChange={(e) => { setMinimumAvailability(e.target.value); edited(); }}
                >
                  <option value="">{t("settings.form.arr.serviceDefault", { service: label })}</option>
                  {MINIMUM_AVAILABILITY_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{t(o.labelKey)}</option>
                  ))}
                </StyledSelect>
                <p className="text-xs text-zinc-500">
                  {t("settings.form.arr.minimumAvailabilityHelp")}
                </p>
              </div>
            )}

            {/* Sonarr v3 only. v4 removed language profiles, so the options
                endpoint returns no list and this dropdown never shows. */}
            {service === "sonarr" && languageProfiles.length > 0 && (
              <div className="space-y-1.5">
                <Label htmlFor={`${keys.idPrefix}-language-profile`}>{t("settings.form.arr.languageProfile")}</Label>
                <ArrProfileSelect
                  id={`${keys.idPrefix}-language-profile`}
                  value={languageProfileId}
                  onChange={(next) => { setLanguageProfileId(next); edited(); }}
                  defaultLabel={t("settings.form.arr.serviceDefault", { service: label })}
                  options={languageProfiles.map((p) => ({ value: String(p.id), label: p.name }))}
                  staleLabel={(id) => t("settings.form.arr.profileNotFound", { id })}
                />
                <p className="text-xs text-zinc-500">
                  {t("settings.form.arr.languageProfileHelp")}
                </p>
              </div>
            )}
          </div>
          <div className="flex items-center gap-3">
            <Button
              type="submit"
              disabled={status === "saving" || !rootFolder || !qualityProfileId}
              className="bg-indigo-600 hover:bg-indigo-500"
            >
              {status === "saving" ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />{t("settings.form.common.saving")}</> : t("settings.form.arr.saveDefaults")}
            </Button>
            <SaveStatusMessage status={status} errorLabel={message || undefined} />
          </div>
        </form>
      )}
    </div>
  );
}

function ArrImportSection({ service }: { service: "radarr" | "sonarr" }) {
  const t = useT();
  const label = service === "radarr" ? "Radarr" : "Sonarr";
  const [importStatus, setImportStatus] = useState<"idle" | "importing" | "ok" | "error">("idle");
  const [importCount, setImportCount] = useState<number | null>(null);
  const [importError, setImportError] = useState("");

  async function handleImport() {
    setImportStatus("importing");
    setImportError("");
    // A full import of a large library outlasts any fixed wait.
    const res = await fetchJson(withBasePath(`/api/sync/${service}`), {
      init: { method: "POST" },
      timeoutMs: LONG_RUN_TIMEOUT_MS,
      fallbackError: t("settings.form.arr.importFailed"),
    });
    if (!res.ok) {
      setImportError(res.error || t("settings.form.arr.importFailed"));
      setImportStatus("error");
      return;
    }
    const wanted = res.data && typeof res.data === "object" ? (res.data as { wanted?: unknown }).wanted : undefined;
    setImportCount(typeof wanted === "number" ? wanted : 0);
    setImportStatus("ok");
  }

  return (
    <div className="border-t border-zinc-800 pt-5 space-y-2">
      <p className="text-sm font-medium text-zinc-300">{t("settings.form.arr.importTitle")}</p>
      <p className="text-xs text-zinc-500">
        {service === "radarr"
          ? t("settings.form.arr.importHelpMovies", { service: label })
          : t("settings.form.arr.importHelpTv", { service: label })}
      </p>
      <div className="flex items-center gap-3 pt-1">
        <Button
          type="button"
          onClick={handleImport}
          disabled={importStatus === "importing"}
          variant="outline"
          className="border-zinc-700 text-zinc-300 hover:text-zinc-100 hover:border-zinc-500"
        >
          {importStatus === "importing"
            ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />{t("settings.form.arr.importing")}</>
            : <><Download className="w-4 h-4 mr-2" />{t("settings.form.arr.importFrom", { service: label })}</>}
        </Button>
        {importStatus === "ok" && (
          <span role="status" aria-live="polite" className="flex items-center gap-1.5 text-sm text-green-400">
            <CheckCircle className="w-4 h-4" />
            {service === "radarr"
              ? t("settings.form.arr.pendingMovies", { count: importCount ?? 0 })
              : t("settings.form.arr.pendingShows", { count: importCount ?? 0 })}
          </span>
        )}
        {importStatus === "error" && (
          <span role="alert" aria-live="assertive" className="flex items-center gap-1.5 text-sm text-red-400">
            <XCircle className="w-4 h-4" />{importError}
          </span>
        )}
      </div>
    </div>
  );
}
