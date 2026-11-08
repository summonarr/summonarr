"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CheckCircle, XCircle, Loader2, Unlink, Download } from "@/components/icons";
import { BASE_PATH, withBasePath } from "@/lib/base-path";
import { fetchJson, jsonInit } from "@/lib/client/fetch-json";
import { plexApprovalUrl, plexForwardUrl, plexReturnBase } from "@/lib/client/plex-approval-url";
import { v } from "@/lib/validate";
import { useT } from "@/components/i18n/i18n-provider";
import { rich } from "./rich";
import { randomUuid } from "@/lib/random-id";
import {
  LibraryImportResult,
  LibraryPicker,
  SaveAndTestLabel,
  SaveAndTestResult,
  useLibraryImport,
  useLibraryLoader,
  useServerSaveAndTest,
} from "./media-server-library";

// POST /api/auth/plex/pin: the PIN, and the per-attempt client identifier it
// was created under (guardrail 6f).
const PinAnswer = v.object({ id: v.int(), code: v.string(), clientId: v.string() });

// One server on the admin's plex.tv account (GET /api/admin/plex/servers).
const AccountServer = v.object({
  machineId: v.string(),
  name: v.string(),
  connections: v.array(v.object({ uri: v.string(), local: v.boolean(), relay: v.boolean() })),
});
type PlexAccountServer = { machineId: string; name: string; connections: { uri: string; local: boolean; relay: boolean }[] };
const AccountServers = v.object({ servers: v.array(AccountServer) });
const PickedServer = v.object({ url: v.string(), relay: v.optional(v.boolean()) });

interface PlexConnectFormProps {
  initialEmail: string;
  initialServerUrl: string;
  initialPlexLibraries: string;
  siteUrl: string;
}

// Connects Plex with Plex's PIN sign-in: the admin approves a short code on plex.tv
// and the resulting admin token is saved in the Setting table (not an env var).
export function PlexConnectForm({ initialEmail, initialServerUrl, initialPlexLibraries, siteUrl }: PlexConnectFormProps) {
  const [connectedEmail, setConnectedEmail] = useState(initialEmail);
  return (
    <div className="space-y-4">
      <PlexAccount connectedEmail={connectedEmail} siteUrl={siteUrl} onDisconnected={() => setConnectedEmail("")} />
      {connectedEmail && (
        <PlexServerSection
          initialServerUrl={initialServerUrl}
          initialPlexLibraries={initialPlexLibraries}
          // Connected at page load with a stored URL: the picker loads at once.
          autoLoad={Boolean(initialEmail && initialServerUrl)}
        />
      )}
    </div>
  );
}

// ── the plex.tv account: connect and disconnect ──────────────────────────────

/** Starts the PIN sign-in. Resolves the plex.tv approval URL, or the reason it can't. */
async function startPlexConnect(siteUrl: string, t: ReturnType<typeof useT>): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const res = await fetchJson(withBasePath("/api/auth/plex/pin"), { init: { method: "POST" }, schema: PinAnswer });
  // The server mints a fresh client identifier per connect attempt (and keeps
  // it, bound to this admin, in an HttpOnly cookie). The approval URL must name
  // the same identifier the PIN was created under.
  if (!res.ok || !res.data.code || !res.data.clientId) return { ok: false, error: t("settings.form.plex.startFailed") };
  const pinId = res.data.id;
  const pinCode = res.data.code;
  const pinClientId = res.data.clientId;

  let state: string;
  try {
    state = randomUuid();
  } catch {
    // No crypto at all: nothing to bind the return to.
    return { ok: false, error: t("settings.form.plex.startFailed") };
  }
  // siteUrl is the admin site URL, else AUTH_URL (a bare origin); the return
  // address needs the base path either way.
  const forwardUrl = plexForwardUrl(plexReturnBase(siteUrl, window.location.origin, BASE_PATH), state);
  const plexUrl = plexApprovalUrl({
    clientId: pinClientId,
    code: pinCode,
    forwardUrl,
    device: { product: "Summonarr" },
  });

  // Save the PIN details in sessionStorage: this page is about to navigate away,
  // and /auth/plex/done reads them when Plex sends the browser back.
  try {
    sessionStorage.setItem("plex-redirect-auth", JSON.stringify({
      flow: "settings", pinId, state,
    }));
  } catch {
    return { ok: false, error: t("settings.form.plex.storeFailed") };
  }
  return { ok: true, url: plexUrl };
}

function PlexAccount({ connectedEmail, siteUrl, onDisconnected }: { connectedEmail: string; siteUrl: string; onDisconnected: () => void }) {
  const t = useT();
  const [status, setStatus] = useState<"idle" | "waiting" | "saving" | "error">("idle");
  const [error, setError] = useState("");
  // Disconnect is a two-step inline confirm: one accidental tap used to remove
  // the admin token outright, and getting it back is the full plex.tv PIN
  // round-trip.
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  async function handleConnect() {
    setStatus("waiting");
    setError("");
    const started = await startPlexConnect(siteUrl, t);
    if (!started.ok) {
      setError(started.error);
      setStatus("error");
      return;
    }
    window.location.href = started.url;
  }

  async function handleDisconnect() {
    setConfirmDisconnect(false);
    setStatus("saving");
    setError("");
    const res = await fetchJson(withBasePath("/api/settings/plex"), { init: { method: "DELETE" } });
    // A 2xx is the disconnect, whatever its body.
    if (res.ok || res.kind === "invalid") {
      onDisconnected();
      setStatus("idle");
      return;
    }
    setError(t("settings.form.plex.disconnectFailed"));
    setStatus("error");
  }

  return (
    <>
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
    </>
  );
}

