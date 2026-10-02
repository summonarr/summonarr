"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CheckCircle, XCircle, Loader2, RefreshCw, Download } from "@/components/icons";
import { SaveStatusMessage } from "./save-status";
import { withBasePath } from "@/lib/base-path";
import type { SaveStatus, LoadStatus } from "./shared";
import { useT } from "@/components/i18n/i18n-provider";

interface ArrFormProps {
  service: "radarr" | "sonarr";
  initialUrl: string;
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

interface ArrOptions {
  rootFolders: { path: string }[];
  qualityProfiles: { id: number; name: string }[];
  // Only sent back by Sonarr v3; missing for Sonarr v4 and for Radarr.
  languageProfiles?: { id: number; name: string }[];
}

// Radarr's closed enum for when a movie counts as "available" to search.
const MINIMUM_AVAILABILITY_OPTIONS = [
  { value: "announced", labelKey: "settings.form.arr.minAvail.announced" },
  { value: "inCinemas", labelKey: "settings.form.arr.minAvail.inCinemas" },
  { value: "released", labelKey: "settings.form.arr.minAvail.released" },
] as const;

export function ArrForm({
  service,
  initialUrl,
  initialApiKey,
  initialRootFolder,
  initialQualityProfileId,
  initialMinimumAvailability = "",
  initialLanguageProfileId = "",
  variant = "hd",
}: ArrFormProps) {
  const t = useT();
  const v          = variant === "4k" ? "4k" : "";
  const label      = `${service === "radarr" ? "Radarr" : "Sonarr"}${variant === "4k" ? " 4K" : ""}`;
  const idPrefix   = `${service}${v}`;
  const urlKey     = `${service}${v}Url`;
  const keyKey     = `${service}${v}ApiKey`;
  const folderKey  = `${service}${v}RootFolder`;
  const profileKey = `${service}${v}QualityProfileId`;
  const minAvailKey = `${service}${v}MinimumAvailability`;
  const langKey    = `${service}${v}LanguageProfileId`;
  const versionKey = `${service}${v}Version`;
  // When the connection test fails, /api/settings replies 422 with the reason
  // under a key like `radarrError` / `sonarr4kError` (not the usual `error`),
  // so we read that key first. email-form does the same with `smtpError`.
  const errorKey   = `${service}${v}Error`;

  const [url,    setUrl]    = useState(initialUrl);
  const [apiKey, setApiKey] = useState(initialApiKey);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [message, setMessage] = useState("");

  const [rootFolder,        setRootFolder]        = useState(initialRootFolder);
  const [qualityProfileId,  setQualityProfileId]  = useState(initialQualityProfileId);
  const [minimumAvailability, setMinimumAvailability] = useState(initialMinimumAvailability);
  const [languageProfileId, setLanguageProfileId] = useState(initialLanguageProfileId);
  const [options,           setOptions]           = useState<ArrOptions | null>(null);
  const [optionsStatus,     setOptionsStatus]     = useState<LoadStatus>("idle");
  const [optionsSaveStatus, setOptionsSaveStatus] = useState<SaveStatus>("idle");

  const fetchOptions = useCallback(async () => {
    setOptionsStatus("loading");
    try {
      const res = await fetch(withBasePath(`/api/settings/arr-options?service=${service}${variant === "4k" ? "&variant=4k" : ""}`));
      if (!res.ok) throw new Error();
      const data: ArrOptions = await res.json();
      setOptions(data);
      setOptionsStatus("loaded");
    } catch {
      setOptionsStatus("error");
    }
  }, [service, variant]);

  useEffect(() => {
    if (initialUrl && initialApiKey) {
      fetchOptions();
    }
  }, [initialUrl, initialApiKey, fetchOptions]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setStatus("saving");
    setMessage("");

    try {
      const res = await fetch(withBasePath("/api/settings"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [urlKey]: url, [keyKey]: apiKey }),
      });

      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string } & Record<string, string | undefined>;

