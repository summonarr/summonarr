"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CheckCircle, XCircle, Loader2, RefreshCcw } from "@/components/icons";
import { SaveStatusMessage } from "./save-status";
import { withBasePath } from "@/lib/base-path";
import type { SaveStatus, LoadStatus } from "./shared";
import { useT } from "@/components/i18n/i18n-provider";

interface JellyfinMediaFolder {
  id: string;
  name: string;
  collectionType: string;
}

interface JellyfinLibraryPickerProps {
  initialSelected: string;
  folders: JellyfinMediaFolder[];
  loadStatus: LoadStatus;
  errorMessage: string;
}

function JellyfinLibraryPicker({ initialSelected, folders, loadStatus, errorMessage }: JellyfinLibraryPickerProps) {
  const t = useT();
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(initialSelected.split(",").map((k) => k.trim()).filter(Boolean))
  );
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleSave() {
    setSaveStatus("saving");
    try {
      const res = await fetch(withBasePath("/api/settings"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jellyfinLibraries: Array.from(selected).join(",") }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean };
      setSaveStatus(res.ok && data.ok !== false ? "ok" : "error");
    } catch {
      setSaveStatus("error");
    }
    setTimeout(() => setSaveStatus("idle"), 3000);
  }

  return (
    <div className="border-t border-zinc-800 pt-4 space-y-3">
      <p className="text-sm font-medium text-zinc-300">{t("settings.form.library.librarySelection")}</p>
      {loadStatus === "idle" && (
        <p className="text-xs text-zinc-500">{t("settings.form.library.loadHint", { server: "Jellyfin" })}</p>
      )}
      {loadStatus === "loading" && (
        <p className="text-xs text-zinc-500 flex items-center gap-1.5">
          <Loader2 className="w-3 h-3 animate-spin" />{t("settings.form.library.loadingLibraries")}
        </p>
      )}
      {loadStatus === "error" && (
        <p className="text-xs text-red-400">{errorMessage || t("settings.form.library.connectFailed", { server: "Jellyfin" })}</p>
      )}
      {loadStatus === "loaded" && (
        <>
          {folders.length === 0 ? (
            <p className="text-xs text-zinc-500">{t("settings.form.library.noLibraries")}</p>
          ) : (
            <div className="space-y-2">
              {folders.map((f) => (
                <label key={f.id} className="flex items-center gap-3 cursor-pointer group">
                  <input
                    type="checkbox"
                    checked={selected.has(f.id)}
                    onChange={() => toggle(f.id)}
                    className="w-4 h-4 rounded border-zinc-600 bg-zinc-800 accent-indigo-500"
                  />
                  <span className="text-sm text-zinc-300 group-hover:text-zinc-100 transition-colors">
                    {f.name}
                  </span>
                  <span className="text-xs px-1.5 py-0.5 rounded bg-zinc-700 text-zinc-400">
                    {f.collectionType === "movies" ? t("search.filter.movies") : t("search.filter.tv")}
                  </span>
                </label>
              ))}
            </div>
          )}
          {selected.size === 0 && folders.length > 0 && (
            <p className="text-xs text-zinc-500">{t("settings.form.library.noneSelected")}</p>
          )}
          <div className="flex items-center gap-3 pt-1">
            <Button
              type="button"
              onClick={handleSave}
              disabled={saveStatus === "saving"}
              className="bg-indigo-600 hover:bg-indigo-500"
            >
              {saveStatus === "saving" ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />{t("settings.form.common.saving")}</> : t("settings.form.library.saveSelection")}
            </Button>
            <SaveStatusMessage status={saveStatus} />
          </div>
        </>
      )}
    </div>
  );
}

type SyncStatus = "idle" | "running" | "done" | "error";

interface JellyfinSyncFormProps {
  initialUrl: string;
  initialApiKey: string;
  initialJellyfinLibraries: string;
}

