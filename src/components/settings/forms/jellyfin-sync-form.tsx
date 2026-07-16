"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CheckCircle, XCircle, Loader2, RefreshCcw } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import type { SaveStatus, LoadStatus } from "./shared";

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
      <p className="text-sm font-medium text-zinc-300">Library Selection</p>
      {loadStatus === "idle" && (
        <p className="text-xs text-zinc-500">Click &quot;Save &amp; Test&quot; to load libraries from your Jellyfin server.</p>
      )}
      {loadStatus === "loading" && (
        <p className="text-xs text-zinc-500 flex items-center gap-1.5">
          <Loader2 className="w-3 h-3 animate-spin" />Loading libraries…
        </p>
      )}
      {loadStatus === "error" && (
        <p className="text-xs text-red-400">{errorMessage || "Could not load Jellyfin libraries — check server URL and API key above."}</p>
      )}
      {loadStatus === "loaded" && (
        <>
          {folders.length === 0 ? (
            <p className="text-xs text-zinc-500">No movie or TV libraries found.</p>
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
                  <span className="text-sm text-zinc-200 group-hover:text-white transition-colors">
                    {f.name}
                  </span>
                  <span className="text-xs px-1.5 py-0.5 rounded bg-zinc-700 text-zinc-400">
                    {f.collectionType === "movies" ? "Movies" : "TV"}
                  </span>
                </label>
              ))}
            </div>
          )}
          {selected.size === 0 && folders.length > 0 && (
            <p className="text-xs text-zinc-500">No libraries selected — all libraries will be synced.</p>
          )}
          <div className="flex items-center gap-3 pt-1">
            <Button
              type="button"
              onClick={handleSave}
              disabled={saveStatus === "saving"}
              className="bg-indigo-600 hover:bg-indigo-500"
            >
              {saveStatus === "saving" ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Saving…</> : "Save Library Selection"}
            </Button>
            {saveStatus === "ok"    && <span className="flex items-center gap-1.5 text-sm text-green-400"><CheckCircle className="w-4 h-4" />Saved</span>}
            {saveStatus === "error" && <span className="flex items-center gap-1.5 text-sm text-red-400"><XCircle className="w-4 h-4" />Failed to save</span>}
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
        const message = body?.error ?? "Could not connect to Jellyfin server";
        setLibrariesError(message);
        setLibrariesStatus("error");
        return { ok: false, count: 0, error: message };
      }
      const data = (await res.json()) as JellyfinMediaFolder[];
      setFolders(data);
      setLibrariesStatus("loaded");
      return { ok: true, count: data.length };
    } catch {
      const message = "Could not connect to Jellyfin server";
      setLibrariesError(message);
      setLibrariesStatus("error");
      return { ok: false, count: 0, error: message };
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
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      saveOk = res.ok && body.ok !== false;
      if (!saveOk) {
        setSaveErrorMessage(body.error ?? "Failed to save");
      }
    } catch {
      setSaveErrorMessage("Failed to save");
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
      setSaveErrorMessage(result.error ?? "Could not connect to Jellyfin server");
      setSaveStatus("error");
    }
  }

  async function handleSync() {
    setSyncStatus("running");
    setSyncResult(null);
    try {
      const res = await fetch(withBasePath("/api/sync/jellyfin"), { method: "POST" });
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
            <Label htmlFor="jellyfin-url">Jellyfin Server URL</Label>
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
            <Label htmlFor="jellyfin-api-key">API Key</Label>
            <Input
              id="jellyfin-api-key"
              type="password"
              value={apiKey}
              onChange={(e) => { setApiKey(e.target.value); setSaveStatus("idle"); }}
              placeholder="Generate one in Jellyfin → Dashboard → API Keys"
              className="bg-zinc-800 border-zinc-700 font-mono text-sm"
            />
            <p className="text-xs text-zinc-500">
              Generate an API key under Jellyfin Dashboard → Advanced → API Keys.
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
              <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Saving…</>
            ) : saveStatus === "testing" ? (
              <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Testing…</>
            ) : (
              "Save & Test"
            )}
          </Button>
          {saveStatus === "ok" && (
            <span className="flex items-center gap-1.5 text-sm text-green-400">
              <CheckCircle className="w-4 h-4" />
              Connected
              {librariesCount !== null && (
                <span className="text-zinc-500">({librariesCount} {librariesCount === 1 ? "library" : "libraries"} loaded)</span>
              )}
            </span>
          )}
          {saveStatus === "error" && (
            <span className="flex items-center gap-1.5 text-sm text-red-400">
              <XCircle className="w-4 h-4" />{saveErrorMessage || "Failed"}
            </span>
          )}

          {url && apiKey && (
            <Button
              type="button"
              onClick={handleSync}
              disabled={syncStatus === "running"}
              variant="outline"
              className="border-zinc-700 text-zinc-300 hover:text-white"
            >
              {syncStatus === "running" ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Syncing…</>
              ) : (
                <><RefreshCcw className="w-4 h-4 mr-2" />Sync Library</>
              )}
            </Button>
          )}
        </div>

        {syncStatus === "done" && syncResult && (
          <span className="flex items-center gap-1.5 text-sm text-green-400">
            <CheckCircle className="w-4 h-4" />
            {syncResult.marked} marked available
            <span className="text-zinc-500">
              ({syncResult.scanned.movies} movies, {syncResult.scanned.tv} shows scanned)
            </span>
          </span>
        )}
        {syncStatus === "error" && (
          <span className="flex items-center gap-1.5 text-sm text-red-400">
            <XCircle className="w-4 h-4" />Sync failed — check server URL and API key
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
