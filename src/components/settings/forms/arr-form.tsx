"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CheckCircle, XCircle, Loader2, RefreshCw, Download } from "@/components/icons";
import { SaveStatusMessage } from "./save-status";
import { withBasePath } from "@/lib/base-path";
import type { SaveStatus, LoadStatus } from "./shared";

interface ArrFormProps {
  service: "radarr" | "sonarr";
  initialUrl: string;
  initialApiKey: string;
  initialRootFolder: string;
  initialQualityProfileId: string;
  // "4k" targets the optional second instance (radarr4k*/sonarr4k* keys).
  variant?: "hd" | "4k";
}

interface ArrOptions {
  rootFolders: { path: string }[];
  qualityProfiles: { id: number; name: string }[];
}

export function ArrForm({
  service,
  initialUrl,
  initialApiKey,
  initialRootFolder,
  initialQualityProfileId,
  variant = "hd",
}: ArrFormProps) {
  const v          = variant === "4k" ? "4k" : "";
  const label      = `${service === "radarr" ? "Radarr" : "Sonarr"}${variant === "4k" ? " 4K" : ""}`;
  const idPrefix   = `${service}${v}`;
  const urlKey     = `${service}${v}Url`;
  const keyKey     = `${service}${v}ApiKey`;
  const folderKey  = `${service}${v}RootFolder`;
  const profileKey = `${service}${v}QualityProfileId`;
  const versionKey = `${service}${v}Version`;

  const [url,    setUrl]    = useState(initialUrl);
  const [apiKey, setApiKey] = useState(initialApiKey);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [message, setMessage] = useState("");

  const [rootFolder,        setRootFolder]        = useState(initialRootFolder);
  const [qualityProfileId,  setQualityProfileId]  = useState(initialQualityProfileId);
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
        setMessage(version ? `Connected · v${version}` : "Saved");
        setStatus("ok");
        fetchOptions();
      } else {
        setMessage(data.error ?? "Failed to save");
        setStatus("error");
      }
    } catch {
      setMessage("Failed to save");
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
        body: JSON.stringify({ [folderKey]: rootFolder, [profileKey]: qualityProfileId }),
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
            <Label htmlFor={`${idPrefix}-url`}>{label} URL</Label>
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
            <Label htmlFor={`${idPrefix}-key`}>API Key</Label>
            <Input
              id={`${idPrefix}-key`}
              type="password"
              value={apiKey}
              onChange={(e) => { setApiKey(e.target.value); setStatus("idle"); }}
              placeholder="••••••••••••••••••••••••••••••••"
              className="bg-zinc-800 border-zinc-700 font-mono text-sm"
            />
            <p className="text-xs text-zinc-500">Found in {label} → Settings → General → Security</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={status === "saving" || !url || !apiKey} className="bg-indigo-600 hover:bg-indigo-500">
            {status === "saving" ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Saving…</> : "Save & Test"}
          </Button>
          <SaveStatusMessage status={status} okLabel={message} errorLabel={message} />
        </div>
      </form>

      {optionsStatus !== "idle" && (
        <div className="border-t border-zinc-800 pt-5 space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-zinc-300">Default Library Settings</p>
            <button
              type="button"
              onClick={fetchOptions}
              disabled={optionsStatus === "loading"}
              className="flex items-center gap-1 text-xs text-zinc-500 hover:text-white transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`w-3 h-3 ${optionsStatus === "loading" ? "animate-spin" : ""}`} />
              Refresh
            </button>
          </div>

          {optionsStatus === "error" && (
            <p className="text-sm text-red-400">Could not load options — check your connection above.</p>
          )}

          {optionsStatus === "loaded" && options && (
            <form onSubmit={handleSaveOptions} className="space-y-4">
              <div className="lg:grid lg:grid-cols-2 lg:gap-4 space-y-4 lg:space-y-0">
                <div className="space-y-1.5">
                  <Label htmlFor={`${idPrefix}-folder`}>Root Folder</Label>
                  <select
                    id={`${idPrefix}-folder`}
                    value={rootFolder}
                    onChange={(e) => setRootFolder(e.target.value)}
                    className="h-8 w-full rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  >
                    <option value="">— select a root folder —</option>
                    {options.rootFolders.map((f) => (
                      <option key={f.path} value={f.path}>{f.path}</option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`${idPrefix}-profile`}>Quality Profile</Label>
                  <select
                    id={`${idPrefix}-profile`}
                    value={qualityProfileId}
                    onChange={(e) => setQualityProfileId(e.target.value)}
                    className="h-8 w-full rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  >
                    <option value="">— select a quality profile —</option>
                    {options.qualityProfiles.map((p) => (
                      <option key={p.id} value={String(p.id)}>{p.name}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <Button
                  type="submit"
                  disabled={optionsSaveStatus === "saving" || !rootFolder || !qualityProfileId}
                  className="bg-indigo-600 hover:bg-indigo-500"
                >
                  {optionsSaveStatus === "saving" ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Saving…</> : "Save Defaults"}
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
  const label = service === "radarr" ? "Radarr" : "Sonarr";
  const [importStatus, setImportStatus] = useState<"idle" | "importing" | "ok" | "error">("idle");
  const [importCount, setImportCount] = useState<number | null>(null);
  const [importError, setImportError] = useState("");

  async function handleImport() {
    setImportStatus("importing");
    setImportError("");
    try {
      const res = await fetch(withBasePath(`/api/sync/${service}`), { method: "POST" });
      const data: { wanted?: number; error?: string } = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Import failed");
      setImportCount(data.wanted ?? 0);
      setImportStatus("ok");
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "Import failed");
      setImportStatus("error");
    }
  }

  return (
    <div className="border-t border-zinc-800 pt-5 space-y-2">
      <p className="text-sm font-medium text-zinc-300">Library Import</p>
      <p className="text-xs text-zinc-500">
        Scans your {label} library and caches which{" "}
        {service === "radarr" ? "movies are" : "TV shows are"} monitored but not yet downloaded.
        Run this once after connecting, then keep it up-to-date via the webhook or a scheduled sync.
      </p>
      <div className="flex items-center gap-3 pt-1">
        <Button
          type="button"
          onClick={handleImport}
          disabled={importStatus === "importing"}
          variant="outline"
          className="border-zinc-700 text-zinc-300 hover:text-white hover:border-zinc-500"
        >
          {importStatus === "importing"
            ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Importing…</>
            : <><Download className="w-4 h-4 mr-2" />Import from {label}</>}
        </Button>
        {importStatus === "ok" && (
          <span role="status" aria-live="polite" className="flex items-center gap-1.5 text-sm text-green-400">
            <CheckCircle className="w-4 h-4" />
            {importCount} {service === "radarr" ? "movie(s)" : "show(s)"} pending
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