export function JellyfinSyncForm({ initialUrl, initialApiKey, initialJellyfinLibraries }: JellyfinSyncFormProps) {
  const t = useT();
  const [url,    setUrl]    = useState(initialUrl);
  const [apiKey, setApiKey] = useState(initialApiKey);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "testing" | "ok" | "error">("idle");
  const [saveErrorMessage, setSaveErrorMessage] = useState<string>("");
  const [librariesCount, setLibrariesCount] = useState<number | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("idle");
  const [syncResult, setSyncResult] = useState<{ marked: number; scanned: { movies: number; tv: number } } | null>(null);

  const [folders, setFolders] = useState<JellyfinMediaFolder[]>([]);
  const [librariesStatus, setLibrariesStatus] = useState<LoadStatus>(
    initialUrl && initialApiKey ? "loading" : "idle",
  );
  const [librariesError, setLibrariesError] = useState<string>("");

  const loadLibraries = useCallback(async (): Promise<{ ok: boolean; count: number; error?: string }> => {
    setLibrariesStatus("loading");
    setLibrariesError("");
    try {
      const res = await fetch(withBasePath("/api/settings/jellyfin/libraries"));
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        const message = body?.error;
        setLibrariesError(message ?? "");
        setLibrariesStatus("error");
        return { ok: false, count: 0, error: message };
      }
      const data = (await res.json()) as JellyfinMediaFolder[];
      setFolders(data);
      setLibrariesStatus("loaded");
      return { ok: true, count: data.length };
    } catch {
      setLibrariesError("");
      setLibrariesStatus("error");
      return { ok: false, count: 0 };
    }
  }, []);

  useEffect(() => {
    if (initialUrl && initialApiKey) {
      void loadLibraries();
    }
  }, [initialUrl, initialApiKey, loadLibraries]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaveStatus("saving");
    setSaveErrorMessage("");
    setLibrariesCount(null);

    let saveOk = false;
    try {
      const res = await fetch(withBasePath("/api/settings"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jellyfinUrl: url, jellyfinApiKey: apiKey }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; jellyfinError?: string };
      saveOk = res.ok && body.ok !== false;
      if (!saveOk) {
        // A 422 with `jellyfinError` means the server tried the new URL/key, the
        // test failed, and it put the old settings back — nothing was saved.
        setSaveErrorMessage(body.jellyfinError ?? body.error ?? t("settings.form.common.saveFailed"));
      }
    } catch {
      setSaveErrorMessage(t("settings.form.common.saveFailed"));
    }
    if (!saveOk) {
      setSaveStatus("error");
      return;
    }

    setSaveStatus("testing");
    const result = await loadLibraries();
    if (result.ok) {
      setLibrariesCount(result.count);
      setSaveStatus("ok");
      setTimeout(() => setSaveStatus("idle"), 4000);
    } else {
      setSaveErrorMessage(result.error ?? t("settings.form.library.connectFailed", { server: "Jellyfin" }));
      setSaveStatus("error");
    }
  }

  async function handleSync() {
    setSyncStatus("running");
    setSyncResult(null);
    try {
      // { full: true } asks for a full sync: delete this server's library rows
      // and rebuild them (like the Plex form's "Import from Plex" button).
      // Without it the route only adds items changed in the last 2 hours and
      // never removes old rows, so it could not fix a library that is out of date.
      const res = await fetch(withBasePath("/api/sync/jellyfin"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ full: true }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data: { marked: number; scanned: { movies: number; tv: number } } = await res.json();
      setSyncResult(data);
      setSyncStatus("done");
    } catch {
      setSyncStatus("error");
    }
  }

  return (
    <div className="space-y-4">
      <form onSubmit={handleSave} className="space-y-4">
        <div className="lg:grid lg:grid-cols-2 lg:gap-4 space-y-4 lg:space-y-0">
          <div className="space-y-1.5">
            <Label htmlFor="jellyfin-url">{t("settings.form.jellyfin.serverUrl")}</Label>
            <Input
              id="jellyfin-url"
              type="url"
              value={url}
              onChange={(e) => { setUrl(e.target.value); setSaveStatus("idle"); }}
              placeholder="http://192.168.1.100:8096"
              className="bg-zinc-800 border-zinc-700 font-mono text-sm"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="jellyfin-api-key">{t("settings.form.common.apiKey")}</Label>
            <Input
              id="jellyfin-api-key"
              type="password"
              value={apiKey}
              onChange={(e) => { setApiKey(e.target.value); setSaveStatus("idle"); }}
              placeholder={t("settings.form.jellyfin.apiKeyPlaceholder")}
              className="bg-zinc-800 border-zinc-700 font-mono text-sm"
            />
            <p className="text-xs text-zinc-500">
              {t("settings.form.jellyfin.apiKeyHelp")}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <Button
            type="submit"
            disabled={saveStatus === "saving" || saveStatus === "testing" || !url || !apiKey}
            className="bg-indigo-600 hover:bg-indigo-500"
          >
            {saveStatus === "saving" ? (
              <><Loader2 className="w-4 h-4 mr-2 animate-spin" />{t("settings.form.common.saving")}</>
            ) : saveStatus === "testing" ? (
              <><Loader2 className="w-4 h-4 mr-2 animate-spin" />{t("settings.form.common.testing")}</>
            ) : (
              t("settings.form.common.saveAndTest")
            )}
          </Button>
          {saveStatus === "ok" && (
            <span role="status" aria-live="polite" className="flex items-center gap-1.5 text-sm text-green-400">
              <CheckCircle className="w-4 h-4" />
              {t("settings.form.common.connected")}
              {librariesCount !== null && (
                <span className="text-zinc-500">{t("settings.form.library.librariesLoaded", { count: librariesCount })}</span>
              )}
            </span>
          )}
          {saveStatus === "error" && (
            <span role="alert" aria-live="assertive" className="flex items-center gap-1.5 text-sm text-red-400">
              <XCircle className="w-4 h-4" />{saveErrorMessage || t("settings.form.common.failed")}
            </span>
          )}

          {url && apiKey && (
            <Button
              type="button"
              onClick={handleSync}
              disabled={syncStatus === "running"}
              variant="outline"
              className="border-zinc-700 text-zinc-300 hover:text-zinc-100"
            >
              {syncStatus === "running" ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" />{t("settings.form.common.syncing")}</>
              ) : (
                <><RefreshCcw className="w-4 h-4 mr-2" />{t("settings.form.jellyfin.syncLibrary")}</>
              )}
            </Button>
          )}
        </div>

        {syncStatus === "done" && syncResult && (
          <span role="status" aria-live="polite" className="flex items-center gap-1.5 text-sm text-green-400">
            <CheckCircle className="w-4 h-4" />
            {t("settings.form.common.markedAvailable", { count: syncResult.marked })}
            <span className="text-zinc-500">
              {t("settings.form.library.scanned", { movies: syncResult.scanned.movies, tv: syncResult.scanned.tv })}
            </span>
          </span>
        )}
        {syncStatus === "error" && (
          <span role="alert" aria-live="assertive" className="flex items-center gap-1.5 text-sm text-red-400">
            <XCircle className="w-4 h-4" />{t("settings.form.jellyfin.syncFailed")}
          </span>
        )}
      </form>

      {url && apiKey && (
        <JellyfinLibraryPicker
          initialSelected={initialJellyfinLibraries}
          folders={folders}
          loadStatus={librariesStatus}
          errorMessage={librariesError}
        />
      )}
    </div>
  );
}
