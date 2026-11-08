"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/design";
import { CheckCircle, XCircle, Loader2 } from "@/components/icons";
import { SaveStatusMessage } from "./save-status";
import { withBasePath } from "@/lib/base-path";
import { fetchJson } from "@/lib/client/fetch-json";
import { parseLibrarySelection, reconcileLibrarySelection } from "@/lib/client/library-selection";
import { librariesPath, parseLibraryItems, type LibraryItem, type LibraryService } from "@/lib/client/library-items";
import { runLibraryImport, type LibraryImportOutcome } from "@/lib/client/library-import";
import { useAsyncAction } from "@/hooks/use-async-action";
import { patchSettings, useSettingsSave, type LoadStatus, type SettingsPatchResult } from "./shared";
import { useT } from "@/components/i18n/i18n-provider";

// The pieces the default Plex and Jellyfin server forms (PlexConnectForm,
// JellyfinSyncForm) share: the library picker, the library list load, Save &
// Test, and the full import. One copy, so a fix lands in both.

const SERVER_NAME: Record<LibraryService, string> = { plex: "Plex", jellyfin: "Jellyfin" };

// A library list reaches the media server (with retries on Plex); give it room
// before calling it a failure.
const LIBRARIES_TIMEOUT_MS = 120_000;

// ── the library list ─────────────────────────────────────────────────────────

export type LibrariesLoad = { ok: boolean; count: number; error?: string; superseded?: boolean };

/**
 * The default server's library list. Only the newest load writes state: the
 * mount load can outlive a Save & Test (a stored server that doesn't answer
 * runs to its timeout) and would otherwise land last with the old server's
 * libraries or error. A newer load aborts the older one. `loadNewest` follows
 * a caller whose own load was overtaken to the newest one, which is what the
 * picker then shows.
 */
export function useLibraryLoader(service: LibraryService, autoLoad: boolean) {
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [status, setStatus] = useState<LoadStatus>(autoLoad ? "loading" : "idle");
  const [error, setError] = useState("");
  const loadSeq = useRef(0);
  const latestLoad = useRef<Promise<LibrariesLoad> | null>(null);
  const inFlight = useRef<AbortController | null>(null);

  const loadLibraries = useCallback((): Promise<LibrariesLoad> => {
    const seq = ++loadSeq.current;
    const superseded = () => seq !== loadSeq.current;
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    const load = (async (): Promise<LibrariesLoad> => {
      setStatus("loading");
      setError("");
      const res = await fetchJson(withBasePath(librariesPath(service)), { signal: controller.signal, timeoutMs: LIBRARIES_TIMEOUT_MS });
      if (superseded()) return { ok: false, count: 0, superseded: true };
      const listed = res.ok ? parseLibraryItems(service, res.data) : null;
      if (!listed) {
        // The route's own reason for a refusal; a network failure, a timeout or
        // an answer that isn't a library list gets the picker's generic line.
        const message = !res.ok && res.kind === "http" && res.error ? res.error : undefined;
        setError(message ?? "");
        setStatus("error");
        return { ok: false, count: 0, error: message };
      }
      setItems(listed);
      setStatus("loaded");
      return { ok: true, count: listed.length };
    })();
    latestLoad.current = load;
    return load;
  }, [service]);

  const loadNewest = useCallback(async (): Promise<LibrariesLoad> => {
    let result = await loadLibraries();
    // Another load started meanwhile (a later Save & Test, or the mount load
    // re-run): report the newest one, which is what the picker now shows.
    while (result.superseded && latestLoad.current) result = await latestLoad.current;
    return result;
  }, [loadLibraries]);

  useEffect(() => {
    if (autoLoad) void loadLibraries();
  }, [autoLoad, loadLibraries]);

  // Unmount: the load in flight writes nothing.
  useEffect(() => () => {
    loadSeq.current += 1;
    inFlight.current?.abort();
  }, []);

  return { items, status, error, loadNewest };
}

// ── Save & Test ──────────────────────────────────────────────────────────────

export type ServerSaveStatus = "idle" | "saving" | "testing" | "ok" | "error";

/**
 * Save the server's address (and key), then test it by listing its libraries.
 * The route's rule from forms/shared.ts carries over: an edit while the save or
 * test is in flight keeps Save locked, and its answer then reads "idle" — the
 * values on screen were never saved or tested — instead of "Connected".
 */
