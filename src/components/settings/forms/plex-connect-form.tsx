"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CheckCircle, XCircle, Loader2, Unlink, Download } from "@/components/icons";
import { SaveStatusMessage } from "./save-status";
import { withBasePath } from "@/lib/base-path";
import type { SaveStatus, LoadStatus } from "./shared";

interface PlexSection {
  key: string;
  title: string;
  type: "movie" | "show";
}

interface PlexLibraryPickerProps {
  initialSelected: string;
  sections: PlexSection[];
  loadStatus: LoadStatus;
  errorMessage: string;
}

function PlexLibraryPicker({ initialSelected, sections, loadStatus, errorMessage }: PlexLibraryPickerProps) {
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(initialSelected.split(",").map((k) => k.trim()).filter(Boolean))
  );
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");

  function toggle(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function handleSave() {
    setSaveStatus("saving");
    try {
      const res = await fetch(withBasePath("/api/settings"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plexLibraries: Array.from(selected).join(",") }),
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
        <p className="text-xs text-zinc-500">Click &quot;Save &amp; Test&quot; to load libraries from your Plex server.</p>
      )}
      {loadStatus === "loading" && (
        <p className="text-xs text-zinc-500 flex items-center gap-1.5">
          <Loader2 className="w-3 h-3 animate-spin" />Loading libraries…
        </p>
      )}
      {loadStatus === "error" && (
        <p className="text-xs text-red-400">{errorMessage || "Could not load Plex libraries — check server URL above."}</p>
      )}
      {loadStatus === "loaded" && (
        <>
          {sections.length === 0 ? (
            <p className="text-xs text-zinc-500">No movie or TV libraries found.</p>
          ) : (
            <div className="space-y-2">
              {sections.map((s) => (
                <label key={s.key} className="flex items-center gap-3 cursor-pointer group">
                  <input
                    type="checkbox"
                    checked={selected.has(s.key)}
                    onChange={() => toggle(s.key)}
                    className="w-4 h-4 rounded border-zinc-600 bg-zinc-800 accent-indigo-500"
                  />
                  <span className="text-sm text-zinc-200 group-hover:text-white transition-colors">
                    {s.title}
                  </span>
                  <span className="text-xs px-1.5 py-0.5 rounded bg-zinc-700 text-zinc-400">
                    {s.type === "movie" ? "Movies" : "TV"}
                  </span>
                </label>
              ))}
            </div>
          )}
          {selected.size === 0 && sections.length > 0 && (
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
            <SaveStatusMessage status={saveStatus} />
          </div>
        </>
      )}
    </div>
  );
}

interface PlexConnectFormProps {
  initialEmail: string;
  initialServerUrl: string;
  initialPlexLibraries: string;
  siteUrl: string;
}

// Plex connection uses PIN-based OAuth; the admin token is stored in the Setting table, not an env var
export function PlexConnectForm({ initialEmail, initialServerUrl, initialPlexLibraries, siteUrl }: PlexConnectFormProps) {
  const [connectedEmail, setConnectedEmail] = useState(initialEmail);
  const [status, setStatus] = useState<"idle" | "waiting" | "saving" | "error">("idle");
  const [error, setError] = useState("");

  const [serverUrl, setServerUrl] = useState(initialServerUrl);
  const [serverStatus, setServerStatus] = useState<"idle" | "saving" | "testing" | "ok" | "error">("idle");
  const [serverErrorMessage, setServerErrorMessage] = useState<string>("");
  const [librariesCount, setLibrariesCount] = useState<number | null>(null);
  const [importStatus, setImportStatus] = useState<"idle" | "running" | "done" | "error">("idle");
  const [importResult, setImportResult] = useState<{ marked: number; scanned: { movies: number; tv: number } } | null>(null);

  const [sections, setSections] = useState<PlexSection[]>([]);
  const [librariesStatus, setLibrariesStatus] = useState<LoadStatus>(
    initialEmail && initialServerUrl ? "loading" : "idle",
  );
  const [librariesError, setLibrariesError] = useState<string>("");

  const loadLibraries = useCallback(async (): Promise<{ ok: boolean; count: number; error?: string }> => {
    setLibrariesStatus("loading");
    setLibrariesError("");
    try {
      const res = await fetch(withBasePath("/api/settings/plex/libraries"));
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        const message = body?.error ?? "Could not connect to Plex server";
        setLibrariesError(message);
        setLibrariesStatus("error");
        return { ok: false, count: 0, error: message };
      }
      const data = (await res.json()) as PlexSection[];
      setSections(data);
      setLibrariesStatus("loaded");
      return { ok: true, count: data.length };
    } catch {
      const message = "Could not connect to Plex server";
      setLibrariesError(message);
      setLibrariesStatus("error");
      return { ok: false, count: 0, error: message };
    }
  }, []);

  useEffect(() => {
    if (initialEmail && initialServerUrl) {
      void loadLibraries();
    }
  }, [initialEmail, initialServerUrl, loadLibraries]);

  async function handleConnect() {
    setStatus("waiting");
    setError("");

    let pinId: number;
    let pinCode: string;
    try {
      const res = await fetch(withBasePath("/api/auth/plex/pin"), { method: "POST" });
      if (!res.ok) throw new Error("create failed");
      const data: { id: number; code: string } = await res.json();
      pinId = data.id;
      pinCode = data.code;
    } catch {
      setError("Could not start Plex sign-in. Please try again.");
      setStatus("error");
      return;
    }

    const state = crypto.randomUUID();
    const base = (siteUrl || window.location.origin).replace(/\/$/, "");
    const forwardUrl = encodeURIComponent(`${base}/auth/plex/done?state=${state}`);
    const plexUrl =
      `https://app.plex.tv/auth#?` +
      `clientID=summonarr-server` +
      `&code=${pinCode}` +
      `&context[device][product]=Summonarr` +
      `&forwardUrl=${forwardUrl}`;

    // PIN state stashed so /auth/plex/done can pick it up after Plex redirects back
    try {
      sessionStorage.setItem("plex-redirect-auth", JSON.stringify({
        flow: "settings", pinId, state,
      }));
    } catch {
      setError("Could not store sign-in state. Disable private browsing and try again.");
      setStatus("error");
      return;
    }
    window.location.href = plexUrl;
  }

  async function handleDisconnect() {
    setStatus("saving");
    setError("");
    try {
      const res = await fetch(withBasePath("/api/settings/plex"), { method: "DELETE" });
      if (res.ok) {
        setConnectedEmail("");
        setStatus("idle");
        return;
      }
    } catch {
      // fall through to the shared error state below
    }
    setError("Failed to disconnect");
    setStatus("error");
  }

  async function handleSaveServerUrl(e: React.FormEvent) {
    e.preventDefault();
    setServerStatus("saving");
    setServerErrorMessage("");
    setLibrariesCount(null);

    let saveOk = false;
    try {
      const res = await fetch(withBasePath("/api/settings"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plexServerUrl: serverUrl }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      saveOk = res.ok && body.ok !== false;
      if (!saveOk) {
        setServerErrorMessage(body.error ?? "Failed to save server URL");
      }
    } catch {
      setServerErrorMessage("Failed to save server URL");
    }
    if (!saveOk) {
      setServerStatus("error");
      return;
    }

    setServerStatus("testing");
    const result = await loadLibraries();
    if (result.ok) {
      setLibrariesCount(result.count);
      setServerStatus("ok");
      setTimeout(() => setServerStatus("idle"), 4000);
    } else {
      setServerErrorMessage(result.error ?? "Could not connect to Plex server");
      setServerStatus("error");
    }
  }

  async function handleImport() {
    setImportStatus("running");
    setImportResult(null);
    try {
      const res = await fetch(withBasePath("/api/sync/plex"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ full: true }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data: { marked: number; scanned: { movies: number; tv: number } } = await res.json();
      setImportResult(data);
      setImportStatus("done");
    } catch {
      setImportStatus("error");
    }
  }

  return (
    <div className="space-y-4">
      {connectedEmail ? (
        <div className="flex items-center justify-between rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-3">
          <div className="flex items-center gap-2 text-sm">
            <CheckCircle className="w-4 h-4 text-green-400 shrink-0" />
            <span className="text-zinc-300">Connected as <span className="text-white font-medium">{connectedEmail}</span></span>
          </div>
          <button
            onClick={handleDisconnect}
            disabled={status === "saving"}
            className="flex items-center gap-1 text-xs text-zinc-500 hover:text-red-400 transition-colors disabled:opacity-50"
          >
            <Unlink className="w-3 h-3" />
            Disconnect
          </button>
        </div>
      ) : (
        <p className="text-sm text-zinc-400">
          Connect your Plex admin account. Only users you share your Plex server with will be
          able to sign in.
        </p>
      )}

      {!connectedEmail && (
        <Button
          onClick={handleConnect}
          disabled={status === "waiting" || status === "saving"}
          className="bg-[#e5a00d] hover:bg-[#f0ac14] text-black font-semibold"
        >
          {status === "waiting" ? (
            <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Waiting for Plex…</>
          ) : status === "saving" ? (
            <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Saving…</>
          ) : (
            "Connect Plex Account"
          )}
        </Button>
      )}

      {status === "error" && (
        <p role="alert" aria-live="assertive" className="flex items-center gap-1.5 text-sm text-red-400">
          <XCircle className="w-4 h-4" />{error}
        </p>
      )}

      {connectedEmail && (
        <div className="border-t border-zinc-800 pt-4 space-y-4">
          <form onSubmit={handleSaveServerUrl} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="plex-server-url">Plex Server URL</Label>
              <Input
                id="plex-server-url"
                type="url"
                value={serverUrl}
                onChange={(e) => { setServerUrl(e.target.value); setServerStatus("idle"); }}
                placeholder="http://192.168.1.100:32400"
                className="bg-zinc-800 border-zinc-700 font-mono text-sm"
              />
              <p className="text-xs text-zinc-500">
                Local address of your Plex Media Server — used to sync library availability.
              </p>
            </div>
            <div className="flex items-center gap-3 flex-wrap">
              <Button
                type="submit"
                disabled={serverStatus === "saving" || serverStatus === "testing" || !serverUrl}
                className="bg-indigo-600 hover:bg-indigo-500"
              >
                {serverStatus === "saving" ? (
                  <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Saving…</>
                ) : serverStatus === "testing" ? (
                  <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Testing…</>
                ) : (
                  "Save & Test"
                )}
              </Button>
              {serverStatus === "ok" && (
                <span role="status" aria-live="polite" className="flex items-center gap-1.5 text-sm text-green-400">
                  <CheckCircle className="w-4 h-4" />
                  Connected
                  {librariesCount !== null && (
                    <span className="text-zinc-500">({librariesCount} {librariesCount === 1 ? "library" : "libraries"} loaded)</span>
                  )}
                </span>
              )}
              {serverStatus === "error" && (
                <span role="alert" aria-live="assertive" className="flex items-center gap-1.5 text-sm text-red-400">
                  <XCircle className="w-4 h-4" />{serverErrorMessage || "Failed"}
                </span>
              )}
            </div>
          </form>

          {serverUrl && (
            <>
              <div className="flex items-center gap-3">
                <Button
                  type="button"
                  onClick={handleImport}
                  disabled={importStatus === "running"}
                  variant="outline"
                  className="border-zinc-700 text-zinc-300 hover:text-white"
                >
                  {importStatus === "running" ? (
                    <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Importing…</>
                  ) : (
                    <><Download className="w-4 h-4 mr-2" />Import from Plex</>
                  )}
                </Button>
                {importStatus === "done" && importResult && (
                  <span role="status" aria-live="polite" className="flex items-center gap-1.5 text-sm text-green-400">
                    <CheckCircle className="w-4 h-4" />
                    {importResult.marked} marked available
                    <span className="text-zinc-500">
                      ({importResult.scanned.movies} movies, {importResult.scanned.tv} shows scanned)
                    </span>
                  </span>
                )}
                {importStatus === "error" && (
                  <span role="alert" aria-live="assertive" className="flex items-center gap-1.5 text-sm text-red-400">
                    <XCircle className="w-4 h-4" />Import failed — check server URL
                  </span>
                )}
              </div>
              <PlexLibraryPicker
                initialSelected={initialPlexLibraries}
                sections={sections}
                loadStatus={librariesStatus}
                errorMessage={librariesError}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}
