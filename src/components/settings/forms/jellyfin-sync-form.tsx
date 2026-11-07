"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Chip } from "@/components/ui/design";
import { CheckCircle, XCircle, Loader2, RefreshCcw } from "@/components/icons";
import { SaveStatusMessage } from "./save-status";
import { withBasePath } from "@/lib/base-path";
import { parseLibrarySelection, reconcileLibrarySelection } from "@/lib/client/library-selection";
import { settingsPatchSucceeded, useSettingsSave, type LoadStatus } from "./shared";
import { useT } from "@/components/i18n/i18n-provider";

interface JellyfinMediaFolder {
  id: string;
  name: string;
  collectionType: string;
}

type LibrariesLoad = { ok: boolean; count: number; error?: string; superseded?: boolean };

interface JellyfinLibraryPickerProps {
  initialSelected: string;
  folders: JellyfinMediaFolder[];
  loadStatus: LoadStatus;
  errorMessage: string;
  // The value a successful save stored, so a remount starts from it rather
  // than the page-load prop.
  onSaved: (value: string) => void;
}

function JellyfinLibraryPicker({ initialSelected, folders, loadStatus, errorMessage, onSaved }: JellyfinLibraryPickerProps) {
  const t = useT();
  const [selected, setSelected] = useState<Set<string>>(() => new Set(parseLibrarySelection(initialSelected)));
  // The ticked ids this server still lists. An id from a deleted library or an
  // earlier server has no checkbox, so it is neither shown nor saved (an
  // all-stale list would otherwise filter the sync down to nothing). Only read
  // once the list loaded: Save and the hint render only then.
  const effective = reconcileLibrarySelection(selected, folders.map((f) => f.id));
  // Only the "Saved" tick fades; an error stays until the next change or save.
  // A box ticked while a save is in flight keeps Save locked (the save sent
  // the boxes as they were) and the answer doesn't call it saved.
  const { status: saveStatus, message: saveError, save, edited } = useSettingsSave();

  function toggle(id: string) {
    edited();
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleSave() {
    // "" (nothing ticked, or only stale ids) is sent too: it means every library.
    const value = effective.join(",");
    const listed = folders.map((f) => f.id);
    const result = await save({ jellyfinLibraries: value });
    if (result.ok) {
      // Forget the stale ids (keeping any box ticked since the click).
      setSelected((prev) => new Set(reconcileLibrarySelection(prev, listed)));
      onSaved(value);
    }
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
                  <Chip tone="neutral">
                    {f.collectionType === "movies" ? t("search.filter.movies") : t("search.filter.tv")}
                  </Chip>
                </label>
              ))}
            </div>
          )}
          {effective.length === 0 && folders.length > 0 && (
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
            <SaveStatusMessage status={saveStatus} errorLabel={saveError || undefined} />
          </div>
        </>
      )}
    </div>
  );
}