export function useServerSaveAndTest(service: LibraryService, loadNewest: () => Promise<LibrariesLoad>) {
  const t = useT();
  const [status, setStatus] = useState<ServerSaveStatus>("idle");
  const [message, setMessage] = useState("");
  const [librariesCount, setLibrariesCount] = useState<number | null>(null);
  const editSeq = useRef(0);
  // The "Connected" line's fade. Ref'd so an earlier Save & Test's timer can't
  // hide a later result early; cleared on unmount.
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (idleTimer.current) clearTimeout(idleTimer.current);
    };
  }, []);

  const edited = useCallback(() => {
    editSeq.current += 1;
    setStatus((s) => (s === "saving" || s === "testing" ? s : "idle"));
  }, []);

  /**
   * PATCH `body`, then test. `refusal` words a failed save from the answer.
   * Resolves whether the values were stored (true even when the test then
   * failed: the route saved them).
   */
  async function saveAndTest(body: Record<string, unknown>, refusal: (result: SettingsPatchResult) => string): Promise<boolean> {
    if (idleTimer.current) clearTimeout(idleTimer.current);
    const sentAt = editSeq.current;
    setStatus("saving");
    setMessage("");
    setLibrariesCount(null);
    const saved = await patchSettings(body);
    if (!mounted.current) return saved.ok;
    if (!saved.ok) {
      setMessage(refusal(saved));
      setStatus("error");
      return false;
    }
    setStatus("testing");
    const result = await loadNewest();
    if (!mounted.current) return true;
    if (editSeq.current !== sentAt) {
      // Edited since the click: the fields hold values this test never saw.
      setStatus("idle");
      return true;
    }
    if (result.ok) {
      setLibrariesCount(result.count);
      setStatus("ok");
      // Only clear an "ok" — a later Save & Test may already be in flight.
      idleTimer.current = setTimeout(() => setStatus((s) => (s === "ok" ? "idle" : s)), 4000);
    } else {
      setMessage(result.error ?? t("settings.form.library.connectFailed", { server: SERVER_NAME[service] }));
      setStatus("error");
    }
    return true;
  }

  return { status, message, librariesCount, edited, saveAndTest };
}

/** The Save & Test button's label, and its result line beside it. */
export function SaveAndTestLabel({ status }: { status: ServerSaveStatus }) {
  const t = useT();
  if (status === "saving") return <><Loader2 className="w-4 h-4 mr-2 animate-spin" />{t("settings.form.common.saving")}</>;
  if (status === "testing") return <><Loader2 className="w-4 h-4 mr-2 animate-spin" />{t("settings.form.common.testing")}</>;
  return <>{t("settings.form.common.saveAndTest")}</>;
}

export function SaveAndTestResult({ status, message, librariesCount }: { status: ServerSaveStatus; message: string; librariesCount: number | null }) {
  const t = useT();
  if (status === "ok") {
    return (
      <span role="status" aria-live="polite" className="flex items-center gap-1.5 text-sm text-green-400">
        <CheckCircle className="w-4 h-4" />
        {t("settings.form.common.connected")}
        {librariesCount !== null && (
          <span className="text-zinc-500">{t("settings.form.library.librariesLoaded", { count: librariesCount })}</span>
        )}
      </span>
    );
  }
  if (status === "error") {
    return (
      <span role="alert" aria-live="assertive" className="flex items-center gap-1.5 text-sm text-red-400">
        <XCircle className="w-4 h-4" />{message || t("settings.form.common.failed")}
      </span>
    );
  }
  return null;
}

// ── the full import ──────────────────────────────────────────────────────────

export type ImportState = { kind: "idle" } | { kind: "running" } | LibraryImportOutcome;

/**
 * One full sync of the default server, as a background job (library-import.ts).
 * A second click while one runs does nothing; unmount stops the polls.
 */
export function useLibraryImport(service: LibraryService) {
  const action = useAsyncAction();
  const [state, setState] = useState<ImportState>({ kind: "idle" });

  async function runImport() {
    setState({ kind: "running" });
    const outcome = await action.run(
      "import",
      (signal) => runLibraryImport(withBasePath(`/api/sync/${service}`), signal),
      { ifBusy: "skip" },
    );
    if (outcome) setState(outcome);
  }

  return { state, running: action.busy("import"), runImport };
}