// ── the server: address, Save & Test, import, libraries ──────────────────────

function PlexServerSection({ initialServerUrl, initialPlexLibraries, autoLoad }: { initialServerUrl: string; initialPlexLibraries: string; autoLoad: boolean }) {
  const t = useT();
  const [serverUrl, setServerUrl] = useState(initialServerUrl);
  // The address the server holds. Import and the picker act on the STORED
  // config, so they follow this and not the field: an unsaved URL showed an
  // Import whose click answered "not configured", and clearing the field hid
  // the picker of a configured server (guardrail 36).
  const [savedServerUrl, setSavedServerUrl] = useState(initialServerUrl);
  const [relayPicked, setRelayPicked] = useState(false);
  const libraries = useLibraryLoader("plex", autoLoad);
  const server = useServerSaveAndTest("plex", libraries.loadNewest);
  const importer = useLibraryImport("plex");
  // The last library selection saved this session; a remounted picker starts
  // from it, not from the page-load value.
  const [savedLibraries, setSavedLibraries] = useState(initialPlexLibraries);

  function applyAddress(url: string, relay: boolean) {
    setServerUrl(url);
    setRelayPicked(relay);
    server.edited();
  }

  async function handleSaveServerUrl(e: React.FormEvent) {
    e.preventDefault();
    const sent = serverUrl;
    const stored = await server.saveAndTest({ plexServerUrl: sent }, (r) => r.error || t("settings.form.plex.saveUrlFailed"));
    if (stored) setSavedServerUrl(sent);
  }

  return (
    <div className="border-t border-zinc-800 pt-4 space-y-4">
      <form onSubmit={handleSaveServerUrl} className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="plex-server-url">{t("settings.form.plex.serverUrl")}</Label>
          <Input
            id="plex-server-url"
            type="url"
            value={serverUrl}
            onChange={(e) => applyAddress(e.target.value, false)}
            placeholder="http://192.168.1.100:32400"
            className="bg-zinc-800 border-zinc-700 font-mono"
          />
          <p className="text-xs text-zinc-500">
            {t("settings.form.plex.serverUrlHelp")}
          </p>
          {relayPicked && <p className="text-xs text-amber-400">{t("settings.form.plex.relayWarning")}</p>}
        </div>
        <PlexAccountServers onUse={applyAddress} />
        <div className="flex items-center gap-3 flex-wrap">
          <Button
            type="submit"
            disabled={server.status === "saving" || server.status === "testing" || !serverUrl}
            className="bg-indigo-600 hover:bg-indigo-500"
          >
            <SaveAndTestLabel status={server.status} />
          </Button>
          <SaveAndTestResult status={server.status} message={server.message} librariesCount={server.librariesCount} />
        </div>
      </form>

      {savedServerUrl && (
        <>
          <div className="flex items-center gap-3">
            <Button
              type="button"
              onClick={() => void importer.runImport()}
              disabled={importer.running}
              variant="outline"
              className="border-zinc-700 text-zinc-300 hover:text-zinc-100"
            >
              {importer.running ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" />{t("settings.form.arr.importing")}</>
              ) : (
                <><Download className="w-4 h-4 mr-2" />{t("settings.form.arr.importFrom", { service: "Plex" })}</>
              )}
            </Button>
            <LibraryImportResult state={importer.state} failedText={t("settings.form.plex.importFailed")} />
          </div>
          <LibraryPicker
            service="plex"
            initialSelected={savedLibraries}
            items={libraries.items}
            loadStatus={libraries.status}
            errorMessage={libraries.error}
            onSaved={setSavedLibraries}
          />
        </>
      )}
    </div>
  );
}

// The account server picker: the list comes from plex.tv, and a pick is
// resolved to an address that answers from this server (the browser names the
// machine id only).
function PlexAccountServers({ onUse }: { onUse: (url: string, relay: boolean) => void }) {
  const t = useT();
  const [accountServers, setAccountServers] = useState<PlexAccountServer[] | null>(null);
  const [serversStatus, setServersStatus] = useState<"idle" | "loading" | "error">("idle");
  const [serversError, setServersError] = useState("");
  const [allowFallback, setAllowFallback] = useState(true);
  const [resolving, setResolving] = useState<string | null>(null);

  async function loadAccountServers() {
    setServersStatus("loading");
    setServersError("");
    const res = await fetchJson(withBasePath("/api/admin/plex/servers"), {
      schema: AccountServers,
      fallbackError: t("settings.form.plex.serversFailed"),
    });
    if (!res.ok) {
      setServersError(res.error);
      setServersStatus("error");
      return;
    }
    setAccountServers(res.data.servers);
    setServersStatus("idle");
  }

  async function pickAccountServer(machineId: string) {
    setResolving(machineId);
    setServersError("");
    const res = await fetchJson(withBasePath("/api/admin/plex/servers"), {
      init: jsonInit("POST", { machineId, fallback: allowFallback }),
      schema: PickedServer,
      fallbackError: t("settings.form.plex.serversFailed"),
    });
    setResolving(null);
    if (!res.ok || !res.data.url) {
      setServersError(res.ok ? t("settings.form.plex.serversFailed") : res.error);
      return;
    }
    onUse(res.data.url, res.data.relay === true);
  }

  return (
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
                      onClick={() => onUse(c.uri, c.relay)}
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
  );
}
