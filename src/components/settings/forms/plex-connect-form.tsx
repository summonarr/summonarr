"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CheckCircle, XCircle, Loader2, Unlink, Download } from "@/components/icons";
import { SaveStatusMessage } from "./save-status";
import { withBasePath } from "@/lib/base-path";
import type { SaveStatus, LoadStatus } from "./shared";
import { useT } from "@/components/i18n/i18n-provider";
import { rich } from "./rich";

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
  const t = useT();
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(initialSelected.split(",").map((k) => k.trim()).filter(Boolean))
  );
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  // The route's own reason (a 429 cooldown) — shown in place of the bare
  // "Failed to save".
  const [saveMessage, setSaveMessage] = useState("");
  // An earlier save's idle timer must not fire into a later save (it would
  // re-enable Save mid-flight or hide the new result early).
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (idleTimer.current) clearTimeout(idleTimer.current);
  }, []);

  function toggle(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function handleSave() {
    if (idleTimer.current) clearTimeout(idleTimer.current);
    setSaveStatus("saving");
    setSaveMessage("");
    try {
      const res = await fetch(withBasePath("/api/settings"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plexLibraries: Array.from(selected).join(",") }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (res.ok && data.ok !== false) {
        setSaveStatus("ok");
      } else {
        setSaveMessage(data.error ?? t("settings.form.common.saveFailed"));
        setSaveStatus("error");
      }
    } catch {
      setSaveStatus("error");
    }
    idleTimer.current = setTimeout(() => setSaveStatus((s) => (s === "ok" ? "idle" : s)), 3000);
  }

  return (
    <div className="border-t border-zinc-800 pt-4 space-y-3">
      <p className="text-sm font-medium text-zinc-300">{t("settings.form.library.librarySelection")}</p>
      {loadStatus === "idle" && (
        <p className="text-xs text-zinc-500">{t("settings.form.library.loadHint", { server: "Plex" })}</p>
      )}
      {loadStatus === "loading" && (
        <p className="text-xs text-zinc-500 flex items-center gap-1.5">
          <Loader2 className="w-3 h-3 animate-spin" />{t("settings.form.library.loadingLibraries")}
        </p>
      )}
      {loadStatus === "error" && (
        <p className="text-xs text-red-400">{errorMessage || t("settings.form.library.connectFailed", { server: "Plex" })}</p>
      )}
      {loadStatus === "loaded" && (
        <>
          {sections.length === 0 ? (
            <p className="text-xs text-zinc-500">{t("settings.form.library.noLibraries")}</p>
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
                  <span className="text-sm text-zinc-300 group-hover:text-zinc-100 transition-colors">
                    {s.title}
                  </span>
                  <span className="text-xs px-1.5 py-0.5 rounded bg-zinc-700 text-zinc-400">
                    {s.type === "movie" ? t("search.filter.movies") : t("search.filter.tv")}
                  </span>
                </label>
              ))}
            </div>
          )}
          {selected.size === 0 && sections.length > 0 && (
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

interface PlexConnectFormProps {
  initialEmail: string;
  initialServerUrl: string;
  initialPlexLibraries: string;
  siteUrl: string;
}

// Connects Plex with Plex's PIN sign-in: the admin approves a short code on plex.tv
// and the resulting admin token is saved in the Setting table (not an env var).
export function PlexConnectForm({ initialEmail, initialServerUrl, initialPlexLibraries, siteUrl }: PlexConnectFormProps) {
  const t = useT();
  const [connectedEmail, setConnectedEmail] = useState(initialEmail);
  const [status, setStatus] = useState<"idle" | "waiting" | "saving" | "error">("idle");
  const [error, setError] = useState("");
  // Disconnect is a two-step inline confirm: one accidental tap used to remove
  // the admin token outright, and getting it back is the full plex.tv PIN
  // round-trip.
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const [serverUrl, setServerUrl] = useState(initialServerUrl);
  const [serverStatus, setServerStatus] = useState<"idle" | "saving" | "testing" | "ok" | "error">("idle");
  const [serverErrorMessage, setServerErrorMessage] = useState<string>("");
  const [librariesCount, setLibrariesCount] = useState<number | null>(null);
  // Account server picker: the list comes from plex.tv, and a pick is resolved to an
  // address that answers from this server (the browser names the machine id only).
  const [accountServers, setAccountServers] = useState<{ machineId: string; name: string; connections: { uri: string; local: boolean; relay: boolean }[] }[] | null>(null);
  const [serversStatus, setServersStatus] = useState<"idle" | "loading" | "error">("idle");
  const [serversError, setServersError] = useState("");
  const [allowFallback, setAllowFallback] = useState(true);
  const [resolving, setResolving] = useState<string | null>(null);
  const [relayPicked, setRelayPicked] = useState(false);
  const [importStatus, setImportStatus] = useState<"idle" | "running" | "done" | "busy" | "error">("idle");
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
        const message = body?.error;
        setLibrariesError(message ?? "");
        setLibrariesStatus("error");
        return { ok: false, count: 0, error: message };
      }
      const data = (await res.json()) as PlexSection[];
      setSections(data);
      setLibrariesStatus("loaded");
      return { ok: true, count: data.length };
    } catch {
      setLibrariesError("");
      setLibrariesStatus("error");
      return { ok: false, count: 0 };
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
    let pinClientId: string;
    try {
      const res = await fetch(withBasePath("/api/auth/plex/pin"), { method: "POST" });
      if (!res.ok) throw new Error("create failed");
      const data: { id: number; code: string; clientId: string } = await res.json();
      if (typeof data.clientId !== "string" || !data.clientId) throw new Error("create failed");
      pinId = data.id;
      pinCode = data.code;
      // The server mints a fresh client identifier per connect attempt (and keeps
      // it, bound to this admin, in an HttpOnly cookie). The approval URL must
      // name the same identifier the PIN was created under.
      pinClientId = data.clientId;
    } catch {
      setError(t("settings.form.plex.startFailed"));
      setStatus("error");
      return;
    }

    const state = crypto.randomUUID();
    const base = (siteUrl || window.location.origin).replace(/\/$/, "");
    const forwardUrl = encodeURIComponent(`${base}/auth/plex/done?state=${state}`);
    const plexUrl =
      `https://app.plex.tv/auth#?` +
      `clientID=${encodeURIComponent(pinClientId)}` +
      `&code=${pinCode}` +
      `&context[device][product]=Summonarr` +
      `&forwardUrl=${forwardUrl}`;

    // Save the PIN details in sessionStorage: this page is about to navigate away,
    // and /auth/plex/done reads them when Plex sends the browser back.
    try {
      sessionStorage.setItem("plex-redirect-auth", JSON.stringify({
        flow: "settings", pinId, state,
      }));
    } catch {
      setError(t("settings.form.plex.storeFailed"));
      setStatus("error");
      return;
    }
    window.location.href = plexUrl;
  }

  async function handleDisconnect() {
    setConfirmDisconnect(false);
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
      // Handled by the error lines below.
    }
    setError(t("settings.form.plex.disconnectFailed"));
    setStatus("error");
  }

  async function loadAccountServers() {
    setServersStatus("loading");
    setServersError("");
    try {
      const res = await fetch(withBasePath("/api/admin/plex/servers"));
      const body = (await res.json().catch(() => ({}))) as { servers?: { machineId: string; name: string; connections: { uri: string; local: boolean; relay: boolean }[] }[]; error?: string };
      if (!res.ok || !body.servers) {
        setServersError(body.error ?? t("settings.form.plex.serversFailed"));
        setServersStatus("error");
        return;
      }
      setAccountServers(body.servers);
      setServersStatus("idle");
    } catch {
      setServersError(t("settings.form.plex.serversFailed"));
      setServersStatus("error");
    }
  }

  async function pickAccountServer(machineId: string) {
    setResolving(machineId);
    setServersError("");
    try {
      const res = await fetch(withBasePath("/api/admin/plex/servers"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ machineId, fallback: allowFallback }),
      });
      const body = (await res.json().catch(() => ({}))) as { url?: string; relay?: boolean; error?: string };
      if (!res.ok || !body.url) {
        setServersError(body.error ?? t("settings.form.plex.serversFailed"));
      } else {
        setServerUrl(body.url);
        setRelayPicked(body.relay === true);
        setServerStatus("idle");
      }
    } catch {
      setServersError(t("settings.form.plex.serversFailed"));
    } finally {
      setResolving(null);
    }
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
        setServerErrorMessage(body.error ?? t("settings.form.plex.saveUrlFailed"));
      }
    } catch {
      setServerErrorMessage(t("settings.form.plex.saveUrlFailed"));
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
      // Only clear an "ok" — a later Save & Test may already be in flight.
      setTimeout(() => setServerStatus((s) => (s === "ok" ? "idle" : s)), 4000);
    } else {
      setServerErrorMessage(result.error ?? t("settings.form.library.connectFailed", { server: "Plex" }));
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
      const data = (await res.json()) as { marked: number; scanned: { movies: number; tv: number } } | { skipped: true };
      // 200 { skipped: true }: a sync of this server is already running; it
      // carries no counts.
      if ("skipped" in data) {
        setImportStatus("busy");
        return;
      }
      setImportResult(data);
      setImportStatus("done");
    } catch {
      setImportStatus("error");
    }
  }

  return (
    <div className="space-y-4">
      {connectedEmail ? (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-3">
          <div className="flex items-center gap-2 text-sm min-w-0">
            <CheckCircle className="w-4 h-4 text-green-400 shrink-0" />
            <span className="text-zinc-300 min-w-0 truncate" title={connectedEmail}>{rich(t("settings.form.plex.connectedAs"), { email: <span className="text-zinc-100 font-medium">{connectedEmail}</span> })}</span>
          </div>
          {!confirmDisconnect && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirmDisconnect(true)}
              disabled={status === "saving"}
              className="shrink-0 text-zinc-400 hover:text-red-400"
            >
              <Unlink aria-hidden />
              {t("settings.form.plex.disconnect")}
            </Button>
          )}
          {confirmDisconnect && (
            <div className="basis-full flex flex-wrap items-center justify-between gap-x-3 gap-y-2 pt-2 border-t border-zinc-700">
              <p className="text-xs text-zinc-400">{t("settings.form.plex.disconnectConfirm")}</p>
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirmDisconnect(false)}
                  className="text-zinc-400 hover:text-zinc-100"
                >
                  {t("settings.form.common.cancel")}
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={handleDisconnect}
                  disabled={status === "saving"}
                  autoFocus
                >
                  <Unlink aria-hidden />
                  {t("settings.form.plex.disconnectConfirmAction")}
                </Button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <p className="text-sm text-zinc-400">
          {t("settings.form.plex.intro")}
        </p>
      )}

      {!connectedEmail && (
        <Button
          onClick={handleConnect}
          disabled={status === "waiting" || status === "saving"}
          // Plex brand fill is a fixed (non-remapped) colour in both themes, so
          // black text is the right fixed pairing (guardrail 42).
          className="bg-[var(--ds-plex)] hover:bg-[var(--ds-plex)] hover:brightness-110 text-black font-semibold"
        >
          {status === "waiting" ? (
            <><Loader2 className="w-4 h-4 mr-2 animate-spin" />{t("settings.form.plex.waiting")}</>
          ) : status === "saving" ? (
            <><Loader2 className="w-4 h-4 mr-2 animate-spin" />{t("settings.form.common.saving")}</>
          ) : (
            t("settings.form.plex.connect")
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
              <Label htmlFor="plex-server-url">{t("settings.form.plex.serverUrl")}</Label>
              <Input
                id="plex-server-url"
                type="url"
                value={serverUrl}
                onChange={(e) => { setServerUrl(e.target.value); setServerStatus("idle"); setRelayPicked(false); }}
                placeholder="http://192.168.1.100:32400"
                className="bg-zinc-800 border-zinc-700 font-mono"
              />
              <p className="text-xs text-zinc-500">
                {t("settings.form.plex.serverUrlHelp")}
              </p>
              {relayPicked && <p className="text-xs text-amber-400">{t("settings.form.plex.relayWarning")}</p>}
            </div>
            <div className="space-y-2 rounded-lg border border-zinc-800 p-3">
              <div className="flex items-center gap-3 flex-wrap">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void loadAccountServers()}
                  disabled={serversStatus === "loading"}
                >
                  {serversStatus === "loading" ? (
                    <><Loader2 className="w-4 h-4 mr-2 animate-spin" />{t("settings.form.plex.loadingServers")}</>
                  ) : (
                    t("settings.form.plex.loadServers")
                  )}
                </Button>
                <label className="flex items-center gap-2 text-xs text-zinc-400">
                  <input type="checkbox" checked={allowFallback} onChange={(e) => setAllowFallback(e.target.checked)} />
                  {t("settings.form.plex.allowFallback")}
                </label>
              </div>
              <p className="text-xs text-zinc-500">{t("settings.form.plex.allowFallbackHelp")}</p>
              {accountServers !== null && accountServers.length === 0 && (
                <p className="text-xs text-zinc-500">{t("settings.form.plex.noServers")}</p>
              )}
              {accountServers !== null && accountServers.length > 0 && (
                <ul className="m-0 list-none space-y-1 p-0">
                  {accountServers.map((sv) => (
                    <li key={sv.machineId} className="space-y-1">
                      <div className="flex items-center justify-between gap-2 text-sm">
                        <span className="min-w-0 truncate font-medium">{sv.name}</span>
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          disabled={resolving !== null}
                          onClick={() => void pickAccountServer(sv.machineId)}
                        >
                          {resolving === sv.machineId ? <Loader2 className="animate-spin" /> : null}
                          {t("settings.form.plex.autoPick")}
                        </Button>
                      </div>
                      <ul className="m-0 list-none space-y-1 p-0 pl-3">
                        {sv.connections.map((c) => (
                          <li key={c.uri} className="flex items-center justify-between gap-2 text-xs">
                            <span className="min-w-0 truncate">
                              <span className={c.relay ? "text-amber-400" : "text-zinc-400"}>
                                {t(c.relay ? "settings.form.plex.connRelay" : c.local ? "settings.form.plex.connLocal" : "settings.form.plex.connRemote")}
                              </span>{" "}
                              <span className="font-mono text-zinc-500">{c.uri}</span>
                            </span>
                            <Button
                              type="button"
                              size="xs"
                              variant="ghost"
                              onClick={() => { setServerUrl(c.uri); setRelayPicked(c.relay); setServerStatus("idle"); }}
                            >
                              {t("settings.form.plex.useServer")}
                            </Button>
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              )}
              {serversError && (
                <p role="alert" className="flex items-center gap-1.5 text-xs text-red-400">
                  <XCircle className="w-3.5 h-3.5" />{serversError}
                </p>
              )}
            </div>
            <div className="flex items-center gap-3 flex-wrap">
              <Button
                type="submit"
                disabled={serverStatus === "saving" || serverStatus === "testing" || !serverUrl}
                className="bg-indigo-600 hover:bg-indigo-500"
              >
                {serverStatus === "saving" ? (
                  <><Loader2 className="w-4 h-4 mr-2 animate-spin" />{t("settings.form.common.saving")}</>
                ) : serverStatus === "testing" ? (
                  <><Loader2 className="w-4 h-4 mr-2 animate-spin" />{t("settings.form.common.testing")}</>
                ) : (
                  t("settings.form.common.saveAndTest")
                )}
              </Button>
              {serverStatus === "ok" && (
                <span role="status" aria-live="polite" className="flex items-center gap-1.5 text-sm text-green-400">
                  <CheckCircle className="w-4 h-4" />
                  {t("settings.form.common.connected")}
                  {librariesCount !== null && (
                    <span className="text-zinc-500">{t("settings.form.library.librariesLoaded", { count: librariesCount })}</span>
                  )}
                </span>
              )}
              {serverStatus === "error" && (
                <span role="alert" aria-live="assertive" className="flex items-center gap-1.5 text-sm text-red-400">
                  <XCircle className="w-4 h-4" />{serverErrorMessage || t("settings.form.common.failed")}
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
                  className="border-zinc-700 text-zinc-300 hover:text-zinc-100"
                >
                  {importStatus === "running" ? (
                    <><Loader2 className="w-4 h-4 mr-2 animate-spin" />{t("settings.form.arr.importing")}</>
                  ) : (
                    <><Download className="w-4 h-4 mr-2" />{t("settings.form.arr.importFrom", { service: "Plex" })}</>
                  )}
                </Button>
                {importStatus === "done" && importResult && (
                  <span role="status" aria-live="polite" className="flex items-center gap-1.5 text-sm text-green-400">
                    <CheckCircle className="w-4 h-4" />
                    {t("settings.form.common.markedAvailable", { count: importResult.marked })}
                    <span className="text-zinc-500">
                      {t("settings.form.library.scanned", { movies: importResult.scanned.movies, tv: importResult.scanned.tv })}
                    </span>
                  </span>
                )}
                {importStatus === "busy" && (
                  <span role="status" aria-live="polite" className="text-sm text-zinc-400">
                    {t("settings.form.library.alreadyRunning")}
                  </span>
                )}
                {importStatus === "error" && (
                  <span role="alert" aria-live="assertive" className="flex items-center gap-1.5 text-sm text-red-400">
                    <XCircle className="w-4 h-4" />{t("settings.form.plex.importFailed")}
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