/** The import's result line: counts, already running, no answer yet, or the route's reason. */
export function LibraryImportResult({ state, failedText }: { state: ImportState; failedText: string }) {
  const t = useT();
  switch (state.kind) {
    case "done":
      return (
        <span role="status" aria-live="polite" className="flex items-center gap-1.5 text-sm text-green-400">
          <CheckCircle className="w-4 h-4" />
          {t("settings.form.common.markedAvailable", { count: state.marked })}
          <span className="text-zinc-500">
            {t("settings.form.library.scanned", { movies: state.scanned.movies, tv: state.scanned.tv })}
          </span>
        </span>
      );
    case "busy":
      return (
        <span role="status" aria-live="polite" className="text-sm text-zinc-400">
          {t("settings.form.library.alreadyRunning")}
        </span>
      );
    case "noAnswer":
      return (
        <span role="status" aria-live="polite" className="text-sm text-zinc-400">
          {t("settings.form.library.noAnswer")}
        </span>
      );
    case "error":
      return (
        <span role="alert" aria-live="assertive" className="flex items-center gap-1.5 text-sm text-red-400">
          <XCircle className="w-4 h-4" />{state.error || failedText}
        </span>
      );
    default:
      return null;
  }
}

// ── the library picker ───────────────────────────────────────────────────────

interface LibraryPickerProps {
  service: LibraryService;
  initialSelected: string;
  items: LibraryItem[];
  loadStatus: LoadStatus;
  errorMessage: string;
  // The value a successful save stored, so a remount starts from it rather
  // than the page-load prop.
  onSaved: (value: string) => void;
}

export function LibraryPicker({ service, initialSelected, items, loadStatus, errorMessage, onSaved }: LibraryPickerProps) {
  const t = useT();
  const server = SERVER_NAME[service];
  const [selected, setSelected] = useState<Set<string>>(() => new Set(parseLibrarySelection(initialSelected)));
  // The ticked ids this server still lists. An id from a deleted library or an
  // earlier server has no checkbox, so it is neither shown nor saved (an
  // all-stale list would otherwise filter the sync down to nothing). Only read
  // once the list loaded: Save and the hint render only then.
  const effective = reconcileLibrarySelection(selected, items.map((i) => i.id));
  // `saveMessage` is the route's own reason (a 429 cooldown), shown in place of
  // the bare "Failed to save". A box ticked while a save is in flight keeps
  // Save locked (the save sent the boxes as they were) and the answer doesn't
  // call it saved.
  const { status: saveStatus, message: saveMessage, save, edited } = useSettingsSave();

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
    const listed = items.map((i) => i.id);
    const result = await save({ [service === "plex" ? "plexLibraries" : "jellyfinLibraries"]: value });
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
        <p className="text-xs text-zinc-500">{t("settings.form.library.loadHint", { server })}</p>
      )}
      {loadStatus === "loading" && (
        <p className="text-xs text-zinc-500 flex items-center gap-1.5">
          <Loader2 className="w-3 h-3 animate-spin" />{t("settings.form.library.loadingLibraries")}
        </p>
      )}
      {loadStatus === "error" && (
        <p className="text-xs text-red-400">{errorMessage || t("settings.form.library.connectFailed", { server })}</p>
      )}
      {loadStatus === "loaded" && (
        <>
          {items.length === 0 ? (
            <p className="text-xs text-zinc-500">{t("settings.form.library.noLibraries")}</p>
          ) : (
            <div className="space-y-2">
              {items.map((item) => (
                <label key={item.id} className="flex items-center gap-3 cursor-pointer group">
                  <input
                    type="checkbox"
                    checked={selected.has(item.id)}
                    onChange={() => toggle(item.id)}
                    className="w-4 h-4 rounded border-zinc-600 bg-zinc-800 accent-indigo-500"
                  />
                  <span className="text-sm text-zinc-300 group-hover:text-zinc-100 transition-colors">
                    {item.title}
                  </span>
                  <Chip tone="neutral">
                    {item.kind === "movie" ? t("search.filter.movies") : t("search.filter.tv")}
                  </Chip>
                </label>
              ))}
            </div>
          )}
          {effective.length === 0 && items.length > 0 && (
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
            <SaveStatusMessage status={saveStatus} errorLabel={saveMessage || t("settings.form.common.saveFailed")} />
          </div>
        </>
      )}
    </div>
  );
}