      if (res.ok && data.ok) {
        const version = data[versionKey];
        setMessage(version ? t("settings.form.arr.connectedVersion", { version }) : t("settings.form.common.saved"));
        setStatus("ok");
        fetchOptions();
      } else {
        setMessage(data[errorKey] ?? data.error ?? t("settings.form.common.saveFailed"));
        setStatus("error");
      }
    } catch {
      setMessage(t("settings.form.common.saveFailed"));
      setStatus("error");
    }
  }

  async function handleSaveOptions(e: React.FormEvent) {
    e.preventDefault();
    setOptionsSaveStatus("saving");
    try {
      const res = await fetch(withBasePath("/api/settings"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          [folderKey]: rootFolder,
          [profileKey]: qualityProfileId,
          // Sending "" clears the saved value, so new adds stop including the
          // field and Radarr/Sonarr fall back to their own default.
          ...(service === "radarr" ? { [minAvailKey]: minimumAvailability } : {}),
          ...(service === "sonarr" && options?.languageProfiles?.length ? { [langKey]: languageProfileId } : {}),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      setOptionsSaveStatus(res.ok && data.ok !== false ? "ok" : "error");
    } catch {
      setOptionsSaveStatus("error");
    }
    setTimeout(() => setOptionsSaveStatus("idle"), 3000);
  }

  return (
    <div className="space-y-6">
      <form onSubmit={handleSave} className="space-y-4">
        <div className="lg:grid lg:grid-cols-2 lg:gap-4 space-y-4 lg:space-y-0">
          <div className="space-y-1.5">
            <Label htmlFor={`${idPrefix}-url`}>{t("settings.form.arr.url", { service: label })}</Label>
            <Input
              id={`${idPrefix}-url`}
              type="url"
              value={url}
              onChange={(e) => { setUrl(e.target.value); setStatus("idle"); }}
              placeholder="http://radarr:7878"
              className="bg-zinc-800 border-zinc-700 font-mono text-sm"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${idPrefix}-key`}>{t("settings.form.common.apiKey")}</Label>
            <Input
              id={`${idPrefix}-key`}
              type="password"
              value={apiKey}
              onChange={(e) => { setApiKey(e.target.value); setStatus("idle"); }}
              placeholder="••••••••••••••••••••••••••••••••"
              className="bg-zinc-800 border-zinc-700 font-mono text-sm"
            />
            <p className="text-xs text-zinc-500">{t("settings.form.arr.apiKeyHelp", { service: label })}</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={status === "saving" || !url || !apiKey} className="bg-indigo-600 hover:bg-indigo-500">
            {status === "saving" ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />{t("settings.form.common.saving")}</> : t("settings.form.common.saveAndTest")}
          </Button>
          <SaveStatusMessage status={status} okLabel={message} errorLabel={message} />
        </div>
      </form>

      {optionsStatus !== "idle" && (
        <div className="border-t border-zinc-800 pt-5 space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-zinc-300">{t("settings.form.arr.defaults")}</p>
            <button
              type="button"
              onClick={fetchOptions}
              disabled={optionsStatus === "loading"}
              className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-100 transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`w-3 h-3 ${optionsStatus === "loading" ? "animate-spin" : ""}`} />
              {t("settings.form.arr.refresh")}
            </button>
          </div>

          {optionsStatus === "error" && (
            <p className="text-sm text-red-400">{t("settings.form.arr.optionsFailed")}</p>
          )}

          {optionsStatus === "loaded" && options && (
            <form onSubmit={handleSaveOptions} className="space-y-4">
              <div className="lg:grid lg:grid-cols-2 lg:gap-4 space-y-4 lg:space-y-0">
                <div className="space-y-1.5">
                  <Label htmlFor={`${idPrefix}-folder`}>{t("settings.form.arr.rootFolder")}</Label>
                  <select
                    id={`${idPrefix}-folder`}
                    value={rootFolder}
                    onChange={(e) => setRootFolder(e.target.value)}
                    className="h-8 w-full rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  >
                    <option value="">{t("settings.form.arr.selectRootFolder")}</option>
                    {/* If the saved folder no longer exists on the server, the
                        dropdown would show the placeholder while still holding the
                        old value (and Save Defaults stays enabled). Show it as its
                        own option so the admin can see it. Same as arr-instances-manager. */}
                    {rootFolder && !options.rootFolders.some((f) => f.path === rootFolder) && (
                      <option value={rootFolder}>{t("settings.form.arr.folderNotFound", { folder: rootFolder })}</option>
                    )}
                    {options.rootFolders.map((f) => (
                      <option key={f.path} value={f.path}>{f.path}</option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`${idPrefix}-profile`}>{t("settings.form.arr.qualityProfile")}</Label>
                  <select
                    id={`${idPrefix}-profile`}
                    value={qualityProfileId}
                    onChange={(e) => setQualityProfileId(e.target.value)}
                    className="h-8 w-full rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  >
                    <option value="">{t("settings.form.arr.selectQualityProfile")}</option>
                    {qualityProfileId && !options.qualityProfiles.some((p) => String(p.id) === qualityProfileId) && (
                      <option value={qualityProfileId}>{t("settings.form.arr.profileNotFound", { id: qualityProfileId })}</option>
                    )}
                    {options.qualityProfiles.map((p) => (
                      <option key={p.id} value={String(p.id)}>{p.name}</option>
                    ))}
                  </select>
                </div>

                {service === "radarr" && (
                  <div className="space-y-1.5">
                    <Label htmlFor={`${idPrefix}-min-availability`}>{t("settings.form.arr.minimumAvailability")}</Label>
                    <select
                      id={`${idPrefix}-min-availability`}
                      value={minimumAvailability}
                      onChange={(e) => setMinimumAvailability(e.target.value)}
                      className="h-8 w-full rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    >
                      <option value="">{t("settings.form.arr.serviceDefault", { service: label })}</option>
                      {MINIMUM_AVAILABILITY_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>{t(o.labelKey)}</option>
                      ))}
                    </select>
                    <p className="text-xs text-zinc-500">
                      {t("settings.form.arr.minimumAvailabilityHelp")}
                    </p>
                  </div>
                )}

                {/* Sonarr v3 only. v4 removed language profiles, so the options
                    endpoint returns no list and this dropdown never shows. */}
                {service === "sonarr" && (options.languageProfiles?.length ?? 0) > 0 && (
                  <div className="space-y-1.5">
                    <Label htmlFor={`${idPrefix}-language-profile`}>{t("settings.form.arr.languageProfile")}</Label>
                    <select
                      id={`${idPrefix}-language-profile`}
                      value={languageProfileId}
                      onChange={(e) => setLanguageProfileId(e.target.value)}
                      className="h-8 w-full rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    >
                      <option value="">{t("settings.form.arr.serviceDefault", { service: label })}</option>
                      {languageProfileId && !options.languageProfiles!.some((p) => String(p.id) === languageProfileId) && (
                        <option value={languageProfileId}>{t("settings.form.arr.profileNotFound", { id: languageProfileId })}</option>
                      )}
                      {options.languageProfiles!.map((p) => (
                        <option key={p.id} value={String(p.id)}>{p.name}</option>
                      ))}
                    </select>
                    <p className="text-xs text-zinc-500">
                      {t("settings.form.arr.languageProfileHelp")}
                    </p>
                  </div>
                )}
              </div>
              <div className="flex items-center gap-3">
                <Button
                  type="submit"
                  disabled={optionsSaveStatus === "saving" || !rootFolder || !qualityProfileId}
                  className="bg-indigo-600 hover:bg-indigo-500"
                >
                  {optionsSaveStatus === "saving" ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />{t("settings.form.common.saving")}</> : t("settings.form.arr.saveDefaults")}
                </Button>
                <SaveStatusMessage status={optionsSaveStatus} />
              </div>
            </form>
          )}
        </div>
      )}

      {optionsStatus === "loaded" && variant !== "4k" && (
        <ArrImportSection service={service} />
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
    try {
      const res = await fetch(withBasePath(`/api/sync/${service}`), { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { wanted?: number; error?: string };
      if (!res.ok) throw new Error(data.error ?? t("settings.form.arr.importFailed"));
      setImportCount(data.wanted ?? 0);
      setImportStatus("ok");
    } catch (err) {
      setImportError(err instanceof Error ? err.message : t("settings.form.arr.importFailed"));
      setImportStatus("error");
    }
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