type SyncStatus = "idle" | "running" | "done" | "busy" | "error";

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
  const [syncError, setSyncError] = useState("");
  // Whether the server holds a SAVED Jellyfin URL + key. /api/sync/jellyfin
  // syncs the stored config, not what is typed in the fields, so the Sync
  // button must follow this and not the inputs: on a fresh install the typed,
  // unsaved credentials used to show a Sync button whose click answered
  // "server not configured" (guardrail 36 — decide configured-ness before the
  // request). Starts from the page-load props and flips after a successful save.
  const [configured, setConfigured] = useState(Boolean(initialUrl && initialApiKey));
  // Only the "Connected" line fades; an error stays until the next edit or
  // save. Ref'd so a second save cancels the first save's timer and unmount
  // clears it.
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current); }, []);

  const [folders, setFolders] = useState<JellyfinMediaFolder[]>([]);
  const [librariesStatus, setLibrariesStatus] = useState<LoadStatus>(
    initialUrl && initialApiKey ? "loading" : "idle",
  );
  const [librariesError, setLibrariesError] = useState<string>("");
  // The last library selection saved this session; a remounted picker starts
  // from it, not from the page-load value.
  const [savedLibraries, setSavedLibraries] = useState(initialJellyfinLibraries);

  // Only the newest load writes state. The mount load can outlive a save of a
  // new URL or key (an old server that doesn't answer runs to its timeout) and
  // would otherwise land last with the old server's folders or error.
  // latestLoad is that newest load, for a caller whose own load was overtaken.
  const loadSeq = useRef(0);
  const latestLoad = useRef<Promise<LibrariesLoad> | null>(null);
  const loadLibraries = useCallback((): Promise<LibrariesLoad> => {
    const seq = ++loadSeq.current;
    const superseded = () => seq !== loadSeq.current;
    const load = (async (): Promise<LibrariesLoad> => {
      setLibrariesStatus("loading");
      setLibrariesError("");
      try {
        const res = await fetch(withBasePath("/api/settings/jellyfin/libraries"));
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          if (superseded()) return { ok: false, count: 0, superseded: true };
          const message = body?.error;
          setLibrariesError(message ?? "");
          setLibrariesStatus("error");
          return { ok: false, count: 0, error: message };
        }
        const data = (await res.json()) as JellyfinMediaFolder[];
        if (superseded()) return { ok: false, count: 0, superseded: true };
        setFolders(data);
        setLibrariesStatus("loaded");
        return { ok: true, count: data.length };
      } catch {
        if (superseded()) return { ok: false, count: 0, superseded: true };
        setLibrariesError("");
        setLibrariesStatus("error");
        return { ok: false, count: 0 };
      }
    })();
    latestLoad.current = load;
    return load;
  }, []);

  useEffect(() => {
    if (initialUrl && initialApiKey) {
      void loadLibraries();
    }
  }, [initialUrl, initialApiKey, loadLibraries]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (saveTimer.current) clearTimeout(saveTimer.current);
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
      saveOk = settingsPatchSucceeded(res, body);
      if (!saveOk) {
        // A 422 with `jellyfinError` means the server tested the new URL/key
        // before writing and the test failed — nothing was saved.
        setSaveErrorMessage(body.jellyfinError ?? body.error ?? t("settings.form.common.saveFailed"));
      }
    } catch {
      setSaveErrorMessage(t("settings.form.common.saveFailed"));
    }
    if (!saveOk) {
      setSaveStatus("error");
      return;
    }
    // The route only answers ok after its own connection test passed and the
    // values were written, so the stored config is now usable by Sync.
    setConfigured(true);

    setSaveStatus("testing");
    let result = await loadLibraries();
    // Another load started meanwhile (a later Save & Test, or the mount load
    // re-run): report the newest one, which is what the picker now shows.
    while (result.superseded && latestLoad.current) result = await latestLoad.current;
    if (result.ok) {
      setLibrariesCount(result.count);
      setSaveStatus("ok");
      saveTimer.current = setTimeout(() => setSaveStatus("idle"), 4000);
    } else {
      setSaveErrorMessage(result.error ?? t("settings.form.library.connectFailed", { server: "Jellyfin" }));
      setSaveStatus("error");
    }
  }

  async function handleSync() {
    setSyncStatus("running");
    setSyncResult(null);
    setSyncError("");
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
      const body = (await res.json().catch(() => ({}))) as
        | { marked: number; scanned: { movies: number; tv: number } }
        | { error?: string; skipped?: boolean };
      // 200 { skipped: true }: a sync of this server is already running.
      if (res.ok && "skipped" in body && body.skipped === true) {
        setSyncStatus("busy");
        return;
      }
      if (!res.ok || !("marked" in body)) {
        // Show the server's own reason (429, the not-configured message)
        // instead of one fixed sentence that blames the credentials for every
        // failure.
        setSyncError("error" in body && typeof body.error === "string" ? body.error : "");
        setSyncStatus("error");
        return;
      }
      setSyncResult(body);
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
              className="bg-zinc-800 border-zinc-700 font-mono"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="jellyfin-api-key">{t("settings.form.common.apiKey")}</Label>
            <Input
              id="jellyfin-api-key"
              type="password"
              autoComplete="new-password"
              data-1p-ignore
              data-lpignore="true"
              value={apiKey}
              onChange={(e) => { setApiKey(e.target.value); setSaveStatus("idle"); }}
              placeholder={t("settings.form.jellyfin.apiKeyPlaceholder")}
              className="bg-zinc-800 border-zinc-700 font-mono"
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

          {configured && (
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
        {syncStatus === "busy" && (
          <span role="status" aria-live="polite" className="text-sm text-zinc-400">
            {t("settings.form.library.alreadyRunning")}
          </span>
        )}
        {syncStatus === "error" && (
          <span role="alert" aria-live="assertive" className="flex items-center gap-1.5 text-sm text-red-400">
            <XCircle className="w-4 h-4" />{syncError || t("settings.form.jellyfin.syncFailed")}
          </span>
        )}
      </form>

      {/* The picker lists the SAVED server's libraries, so it follows the saved
          config like the Sync button does — not the inputs, whose clearing (to
          retype the masked key) used to unmount it (guardrail 36). */}
      {configured && (
        <JellyfinLibraryPicker
          initialSelected={savedLibraries}
          folders={folders}
          loadStatus={librariesStatus}
          errorMessage={librariesError}
          onSaved={setSavedLibraries}
        />
      )}
    </div>
  );
}
