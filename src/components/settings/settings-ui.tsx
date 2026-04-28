"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CheckCircle, XCircle, Loader2, Copy, Check, RefreshCw, Unlink, Download, RefreshCcw, ChevronDown, ExternalLink } from "lucide-react";

interface PlexSection {
  key: string;
  title: string;
  type: "movie" | "show";
}

interface PlexLibraryPickerProps {
  initialSelected: string;
}

function PlexLibraryPicker({ initialSelected }: PlexLibraryPickerProps) {
  const [sections, setSections] = useState<PlexSection[]>([]);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(initialSelected.split(",").map((k) => k.trim()).filter(Boolean))
  );
  const [loadStatus, setLoadStatus] = useState<LoadStatus>("loading");
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");

  useEffect(() => {
    fetch("/api/settings/plex/libraries")
      .then((r) => {
        if (!r.ok) throw new Error();
        return r.json() as Promise<PlexSection[]>;
      })
      .then((data) => {
        setSections(data);
        setLoadStatus("loaded");
      })
      .catch(() => setLoadStatus("error"));
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
    setSaveStatus("saving");
    const res = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plexLibraries: Array.from(selected).join(",") }),
    });
    const data: { ok: boolean } = await res.json();
    setSaveStatus(data.ok ? "ok" : "error");
    setTimeout(() => setSaveStatus("idle"), 3000);
  }

  return (
    <div className="border-t border-zinc-800 pt-4 space-y-3">
      <p className="text-sm font-medium text-zinc-300">Library Selection</p>
      {loadStatus === "loading" && (
        <p className="text-xs text-zinc-500 flex items-center gap-1.5">
          <Loader2 className="w-3 h-3 animate-spin" />Loading libraries…
        </p>
      )}
      {loadStatus === "error" && (
        <p className="text-xs text-red-400">Could not load Plex libraries — check server URL above.</p>
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
            {saveStatus === "ok"    && <span className="flex items-center gap-1.5 text-sm text-green-400"><CheckCircle className="w-4 h-4" />Saved</span>}
            {saveStatus === "error" && <span className="flex items-center gap-1.5 text-sm text-red-400"><XCircle className="w-4 h-4" />Failed to save</span>}
          </div>
        </>
      )}
    </div>
  );
}

interface JellyfinMediaFolder {
  id: string;
  name: string;
  collectionType: string;
}

interface JellyfinLibraryPickerProps {
  initialSelected: string;
}

function JellyfinLibraryPicker({ initialSelected }: JellyfinLibraryPickerProps) {
  const [folders, setFolders] = useState<JellyfinMediaFolder[]>([]);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(initialSelected.split(",").map((k) => k.trim()).filter(Boolean))
  );
  const [loadStatus, setLoadStatus] = useState<LoadStatus>("loading");
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");

  useEffect(() => {
    fetch("/api/settings/jellyfin/libraries")
      .then((r) => {
        if (!r.ok) throw new Error();
        return r.json() as Promise<JellyfinMediaFolder[]>;
      })
      .then((data) => {
        setFolders(data);
        setLoadStatus("loaded");
      })
      .catch(() => setLoadStatus("error"));
  }, []);

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
    const res = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jellyfinLibraries: Array.from(selected).join(",") }),
    });
    const data: { ok: boolean } = await res.json();
    setSaveStatus(data.ok ? "ok" : "error");
    setTimeout(() => setSaveStatus("idle"), 3000);
  }

  return (
    <div className="border-t border-zinc-800 pt-4 space-y-3">
      <p className="text-sm font-medium text-zinc-300">Library Selection</p>
      {loadStatus === "loading" && (
        <p className="text-xs text-zinc-500 flex items-center gap-1.5">
          <Loader2 className="w-3 h-3 animate-spin" />Loading libraries…
        </p>
      )}
      {loadStatus === "error" && (
        <p className="text-xs text-red-400">Could not load Jellyfin libraries — check server URL and API key above.</p>
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

type SaveStatus = "idle" | "saving" | "ok" | "error";
type LoadStatus = "idle" | "loading" | "loaded" | "error";

interface ArrFormProps {
  service: "radarr" | "sonarr";
  initialUrl: string;
  initialApiKey: string;
  initialRootFolder: string;
  initialQualityProfileId: string;
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
}: ArrFormProps) {
  const label      = service === "radarr" ? "Radarr" : "Sonarr";
  const urlKey     = service === "radarr" ? "radarrUrl"              : "sonarrUrl";
  const keyKey     = service === "radarr" ? "radarrApiKey"           : "sonarrApiKey";
  const folderKey  = service === "radarr" ? "radarrRootFolder"       : "sonarrRootFolder";
  const profileKey = service === "radarr" ? "radarrQualityProfileId" : "sonarrQualityProfileId";
  const versionKey = service === "radarr" ? "radarrVersion"          : "sonarrVersion";

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
      const res = await fetch(`/api/settings/arr-options?service=${service}`);
      if (!res.ok) throw new Error();
      const data: ArrOptions = await res.json();
      setOptions(data);
      setOptionsStatus("loaded");
    } catch {
      setOptionsStatus("error");
    }
  }, [service]);

  useEffect(() => {
    if (initialUrl && initialApiKey) {
      fetchOptions();
    }
  }, [initialUrl, initialApiKey, fetchOptions]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setStatus("saving");
    setMessage("");

    const res = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [urlKey]: url, [keyKey]: apiKey }),
    });

    const data: { ok: boolean; error?: string } & Record<string, string> = await res.json();

    if (data.ok) {
      const version = data[versionKey];
      setMessage(version ? `Connected · v${version}` : "Saved");
      setStatus("ok");
      fetchOptions();
    } else {
      setMessage(data.error ?? "Failed to save");
      setStatus("error");
    }
  }

  async function handleSaveOptions(e: React.FormEvent) {
    e.preventDefault();
    setOptionsSaveStatus("saving");
    const res = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [folderKey]: rootFolder, [profileKey]: qualityProfileId }),
    });
    const data: { ok: boolean; error?: string } = await res.json();
    setOptionsSaveStatus(data.ok ? "ok" : "error");
    setTimeout(() => setOptionsSaveStatus("idle"), 3000);
  }

  return (
    <div className="space-y-6">
      <form onSubmit={handleSave} className="space-y-4">
        <div className="lg:grid lg:grid-cols-2 lg:gap-4 space-y-4 lg:space-y-0">
          <div className="space-y-1.5">
            <Label htmlFor={`${service}-url`}>{label} URL</Label>
            <Input
              id={`${service}-url`}
              type="url"
              value={url}
              onChange={(e) => { setUrl(e.target.value); setStatus("idle"); }}
              placeholder="http://radarr:7878"
              className="bg-zinc-800 border-zinc-700 font-mono text-sm"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${service}-key`}>API Key</Label>
            <Input
              id={`${service}-key`}
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
          {status === "ok"    && <span className="flex items-center gap-1.5 text-sm text-green-400"><CheckCircle className="w-4 h-4" />{message}</span>}
          {status === "error" && <span className="flex items-center gap-1.5 text-sm text-red-400"><XCircle className="w-4 h-4" />{message}</span>}
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
                  <Label htmlFor={`${service}-folder`}>Root Folder</Label>
                  <select
                    id={`${service}-folder`}
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
                  <Label htmlFor={`${service}-profile`}>Quality Profile</Label>
                  <select
                    id={`${service}-profile`}
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
                {optionsSaveStatus === "ok"    && <span className="flex items-center gap-1.5 text-sm text-green-400"><CheckCircle className="w-4 h-4" />Saved</span>}
                {optionsSaveStatus === "error" && <span className="flex items-center gap-1.5 text-sm text-red-400"><XCircle className="w-4 h-4" />Failed to save</span>}
              </div>
            </form>
          )}
        </div>
      )}

      {optionsStatus === "loaded" && (
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
      const res = await fetch(`/api/sync/${service}`, { method: "POST" });
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
          <span className="flex items-center gap-1.5 text-sm text-green-400">
            <CheckCircle className="w-4 h-4" />
            {importCount} {service === "radarr" ? "movie(s)" : "show(s)"} pending
          </span>
        )}
        {importStatus === "error" && (
          <span className="flex items-center gap-1.5 text-sm text-red-400">
            <XCircle className="w-4 h-4" />{importError}
          </span>
        )}
      </div>
    </div>
  );
}

function generateSecret(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Webhook secret is stored encrypted in the Setting table; changing it invalidates all existing webhook URLs
export function WebhookSecretForm({ initialSecret }: { initialSecret: string }) {
  const [secret, setSecret] = useState(initialSecret);
  const [status, setStatus] = useState<SaveStatus>("idle");

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setStatus("saving");
    const res = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ webhookSecret: secret }),
    });
    const data: { ok: boolean } = await res.json();
    setStatus(data.ok ? "ok" : "error");
    setTimeout(() => setStatus("idle"), 3000);
  }

  return (
    <form onSubmit={handleSave} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="webhook-secret">Secret Token</Label>
        <div className="flex gap-2">
          <Input
            id="webhook-secret"
            type="password"
            value={secret}
            onChange={(e) => { setSecret(e.target.value); setStatus("idle"); }}
            placeholder="Leave blank to disable authentication"
            className="bg-zinc-800 border-zinc-700 font-mono text-sm"
          />
          <Button
            type="button"
            variant="outline"
            className="shrink-0 border-zinc-700 text-zinc-300 hover:text-white"
            onClick={() => { setSecret(generateSecret()); setStatus("idle"); }}
          >
            Generate
          </Button>
        </div>
        <p className="text-xs text-zinc-500">
          Add this as an <code className="text-zinc-400">Authorization</code> header (value:{" "}
          <code className="text-zinc-400">Bearer &lt;token&gt;</code>) in your Radarr/Sonarr webhook config.
          If set, requests without a matching token are rejected.
        </p>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={status === "saving"} className="bg-indigo-600 hover:bg-indigo-500">
          {status === "saving" ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Saving…</> : "Save Token"}
        </Button>
        {status === "ok"    && <span className="flex items-center gap-1.5 text-sm text-green-400"><CheckCircle className="w-4 h-4" />Saved</span>}
        {status === "error" && <span className="flex items-center gap-1.5 text-sm text-red-400"><XCircle className="w-4 h-4" />Failed to save</span>}
      </div>
    </form>
  );
}

function CopyRow({ label, displayUrl, copyUrl }: { label: string; displayUrl: string; copyUrl: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(copyUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-zinc-400">{label}</p>
      <div className="flex items-center gap-2 rounded-md bg-zinc-800 border border-zinc-700 px-3 py-2">
        <span className="flex-1 font-mono text-xs text-zinc-300 truncate">{displayUrl}</span>
        <button onClick={copy} className="shrink-0 text-zinc-500 hover:text-white transition-colors" aria-label="Copy">
          {copied ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
        </button>
      </div>
    </div>
  );
}

// The ?token= query param is the only auth option because Radarr/Sonarr webhook UIs have no header field
export function WebhookUrls({ baseUrl, secret }: { baseUrl: string; secret: string }) {
  const copySuffix = secret ? `?token=${encodeURIComponent(secret)}` : "";
  const displaySuffix = secret ? "?token=••••••••" : "";
  const radarrBase = `${baseUrl}/api/webhooks/radarr`;
  const sonarrBase = `${baseUrl}/api/webhooks/sonarr`;
  return (
    <div className="space-y-4">
      <CopyRow label="Radarr webhook URL" displayUrl={`${radarrBase}${displaySuffix}`} copyUrl={`${radarrBase}${copySuffix}`} />
      <CopyRow label="Sonarr webhook URL" displayUrl={`${sonarrBase}${displaySuffix}`} copyUrl={`${sonarrBase}${copySuffix}`} />
      {!secret && (
        <p className="text-xs text-amber-500">
          No secret token set — webhook endpoints are unauthenticated. Set a token above.
        </p>
      )}
      <p className="text-xs text-zinc-600">
        In Radarr/Sonarr: Settings → Connect → + → Webhook · Method: POST · Events: On Download · Use the URLs above (token is included).
      </p>
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
  const [serverStatus, setServerStatus] = useState<"idle" | "saving" | "ok" | "error">("idle");
  const [importStatus, setImportStatus] = useState<"idle" | "running" | "done" | "error">("idle");
  const [importResult, setImportResult] = useState<{ marked: number; scanned: { movies: number; tv: number } } | null>(null);

  async function handleConnect() {
    setStatus("waiting");
    setError("");

    let pinId: number;
    let pinCode: string;
    try {
      const res = await fetch("/api/auth/plex/pin", { method: "POST" });
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
    sessionStorage.setItem("plex-redirect-auth", JSON.stringify({
      flow: "settings", pinId, state,
    }));
    window.location.href = plexUrl;
  }

  async function handleDisconnect() {
    setStatus("saving");
    setError("");
    const res = await fetch("/api/settings/plex", { method: "DELETE" });
    if (res.ok) {
      setConnectedEmail("");
      setStatus("idle");
    } else {
      setError("Failed to disconnect");
      setStatus("error");
    }
  }

  async function handleSaveServerUrl(e: React.FormEvent) {
    e.preventDefault();
    setServerStatus("saving");
    const res = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plexServerUrl: serverUrl }),
    });
    const data: { ok: boolean } = await res.json();
    setServerStatus(data.ok ? "ok" : "error");
    setTimeout(() => setServerStatus("idle"), 3000);
  }

  async function handleImport() {
    setImportStatus("running");
    setImportResult(null);
    try {
      const res = await fetch("/api/sync/plex", {
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
        <p className="flex items-center gap-1.5 text-sm text-red-400">
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
            <div className="flex items-center gap-3">
              <Button
                type="submit"
                disabled={serverStatus === "saving" || !serverUrl}
                className="bg-indigo-600 hover:bg-indigo-500"
              >
                {serverStatus === "saving" ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Saving…</> : "Save URL"}
              </Button>
              {serverStatus === "ok"    && <span className="flex items-center gap-1.5 text-sm text-green-400"><CheckCircle className="w-4 h-4" />Saved</span>}
              {serverStatus === "error" && <span className="flex items-center gap-1.5 text-sm text-red-400"><XCircle className="w-4 h-4" />Failed</span>}
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
                  <span className="flex items-center gap-1.5 text-sm text-green-400">
                    <CheckCircle className="w-4 h-4" />
                    {importResult.marked} marked available
                    <span className="text-zinc-500">
                      ({importResult.scanned.movies} movies, {importResult.scanned.tv} shows scanned)
                    </span>
                  </span>
                )}
                {importStatus === "error" && (
                  <span className="flex items-center gap-1.5 text-sm text-red-400">
                    <XCircle className="w-4 h-4" />Import failed — check server URL
                  </span>
                )}
              </div>
              <PlexLibraryPicker initialSelected={initialPlexLibraries} />
            </>
          )}
        </div>
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
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("idle");
  const [syncResult, setSyncResult] = useState<{ marked: number; scanned: { movies: number; tv: number } } | null>(null);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaveStatus("saving");
    const res = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jellyfinUrl: url, jellyfinApiKey: apiKey }),
    });
    const data: { ok: boolean } = await res.json();
    setSaveStatus(data.ok ? "ok" : "error");
    setTimeout(() => setSaveStatus("idle"), 3000);
  }

  async function handleSync() {
    setSyncStatus("running");
    setSyncResult(null);
    try {
      const res = await fetch("/api/sync/jellyfin", { method: "POST" });
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
            disabled={saveStatus === "saving" || !url || !apiKey}
            className="bg-indigo-600 hover:bg-indigo-500"
          >
            {saveStatus === "saving" ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Saving…</> : "Save"}
          </Button>
          {saveStatus === "ok"    && <span className="flex items-center gap-1.5 text-sm text-green-400"><CheckCircle className="w-4 h-4" />Saved</span>}
          {saveStatus === "error" && <span className="flex items-center gap-1.5 text-sm text-red-400"><XCircle className="w-4 h-4" />Failed</span>}

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
        <JellyfinLibraryPicker initialSelected={initialJellyfinLibraries} />
      )}
    </div>
  );
}

interface DonationFormProps {
  initialPaypal: string;
  initialVenmo: string;
  initialZelle: string;
  initialAmazon: string;
  initialPatreon: string;
  initialBuyMeACoffee: string;
}

export function DonationForm({ initialPaypal, initialVenmo, initialZelle, initialAmazon, initialPatreon, initialBuyMeACoffee }: DonationFormProps) {
  const [paypal,        setPaypal]        = useState(initialPaypal);
  const [venmo,         setVenmo]         = useState(initialVenmo);
  const [zelle,         setZelle]         = useState(initialZelle);
  const [amazon,        setAmazon]        = useState(initialAmazon);
  const [patreon,       setPatreon]       = useState(initialPatreon);
  const [buyMeACoffee,  setBuyMeACoffee]  = useState(initialBuyMeACoffee);
  const [status,        setStatus]        = useState<SaveStatus>("idle");

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setStatus("saving");
    const res = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        donationPaypal:       paypal,
        donationVenmo:        venmo,
        donationZelle:        zelle,
        donationAmazon:       amazon,
        donationPatreon:      patreon,
        donationBuyMeACoffee: buyMeACoffee,
      }),
    });
    const data: { ok: boolean } = await res.json();
    setStatus(data.ok ? "ok" : "error");
    setTimeout(() => setStatus("idle"), 3000);
  }

  return (
    <form onSubmit={handleSave} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="donation-paypal">PayPal</Label>
        <Input
          id="donation-paypal"
          value={paypal}
          onChange={(e) => { setPaypal(e.target.value); setStatus("idle"); }}
          placeholder="paypal.me/yourname or email address"
          className="bg-zinc-800 border-zinc-700 text-sm"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="donation-venmo">Venmo</Label>
        <Input
          id="donation-venmo"
          value={venmo}
          onChange={(e) => { setVenmo(e.target.value); setStatus("idle"); }}
          placeholder="@your-venmo-handle"
          className="bg-zinc-800 border-zinc-700 text-sm"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="donation-zelle">Zelle</Label>
        <Input
          id="donation-zelle"
          value={zelle}
          onChange={(e) => { setZelle(e.target.value); setStatus("idle"); }}
          placeholder="Email or phone number registered with Zelle"
          className="bg-zinc-800 border-zinc-700 text-sm"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="donation-amazon">Amazon Wishlist</Label>
        <Input
          id="donation-amazon"
          value={amazon}
          onChange={(e) => { setAmazon(e.target.value); setStatus("idle"); }}
          placeholder="https://www.amazon.com/hz/wishlist/ls/…"
          className="bg-zinc-800 border-zinc-700 text-sm"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="donation-patreon">Patreon</Label>
        <Input
          id="donation-patreon"
          value={patreon}
          onChange={(e) => { setPatreon(e.target.value); setStatus("idle"); }}
          placeholder="your-patreon-handle or full Patreon URL"
          className="bg-zinc-800 border-zinc-700 text-sm"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="donation-bmac">Buy Me a Coffee</Label>
        <Input
          id="donation-bmac"
          value={buyMeACoffee}
          onChange={(e) => { setBuyMeACoffee(e.target.value); setStatus("idle"); }}
          placeholder="your-bmac-handle or full Buy Me a Coffee URL"
          className="bg-zinc-800 border-zinc-700 text-sm"
        />
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={status === "saving"} className="bg-indigo-600 hover:bg-indigo-500">
          {status === "saving" ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Saving…</> : "Save"}
        </Button>
        {status === "ok"    && <span className="flex items-center gap-1.5 text-sm text-green-400"><CheckCircle className="w-4 h-4" />Saved</span>}
        {status === "error" && <span className="flex items-center gap-1.5 text-sm text-red-400"><XCircle className="w-4 h-4" />Failed to save</span>}
      </div>
    </form>
  );
}

interface RateLimitFormProps {
  initialRegister: string;
  initialRequests: string;
  initialIssues: string;
  initialMaxPushSubscriptions: string;
}

export function RateLimitForm({ initialRegister, initialRequests, initialIssues, initialMaxPushSubscriptions }: RateLimitFormProps) {
  const [register, setRegister] = useState(initialRegister);
  const [requests, setRequests] = useState(initialRequests);
  const [issues, setIssues] = useState(initialIssues);
  const [maxPushSubscriptions, setMaxPushSubscriptions] = useState(initialMaxPushSubscriptions);
  const [status, setStatus] = useState<SaveStatus>("idle");

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setStatus("saving");
    const res = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        rateLimitRegister: register,
        rateLimitRequests: requests,
        rateLimitIssues: issues,
        maxPushSubscriptions,
      }),
    });
    const data: { ok: boolean } = await res.json();
    setStatus(data.ok ? "ok" : "error");
    setTimeout(() => setStatus("idle"), 3000);
  }

  return (
    <form onSubmit={handleSave} className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="rl-register">Registrations <span className="text-zinc-500 font-normal">per 15 min</span></Label>
          <Input
            id="rl-register"
            type="number"
            min="0"
            value={register}
            onChange={(e) => { setRegister(e.target.value); setStatus("idle"); }}
            placeholder="5"
            className="bg-zinc-800 border-zinc-700 text-sm"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="rl-requests">Requests <span className="text-zinc-500 font-normal">per min</span></Label>
          <Input
            id="rl-requests"
            type="number"
            min="0"
            value={requests}
            onChange={(e) => { setRequests(e.target.value); setStatus("idle"); }}
            placeholder="20"
            className="bg-zinc-800 border-zinc-700 text-sm"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="rl-issues">Issue reports <span className="text-zinc-500 font-normal">per min</span></Label>
          <Input
            id="rl-issues"
            type="number"
            min="0"
            value={issues}
            onChange={(e) => { setIssues(e.target.value); setStatus("idle"); }}
            placeholder="10"
            className="bg-zinc-800 border-zinc-700 text-sm"
          />
        </div>
      </div>
      <p className="text-xs text-zinc-500">Set to 0 to disable rate limiting for that endpoint.</p>
      <div className="border-t border-zinc-800 pt-4">
        <div className="space-y-1.5 max-w-[180px]">
          <Label htmlFor="rl-push-subs">Push devices <span className="text-zinc-500 font-normal">max per user</span></Label>
          <Input
            id="rl-push-subs"
            type="number"
            min="0"
            value={maxPushSubscriptions}
            onChange={(e) => { setMaxPushSubscriptions(e.target.value); setStatus("idle"); }}
            placeholder="5"
            className="bg-zinc-800 border-zinc-700 text-sm"
          />
          <p className="text-xs text-zinc-500">Maximum push-notification devices per account. Oldest is evicted automatically. Set to 0 for no limit.</p>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={status === "saving"} className="bg-indigo-600 hover:bg-indigo-500">
          {status === "saving" ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Saving…</> : "Save"}
        </Button>
        {status === "ok"    && <span className="flex items-center gap-1.5 text-sm text-green-400"><CheckCircle className="w-4 h-4" />Saved</span>}
        {status === "error" && <span className="flex items-center gap-1.5 text-sm text-red-400"><XCircle className="w-4 h-4" />Failed to save</span>}
      </div>
    </form>
  );
}

interface SessionFormProps {
  initialDefaultDuration: string;
  initialMobileDuration: string;
  initialMaxDuration: string;
}

export function SessionForm({ initialDefaultDuration, initialMobileDuration, initialMaxDuration }: SessionFormProps) {
  const [defaultDuration, setDefaultDuration] = useState(initialDefaultDuration);
  const [mobileDuration,  setMobileDuration]  = useState(initialMobileDuration);
  const [maxDuration,     setMaxDuration]     = useState(initialMaxDuration);
  const [status, setStatus] = useState<SaveStatus>("idle");

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setStatus("saving");
    const res = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionDefaultDuration: defaultDuration,
        sessionMobileDuration:  mobileDuration,
        sessionMaxDuration:     maxDuration,
      }),
    });
    const data: { ok: boolean } = await res.json();
    setStatus(data.ok ? "ok" : "error");
    setTimeout(() => setStatus("idle"), 3000);
  }

  return (
    <form onSubmit={handleSave} className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="session-default">Desktop session <span className="text-zinc-500 font-normal">seconds</span></Label>
          <Input
            id="session-default"
            type="number"
            min="60"
            value={defaultDuration}
            onChange={(e) => { setDefaultDuration(e.target.value); setStatus("idle"); }}
            placeholder="3600"
            className="bg-zinc-800 border-zinc-700 text-sm"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="session-mobile">Mobile session <span className="text-zinc-500 font-normal">seconds</span></Label>
          <Input
            id="session-mobile"
            type="number"
            min="60"
            value={mobileDuration}
            onChange={(e) => { setMobileDuration(e.target.value); setStatus("idle"); }}
            placeholder="604800"
            className="bg-zinc-800 border-zinc-700 text-sm"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="session-max">Remember me <span className="text-zinc-500 font-normal">seconds</span></Label>
          <Input
            id="session-max"
            type="number"
            min="60"
            value={maxDuration}
            onChange={(e) => { setMaxDuration(e.target.value); setStatus("idle"); }}
            placeholder="2592000"
            className="bg-zinc-800 border-zinc-700 text-sm"
          />
        </div>
      </div>
      <p className="text-xs text-zinc-500">
        Desktop default: 3600 (1 h). Mobile default: 604800 (7 days). Remember me: 2592000 (30 days). Changes apply to new logins only.
      </p>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={status === "saving"} className="bg-indigo-600 hover:bg-indigo-500">
          {status === "saving" ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Saving…</> : "Save"}
        </Button>
        {status === "ok"    && <span className="flex items-center gap-1.5 text-sm text-green-400"><CheckCircle className="w-4 h-4" />Saved</span>}
        {status === "error" && <span className="flex items-center gap-1.5 text-sm text-red-400"><XCircle className="w-4 h-4" />Failed to save</span>}
      </div>
    </form>
  );
}

export function SiteTitleForm({ initialTitle }: { initialTitle: string }) {
  const [title, setTitle] = useState(initialTitle);
  const [status, setStatus] = useState<SaveStatus>("idle");

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setStatus("saving");
    const res = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ siteTitle: title }),
    });
    const data: { ok: boolean } = await res.json();
    setStatus(data.ok ? "ok" : "error");
    setTimeout(() => setStatus("idle"), 3000);
  }

  return (
    <form onSubmit={handleSave} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="site-title">Site name</Label>
        <Input
          id="site-title"
          value={title}
          onChange={(e) => { setTitle(e.target.value); setStatus("idle"); }}
          placeholder="Summonarr"
          className="bg-zinc-800 border-zinc-700 text-sm"
        />
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={status === "saving"} className="bg-indigo-600 hover:bg-indigo-500">
          {status === "saving" ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Saving…</> : "Save"}
        </Button>
        {status === "ok"    && <span className="flex items-center gap-1.5 text-sm text-green-400"><CheckCircle className="w-4 h-4" />Saved</span>}
        {status === "error" && <span className="flex items-center gap-1.5 text-sm text-red-400"><XCircle className="w-4 h-4" />Failed to save</span>}
      </div>
    </form>
  );
}

export function SiteUrlForm({ initialUrl }: { initialUrl: string }) {
  const [url, setUrl] = useState(initialUrl);
  const [status, setStatus] = useState<SaveStatus>("idle");

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setStatus("saving");
    const res = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ siteUrl: url }),
    });
    const data: { ok: boolean } = await res.json();
    setStatus(data.ok ? "ok" : "error");
    setTimeout(() => setStatus("idle"), 3000);
  }

  return (
    <form onSubmit={handleSave} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="site-url">Public URL</Label>
        <Input
          id="site-url"
          type="url"
          value={url}
          onChange={(e) => { setUrl(e.target.value); setStatus("idle"); }}
          placeholder="https://request.yourdomain.com"
          className="bg-zinc-800 border-zinc-700 text-sm"
        />
        <p className="text-xs text-zinc-500">
          The public address users reach this site at. Used in Plex sign-in redirects — set this to avoid exposing your server IP.
        </p>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={status === "saving"} className="bg-indigo-600 hover:bg-indigo-500">
          {status === "saving" ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Saving…</> : "Save"}
        </Button>
        {status === "ok"    && <span className="flex items-center gap-1.5 text-sm text-green-400"><CheckCircle className="w-4 h-4" />Saved</span>}
        {status === "error" && <span className="flex items-center gap-1.5 text-sm text-red-400"><XCircle className="w-4 h-4" />Failed to save</span>}
      </div>
    </form>
  );
}

interface MaintenanceFormProps {
  initialEnabled: boolean;
  initialMessage: string;
}

export function MaintenanceForm({ initialEnabled, initialMessage }: MaintenanceFormProps) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [message, setMessage] = useState(initialMessage);
  const [status, setStatus] = useState<SaveStatus>("idle");

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setStatus("saving");
    const res = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        maintenanceEnabled: enabled ? "true" : "false",
        maintenanceMessage: message,
      }),
    });
    const data: { ok: boolean } = await res.json();
    setStatus(data.ok ? "ok" : "error");
    setTimeout(() => setStatus("idle"), 3000);
  }

  return (
    <form onSubmit={handleSave} className="space-y-4">
      <div className="flex items-center gap-3">
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          onClick={() => { setEnabled(!enabled); setStatus("idle"); }}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${enabled ? "bg-yellow-600" : "bg-zinc-700"}`}
        >
          <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${enabled ? "translate-x-6" : "translate-x-1"}`} />
        </button>
        <span className="text-sm text-zinc-300">{enabled ? "Maintenance mode is ON" : "Maintenance mode is OFF"}</span>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="maintenance-message">Custom Message <span className="text-zinc-500 font-normal">(optional)</span></Label>
        <textarea
          id="maintenance-message"
          value={message}
          onChange={(e) => { setMessage(e.target.value); setStatus("idle"); }}
          placeholder="We're performing some maintenance. Please check back shortly."
          rows={3}
          className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
        />
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={status === "saving"} className="bg-indigo-600 hover:bg-indigo-500">
          {status === "saving" ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Saving…</> : "Save"}
        </Button>
        {status === "ok"    && <span className="flex items-center gap-1.5 text-sm text-green-400"><CheckCircle className="w-4 h-4" />Saved</span>}
        {status === "error" && <span className="flex items-center gap-1.5 text-sm text-red-400"><XCircle className="w-4 h-4" />Failed to save</span>}
      </div>
    </form>
  );
}

interface MotdFormProps {
  initialEnabled: boolean;
  initialTitle: string;
  initialBody: string;
}

export function MotdForm({ initialEnabled, initialTitle, initialBody }: MotdFormProps) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [title,  setTitle]  = useState(initialTitle);
  const [body,   setBody]   = useState(initialBody);
  const [motdStatus, setMotdStatus] = useState<SaveStatus>("idle");

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setMotdStatus("saving");
    const res = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ motdEnabled: enabled ? "true" : "false", motdTitle: title, motdBody: body }),
    });
    const data: { ok: boolean } = await res.json();
    setMotdStatus(data.ok ? "ok" : "error");
    setTimeout(() => setMotdStatus("idle"), 3000);
  }

  return (
    <form onSubmit={handleSave} className="space-y-4">
      <div className="flex items-center justify-between gap-4 pb-4 border-b border-zinc-800">
        <div>
          <p className="text-sm font-medium text-zinc-200">Show popup to users</p>
          <p className="text-xs text-zinc-500 mt-0.5">Disable to hide the popup without clearing the message content.</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          onClick={() => { setEnabled(!enabled); setMotdStatus("idle"); }}
          className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 focus:ring-offset-zinc-900 ${enabled ? "bg-indigo-600" : "bg-zinc-700"}`}
        >
          <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${enabled ? "translate-x-4" : "translate-x-0.5"}`} />
        </button>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="motd-title">Title <span className="text-zinc-500 font-normal">(optional)</span></Label>
        <Input
          id="motd-title"
          value={title}
          onChange={(e) => { setTitle(e.target.value); setMotdStatus("idle"); }}
          placeholder="Welcome!"
          className="bg-zinc-800 border-zinc-700 text-sm"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="motd-body">Message</Label>
        <textarea
          id="motd-body"
          value={body}
          onChange={(e) => { setBody(e.target.value); setMotdStatus("idle"); }}
          placeholder="Enter your message here."
          rows={4}
          className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
        />
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={motdStatus === "saving"} className="bg-indigo-600 hover:bg-indigo-500">
          {motdStatus === "saving" ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Saving…</> : "Save"}
        </Button>
        {motdStatus === "ok"    && <span className="flex items-center gap-1.5 text-sm text-green-400"><CheckCircle className="w-4 h-4" />Saved</span>}
        {motdStatus === "error" && <span className="flex items-center gap-1.5 text-sm text-red-400"><XCircle className="w-4 h-4" />Failed to save</span>}
      </div>
    </form>
  );
}

interface DiscordBotFormProps {
  initialBotToken: string;
  initialClientId: string;
  initialGuildId: string;
  initialPublicKey: string;
  initialAutoApproveRoles: string;
  initialRequireLinkedAccount: boolean;
  initialRequireLinkedAccountSite: boolean;
  initialAdminRequestChannelId: string;
  initialWelcomeChannelId: string;
  initialNotifyChannelId: string;
  initialInviteUrl: string;
  initialLinkedRoleId: string;
  initialPlexRoleId: string;
  initialJellyfinRoleId: string;
  initialAdminRoleId: string;
  initialIssueAdminRoleId: string;
}

export function DiscordBotForm({ initialBotToken, initialClientId, initialGuildId, initialPublicKey, initialAutoApproveRoles, initialRequireLinkedAccount, initialRequireLinkedAccountSite, initialAdminRequestChannelId, initialWelcomeChannelId, initialNotifyChannelId, initialInviteUrl, initialLinkedRoleId, initialPlexRoleId, initialJellyfinRoleId, initialAdminRoleId, initialIssueAdminRoleId }: DiscordBotFormProps) {
  const [botToken,          setBotToken]          = useState(initialBotToken);
  const [clientId,          setClientId]          = useState(initialClientId);
  const [guildId,           setGuildId]           = useState(initialGuildId);
  const [publicKey,         setPublicKey]         = useState(initialPublicKey);
  const [autoApproveRoles,       setAutoApproveRoles]       = useState(initialAutoApproveRoles);
  const [requireLinkedAccount,     setRequireLinkedAccount]     = useState(initialRequireLinkedAccount);
  const [requireLinkedAccountSite, setRequireLinkedAccountSite] = useState(initialRequireLinkedAccountSite);
  const [adminRequestChannelId,    setAdminRequestChannelId]    = useState(initialAdminRequestChannelId);
  const [welcomeChannelId,       setWelcomeChannelId]       = useState(initialWelcomeChannelId);
  const [notifyChannelId,        setNotifyChannelId]        = useState(initialNotifyChannelId);
  const [inviteUrl,         setInviteUrl]         = useState(initialInviteUrl);
  const [linkedRoleId,      setLinkedRoleId]      = useState(initialLinkedRoleId);
  const [plexRoleId,        setPlexRoleId]        = useState(initialPlexRoleId);
  const [jellyfinRoleId,    setJellyfinRoleId]    = useState(initialJellyfinRoleId);
  const [adminRoleId,       setAdminRoleId]       = useState(initialAdminRoleId);
  const [issueAdminRoleId,  setIssueAdminRoleId]  = useState(initialIssueAdminRoleId);
  const [status,           setStatus]           = useState<SaveStatus>("idle");
  const [message,          setMessage]          = useState("");
  const [guideOpen,        setGuideOpen]        = useState(false);
  const [regStatus,        setRegStatus]        = useState<"idle" | "loading" | "ok" | "error">("idle");
  const [regMessage,       setRegMessage]       = useState("");
  const [syncRolesStatus,  setSyncRolesStatus]  = useState<"idle" | "loading" | "ok" | "error">("idle");
  const [syncRolesMessage, setSyncRolesMessage] = useState("");
  const [tab, setTab] = useState<"core" | "channels" | "roles">("core");

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setStatus("saving");
    setMessage("");

    const res = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ discordBotToken: botToken, discordClientId: clientId, discordGuildId: guildId, discordPublicKey: publicKey, discordAutoApproveRoles: autoApproveRoles, discordRequireLinkedAccount: requireLinkedAccount ? "true" : "false", discordRequireLinkedAccountSite: requireLinkedAccountSite ? "true" : "false", discordAdminRequestChannelId: adminRequestChannelId, discordWelcomeChannelId: welcomeChannelId, discordNotifyChannelId: notifyChannelId, discordInviteUrl: inviteUrl, discordLinkedRoleId: linkedRoleId, discordPlexRoleId: plexRoleId, discordJellyfinRoleId: jellyfinRoleId, discordAdminRoleId: adminRoleId, discordIssueAdminRoleId: issueAdminRoleId }),
    });

    const data: { ok: boolean; error?: string } = await res.json();

    if (data.ok) {
      setMessage("Saved · Restart the bot for changes to take effect");
      setStatus("ok");
    } else {
      setMessage(data.error ?? "Failed to save");
      setStatus("error");
    }
    setTimeout(() => setStatus("idle"), 5000);
  }

  return (
    <div className="space-y-5">
      <div className="rounded-md border border-zinc-700 overflow-hidden">
        <button
          type="button"
          onClick={() => setGuideOpen((v) => !v)}
          className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium text-zinc-300 hover:bg-zinc-800 transition-colors"
        >
          <span>Setup guide</span>
          <ChevronDown className={`w-4 h-4 text-zinc-500 transition-transform duration-200 ${guideOpen ? "rotate-180" : ""}`} />
        </button>

        {guideOpen && (
          <div className="px-4 pb-4 pt-1 border-t border-zinc-700 space-y-4 text-sm text-zinc-400">

            <div className="space-y-1">
              <p className="font-semibold text-zinc-200">1. Create a Discord application</p>
              <p>Go to the Discord Developer Portal and create a new application.</p>
              <a
                href="https://discord.com/developers/applications"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-indigo-400 hover:text-indigo-300 text-xs"
              >
                discord.com/developers/applications <ExternalLink className="w-3 h-3" />
              </a>
            </div>

            <div className="space-y-1">
              <p className="font-semibold text-zinc-200">2. Get the Bot Token</p>
              <p>
                Go to <span className="text-zinc-300">Bot</span> in the left sidebar. Click{" "}
                <span className="text-zinc-300">Reset Token</span> and copy the value — paste it into
                the <span className="text-zinc-300">Bot Token</span> field below.
              </p>
              <p className="text-zinc-500 text-xs">
                Also check that <strong className="text-zinc-400">Requires OAuth2 Code Grant</strong> is <strong className="text-zinc-400">OFF</strong> — if enabled, the invite URL will fail with a &quot;code grant&quot; error.
              </p>
            </div>

            <div className="space-y-1">
              <p className="font-semibold text-zinc-200">3. Copy the Client ID and Public Key</p>
              <p>
                Go to <span className="text-zinc-300">General Information</span>. Copy the{" "}
                <span className="text-zinc-300">Application ID</span> into the Client ID field below, and
                copy the <span className="text-zinc-300">Public Key</span> into the Public Key field below.
                The Public Key is required to verify that interactions come from Discord.
              </p>
            </div>

            <div className="space-y-1">
              <p className="font-semibold text-zinc-200">4. Set the Guild (Server) ID</p>
              <p>
                Enable <span className="text-zinc-300">Developer Mode</span> in Discord user settings
                (Appearance → Advanced). Right-click your server icon and select{" "}
                <span className="text-zinc-300">Copy Server ID</span>. Paste it in the{" "}
                <span className="text-zinc-300">Guild (Server) ID</span> field below.
              </p>
              <p className="text-zinc-500 text-xs">
                Required — without it, commands are registered globally and take up to 1 hour to appear.
              </p>
            </div>

            <div className="space-y-1">
              <p className="font-semibold text-zinc-200">5. Save settings &amp; register slash commands</p>
              <p>Save the fields below, then click <span className="text-zinc-300">Register Slash Commands</span> below. You should see a confirmation that commands were registered to your guild.</p>
            </div>

            <div className="space-y-1">
              <p className="font-semibold text-zinc-200">6. Set the Interactions Endpoint URL</p>
              <p>
                Go back to <span className="text-zinc-300">General Information</span> in the Developer Portal.
                Set the <span className="text-zinc-300">Interactions Endpoint URL</span> to:
              </p>
              <code className="block bg-zinc-900 border border-zinc-700 rounded px-3 py-2 text-xs font-mono text-zinc-300 mt-1">
                https:
              </code>
              <p className="text-zinc-500 text-xs mt-1">
                Discord will send a verification ping — your app must respond with a valid PONG for the URL to be accepted. Make sure the Public Key is saved first (step 3). Click <strong className="text-zinc-400">Save Changes</strong>.
              </p>
            </div>

            <div className="space-y-1">
              <p className="font-semibold text-zinc-200">7. Invite the bot to your server</p>
              <p>
                Go to <span className="text-zinc-300">OAuth2 → URL Generator</span>. Check the{" "}
                <span className="text-zinc-300">bot</span> and{" "}
                <span className="text-zinc-300">applications.commands</span> scopes. Under Bot Permissions
                check <span className="text-zinc-300">Send Messages</span>,{" "}
                <span className="text-zinc-300">Embed Links</span>, and{" "}
                <span className="text-zinc-300">View Channels</span>.
                Copy the <strong className="text-zinc-400">Generated URL</strong> and open it to add the bot to your server.
              </p>
              <p className="text-zinc-500 text-xs">
                Use the OAuth2 URL Generator — do not use the &quot;Discord Provided Link&quot; from the Installation page.
              </p>
            </div>

            <div className="space-y-1">
              <p className="font-semibold text-zinc-200">8. Set up a notification channel <span className="text-zinc-500 font-normal">(optional)</span></p>
              <p>
                Instead of sending approval and download notifications as DMs, the bot can post them in a dedicated channel and ping the user with an <span className="text-zinc-300">@mention</span>.
              </p>
              <ol className="list-decimal list-inside space-y-1 text-zinc-400 text-sm pl-1">
                <li>
                  In Discord, create or choose a channel (e.g. <span className="text-zinc-300">#requests</span> or <span className="text-zinc-300">#notifications</span>).
                </li>
                <li>
                  Right-click the channel → <span className="text-zinc-300">Edit Channel</span> → <span className="text-zinc-300">Permissions</span>. Make sure the bot role has <span className="text-zinc-300">View Channel</span> and <span className="text-zinc-300">Send Messages</span> enabled. If the channel is private, you must explicitly add the bot role.
                </li>
                <li>
                  Enable <span className="text-zinc-300">Developer Mode</span> in Discord user settings (<span className="text-zinc-300">App Settings → Advanced</span>).
                </li>
                <li>
                  Right-click the channel name → <span className="text-zinc-300">Copy Channel ID</span>.
                </li>
                <li>
                  Paste it into the <span className="text-zinc-300">Notification Channel ID</span> field below and save.
                </li>
              </ol>
              <p className="text-zinc-500 text-xs mt-1">
                Leave the field blank to keep using DMs instead. When a channel is set, every notification is posted there as <code className="text-zinc-400">@Username message</code> so the user gets a ping.
              </p>
            </div>

            <div className="rounded-md bg-zinc-900 border border-zinc-700 px-3 py-3 space-y-1">
              <p className="font-semibold text-zinc-300 text-xs uppercase tracking-wide mb-2">Available slash commands</p>
              <div className="space-y-1.5 text-xs font-mono">
                <p><span className="text-indigo-400">/request</span> <span className="text-zinc-500">type:Movie|TV Show  query:&lt;title&gt;</span></p>
                <p className="text-zinc-500 pl-3">Search and request a movie or TV show — no account linking required</p>
                <p className="mt-1"><span className="text-indigo-400">/status</span></p>
                <p className="text-zinc-500 pl-3">Check your recent request statuses</p>
                <p className="mt-1"><span className="text-indigo-400">/link</span> <span className="text-zinc-500">token:&lt;8-char code&gt;</span></p>
                <p className="text-zinc-500 pl-3">Link your Discord account to your web account — generate the token on your Profile page</p>
              </div>
            </div>

          </div>
        )}
      </div>

      <div className="flex gap-1 border-b border-zinc-800">
        {(["core", "channels", "roles"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium capitalize transition-colors border-b-2 -mb-px ${
              tab === t
                ? "border-indigo-500 text-white"
                : "border-transparent text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {}
      <form onSubmit={handleSave} className="space-y-4">
        {tab === "core" && (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="discord-token">Bot Token</Label>
              <Input
                id="discord-token"
                type="password"
                value={botToken}
                onChange={(e) => { setBotToken(e.target.value); setStatus("idle"); }}
                placeholder="••••••••••••••••"
                className="bg-zinc-800 border-zinc-700 font-mono text-sm"
              />
              <p className="text-xs text-zinc-500">From the Bot page of your Discord application (step 2).</p>
            </div>
            <div className="lg:grid lg:grid-cols-2 lg:gap-4 space-y-4 lg:space-y-0">
              <div className="space-y-1.5">
                <Label htmlFor="discord-client-id">Application (Client) ID</Label>
                <Input
                  id="discord-client-id"
                  value={clientId}
                  onChange={(e) => { setClientId(e.target.value); setStatus("idle"); }}
                  placeholder="123456789012345678"
                  className="bg-zinc-800 border-zinc-700 font-mono text-sm"
                />
                <p className="text-xs text-zinc-500">From the General Information page (step 3).</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="discord-guild-id">Guild (Server) ID</Label>
                <Input
                  id="discord-guild-id"
                  value={guildId}
                  onChange={(e) => { setGuildId(e.target.value); setStatus("idle"); }}
                  placeholder="123456789012345678"
                  className="bg-zinc-800 border-zinc-700 font-mono text-sm"
                />
                <p className="text-xs text-zinc-500">Your Discord server ID (step 4). Required for instant slash command registration.</p>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="discord-public-key">Public Key</Label>
              <Input
                id="discord-public-key"
                value={publicKey}
                onChange={(e) => { setPublicKey(e.target.value); setStatus("idle"); }}
                placeholder="f8cf3a985f811b4e…"
                className="bg-zinc-800 border-zinc-700 font-mono text-sm"
              />
              <p className="text-xs text-zinc-500">From General Information → Public Key (step 3). Required for HTTP interaction signature verification.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="discord-auto-approve-roles">Auto-Approve Role IDs</Label>
              <Input
                id="discord-auto-approve-roles"
                value={autoApproveRoles}
                onChange={(e) => { setAutoApproveRoles(e.target.value); setStatus("idle"); }}
                placeholder="123456789012345678, 987654321098765432"
                className="bg-zinc-800 border-zinc-700 font-mono text-sm"
              />
              <p className="text-xs text-zinc-500">
                Comma-separated Discord role IDs. Members with any of these roles will have their requests auto-approved and sent to download — without admin review.
                Right-click a role in Discord (Developer Mode on) to copy its ID.
              </p>
            </div>
            <div className="flex items-start gap-3">
              <input
                type="checkbox"
                id="discord-require-linked-account"
                checked={requireLinkedAccount}
                onChange={(e) => { setRequireLinkedAccount(e.target.checked); setStatus("idle"); }}
                className="mt-0.5 h-4 w-4 rounded border-zinc-600 bg-zinc-800 accent-indigo-500"
              />
              <div>
                <Label htmlFor="discord-require-linked-account" className="cursor-pointer">Require linked site account for Discord requests</Label>
                <p className="text-xs text-zinc-500 mt-1">
                  When enabled, Discord users must link their account via <code className="text-zinc-400">/link</code> before using <code className="text-zinc-400">/request</code> or <code className="text-zinc-400">/status</code>.
                  Members with an Auto-Approve role are exempt — they can request without linking.
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <input
                type="checkbox"
                id="discord-require-linked-account-site"
                checked={requireLinkedAccountSite}
                onChange={(e) => { setRequireLinkedAccountSite(e.target.checked); setStatus("idle"); }}
                className="mt-0.5 h-4 w-4 rounded border-zinc-600 bg-zinc-800 accent-indigo-500"
              />
              <div>
                <Label htmlFor="discord-require-linked-account-site" className="cursor-pointer">Require linked Discord account for site requests</Label>
                <p className="text-xs text-zinc-500 mt-1">
                  When enabled, users logged into the site must also link a Discord account before they can submit requests.
                  Leave off to allow site users to request without Discord.
                </p>
              </div>
            </div>
          </>
        )}

        {tab === "channels" && (
          <>
            <div className="lg:grid lg:grid-cols-2 lg:gap-4 space-y-4 lg:space-y-0">
              <div className="space-y-1.5">
                <Label htmlFor="discord-admin-request-channel">Admin Request Channel ID</Label>
                <Input
                  id="discord-admin-request-channel"
                  value={adminRequestChannelId}
                  onChange={(e) => { setAdminRequestChannelId(e.target.value); setStatus("idle"); }}
                  placeholder="123456789012345678"
                  className="bg-zinc-800 border-zinc-700 font-mono text-sm"
                />
                <p className="text-xs text-zinc-500">
                  Optional. When set, every new pending request is posted to this channel as an embed with <strong className="text-zinc-400">Approve</strong> and <strong className="text-zinc-400">Decline</strong> buttons.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="discord-welcome-channel">Welcome Channel ID</Label>
                <Input
                  id="discord-welcome-channel"
                  value={welcomeChannelId}
                  onChange={(e) => { setWelcomeChannelId(e.target.value); setStatus("idle"); }}
                  placeholder="123456789012345678"
                  className="bg-zinc-800 border-zinc-700 font-mono text-sm"
                />
                <p className="text-xs text-zinc-500">
                  Optional. When set, <code className="text-zinc-400">/link</code> can only be used in this channel, and <code className="text-zinc-400">/request</code> / <code className="text-zinc-400">/status</code> are blocked there.
                </p>
              </div>
            </div>
            <div className="lg:grid lg:grid-cols-2 lg:gap-4 space-y-4 lg:space-y-0">
              <div className="space-y-1.5">
                <Label htmlFor="discord-notify-channel">Notification Channel ID</Label>
                <Input
                  id="discord-notify-channel"
                  value={notifyChannelId}
                  onChange={(e) => { setNotifyChannelId(e.target.value); setStatus("idle"); }}
                  placeholder="123456789012345678"
                  className="bg-zinc-800 border-zinc-700 font-mono text-sm"
                />
                <p className="text-xs text-zinc-500">
                  Optional. Approval and download notifications post here and the user is pinged with <code className="text-zinc-400">@mention</code>. Leave blank to send DMs.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="discord-invite-url">Server Invite URL</Label>
                <Input
                  id="discord-invite-url"
                  value={inviteUrl}
                  onChange={(e) => { setInviteUrl(e.target.value); setStatus("idle"); }}
                  placeholder="https://discord.gg/xxxxxxxxx"
                  className="bg-zinc-800 border-zinc-700 text-sm"
                />
                <p className="text-xs text-zinc-500">
                  Optional. Permanent invite link. When set, users without a linked Discord account are prompted to join.
                </p>
              </div>
            </div>
          </>
        )}

        {tab === "roles" && (
          <>
            <div className="lg:grid lg:grid-cols-2 lg:gap-4 space-y-4 lg:space-y-0">
              <div className="space-y-1.5">
                <Label htmlFor="discord-linked-role-id">Linked Role ID</Label>
                <Input
                  id="discord-linked-role-id"
                  value={linkedRoleId}
                  onChange={(e) => { setLinkedRoleId(e.target.value); setStatus("idle"); }}
                  placeholder="123456789012345678"
                  className="bg-zinc-800 border-zinc-700 font-mono text-sm"
                />
                <p className="text-xs text-zinc-500">
                  Optional. Assigned to every user when they link their Discord account — grants access to general server channels.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="discord-plex-role-id">Plex Role ID</Label>
                <Input
                  id="discord-plex-role-id"
                  value={plexRoleId}
                  onChange={(e) => { setPlexRoleId(e.target.value); setStatus("idle"); }}
                  placeholder="123456789012345678"
                  className="bg-zinc-800 border-zinc-700 font-mono text-sm"
                />
                <p className="text-xs text-zinc-500">Optional. Assigned to users who linked via a Plex account.</p>
              </div>
            </div>
            <div className="lg:grid lg:grid-cols-2 lg:gap-4 space-y-4 lg:space-y-0">
              <div className="space-y-1.5">
                <Label htmlFor="discord-jellyfin-role-id">Jellyfin Role ID</Label>
                <Input
                  id="discord-jellyfin-role-id"
                  value={jellyfinRoleId}
                  onChange={(e) => { setJellyfinRoleId(e.target.value); setStatus("idle"); }}
                  placeholder="123456789012345678"
                  className="bg-zinc-800 border-zinc-700 font-mono text-sm"
                />
                <p className="text-xs text-zinc-500">Optional. Assigned to users who linked via a Jellyfin account.</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="discord-admin-role-id">Admin Role ID</Label>
                <Input
                  id="discord-admin-role-id"
                  value={adminRoleId}
                  onChange={(e) => { setAdminRoleId(e.target.value); setStatus("idle"); }}
                  placeholder="123456789012345678"
                  className="bg-zinc-800 border-zinc-700 font-mono text-sm"
                />
                <p className="text-xs text-zinc-500">Optional. Assigned to Admin-role users when they link.</p>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="discord-issue-admin-role-id">Issue Admin Role ID</Label>
              <Input
                id="discord-issue-admin-role-id"
                value={issueAdminRoleId}
                onChange={(e) => { setIssueAdminRoleId(e.target.value); setStatus("idle"); }}
                placeholder="123456789012345678"
                className="bg-zinc-800 border-zinc-700 font-mono text-sm"
              />
              <p className="text-xs text-zinc-500">
                Optional. Assigned to Issue Admin-role users when they link.
              </p>
            </div>
          </>
        )}

        <div className="flex items-center gap-3">
          <Button type="submit" disabled={status === "saving"} className="bg-indigo-600 hover:bg-indigo-500">
            {status === "saving" ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Saving…</> : "Save"}
          </Button>
          {status === "ok"    && <span className="flex items-center gap-1.5 text-sm text-green-400"><CheckCircle className="w-4 h-4" />{message}</span>}
          {status === "error" && <span className="flex items-center gap-1.5 text-sm text-red-400"><XCircle className="w-4 h-4" />{message}</span>}
        </div>
      </form>

      <div className="border-t border-zinc-800 pt-4">
        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="outline"
            className="border-zinc-700 text-zinc-300 hover:bg-zinc-800"
            disabled={regStatus === "loading"}
            onClick={async () => {
              setRegStatus("loading");
              setRegMessage("");
              const res = await fetch("/api/discord/register-commands", { method: "POST" });
              const data: { ok?: boolean; error?: string; message?: string } = await res.json();
              if (data.ok) {
                setRegStatus("ok");
                setRegMessage(data.message ?? "Commands registered");
              } else {
                setRegStatus("error");
                setRegMessage(data.error ?? "Failed");
              }
              setTimeout(() => setRegStatus("idle"), 6000);
            }}
          >
            {regStatus === "loading" ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Registering…</> : "Register Slash Commands"}
          </Button>
          {regStatus === "ok"    && <span className="flex items-center gap-1.5 text-sm text-green-400"><CheckCircle className="w-4 h-4" />{regMessage}</span>}
          {regStatus === "error" && <span className="flex items-center gap-1.5 text-sm text-red-400"><XCircle className="w-4 h-4" />{regMessage}</span>}
        </div>
        <p className="text-xs text-zinc-500 mt-1.5">Re-registers slash commands with Discord. Run this after changing Guild ID or Bot Token.</p>
      </div>

      <div className="border-t border-zinc-800 pt-4">
        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="outline"
            className="border-zinc-700 text-zinc-300 hover:bg-zinc-800"
            disabled={syncRolesStatus === "loading"}
            onClick={async () => {
              setSyncRolesStatus("loading");
              setSyncRolesMessage("");
              try {
                const res = await fetch("/api/discord/sync-roles", { method: "POST" });
                const data: { synced?: number; error?: string } = await res.json();
                if (data.error) {
                  setSyncRolesStatus("error");
                  setSyncRolesMessage(data.error);
                } else {
                  setSyncRolesStatus("ok");
                  setSyncRolesMessage(`Synced ${data.synced ?? 0} user${data.synced !== 1 ? "s" : ""}`);
                }
              } catch {
                setSyncRolesStatus("error");
                setSyncRolesMessage("Request failed");
              }
              setTimeout(() => setSyncRolesStatus("idle"), 6000);
            }}
          >
            {syncRolesStatus === "loading" ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Syncing…</> : "Sync Discord Roles"}
          </Button>
          {syncRolesStatus === "ok"    && <span className="flex items-center gap-1.5 text-sm text-green-400"><CheckCircle className="w-4 h-4" />{syncRolesMessage}</span>}
          {syncRolesStatus === "error" && <span className="flex items-center gap-1.5 text-sm text-red-400"><XCircle className="w-4 h-4" />{syncRolesMessage}</span>}
        </div>
        <p className="text-xs text-zinc-500 mt-1.5">Assigns the Linked, Plex, and Jellyfin roles to all users who have already linked their Discord account. Run this once after configuring role IDs to backfill existing users.</p>
      </div>
    </div>
  );
}

interface EmailFormProps {
  initialBackend: "smtp" | "resend";
  initialHost: string;
  initialPort: string;
  initialUser: string;
  initialPassword: string;
  initialFrom: string;
  initialResendApiKey: string;
  initialResendFrom: string;
}

export function EmailForm({
  initialBackend,
  initialHost,
  initialPort,
  initialUser,
  initialPassword,
  initialFrom,
  initialResendApiKey,
  initialResendFrom,
}: EmailFormProps) {
  const [backend,      setBackend]      = useState<"smtp" | "resend">(initialBackend);
  const [host,         setHost]         = useState(initialHost);
  const [port,         setPort]         = useState(initialPort || "587");
  const [user,         setUser]         = useState(initialUser);
  const [password,     setPassword]     = useState(initialPassword);
  const [from,         setFrom]         = useState(initialFrom);
  const [resendApiKey, setResendApiKey] = useState(initialResendApiKey);
  const [resendFrom,   setResendFrom]   = useState(initialResendFrom);
  const [status,       setStatus]       = useState<SaveStatus>("idle");
  const [message,      setMessage]      = useState("");

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setStatus("saving");
    setMessage("");

    const body: Record<string, string> = { emailBackend: backend };
    if (backend === "smtp") {
      body.smtpHost = host;
      body.smtpPort = port;
      body.smtpUser = user;
      body.smtpPassword = password;
      body.smtpFrom = from;
    } else {
      body.resendApiKey = resendApiKey;
      body.resendFrom = resendFrom;
    }

    const res = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const data: { ok: boolean; error?: string; smtpError?: string; smtpTested?: boolean } = await res.json();

    if (data.ok) {
      setMessage(data.smtpTested ? "Saved · Test email sent" : "Saved");
      setStatus("ok");
    } else {
      setMessage(data.smtpError ?? data.error ?? "Failed to save");
      setStatus("error");
    }
  }

  const canSubmit = backend === "smtp" ? Boolean(host) : Boolean(resendApiKey);

  return (
    <form onSubmit={handleSave} className="space-y-4">
      <div className="space-y-1.5">
        <Label>Backend</Label>
        <div className="inline-flex rounded-lg border border-zinc-700 bg-zinc-800 p-1 text-sm">
          {(["smtp", "resend"] as const).map((b) => (
            <button
              key={b}
              type="button"
              onClick={() => { setBackend(b); setStatus("idle"); }}
              className={
                "px-3 py-1.5 rounded-md transition-colors " +
                (backend === b
                  ? "bg-zinc-700 text-white"
                  : "text-zinc-400 hover:text-zinc-200")
              }
            >
              {b === "smtp" ? "SMTP" : "Resend"}
            </button>
          ))}
        </div>
      </div>

      {backend === "smtp" ? (
        <>
          <div className="grid grid-cols-[1fr_100px] gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="smtp-host">SMTP Host</Label>
              <Input
                id="smtp-host"
                value={host}
                onChange={(e) => { setHost(e.target.value); setStatus("idle"); }}
                placeholder="smtp.example.com"
                className="bg-zinc-800 border-zinc-700 font-mono text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="smtp-port">Port</Label>
              <Input
                id="smtp-port"
                value={port}
                onChange={(e) => { setPort(e.target.value); setStatus("idle"); }}
                placeholder="587"
                className="bg-zinc-800 border-zinc-700 font-mono text-sm"
              />
            </div>
          </div>
          <div className="lg:grid lg:grid-cols-2 lg:gap-4 space-y-4 lg:space-y-0">
            <div className="space-y-1.5">
              <Label htmlFor="smtp-user">Username</Label>
              <Input
                id="smtp-user"
                value={user}
                onChange={(e) => { setUser(e.target.value); setStatus("idle"); }}
                placeholder="user@example.com"
                className="bg-zinc-800 border-zinc-700 text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="smtp-password">Password</Label>
              <Input
                id="smtp-password"
                type="password"
                value={password}
                onChange={(e) => { setPassword(e.target.value); setStatus("idle"); }}
                placeholder="••••••••••••••••"
                className="bg-zinc-800 border-zinc-700 font-mono text-sm"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="smtp-from">From Address</Label>
            <Input
              id="smtp-from"
              value={from}
              onChange={(e) => { setFrom(e.target.value); setStatus("idle"); }}
              placeholder="Summonarr <noreply@example.com>"
              className="bg-zinc-800 border-zinc-700 text-sm"
            />
            <p className="text-xs text-zinc-500">Leave blank to use the username as the sender.</p>
          </div>
        </>
      ) : (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="resend-api-key">Resend API Key</Label>
            <Input
              id="resend-api-key"
              type="password"
              value={resendApiKey}
              onChange={(e) => { setResendApiKey(e.target.value); setStatus("idle"); }}
              placeholder="re_••••••••••••••••"
              className="bg-zinc-800 border-zinc-700 font-mono text-sm"
            />
            <p className="text-xs text-zinc-500">
              Create one at{" "}
              <a href="https://resend.com/api-keys" target="_blank" rel="noreferrer" className="text-indigo-400 hover:underline">
                resend.com/api-keys
              </a>
              . Keys are stored encrypted.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="resend-from">From Address</Label>
            <Input
              id="resend-from"
              value={resendFrom}
              onChange={(e) => { setResendFrom(e.target.value); setStatus("idle"); }}
              placeholder="Summonarr <noreply@yourdomain.com>"
              className="bg-zinc-800 border-zinc-700 text-sm"
            />
            <p className="text-xs text-zinc-500">Must be a sender on a domain verified in your Resend account.</p>
          </div>
        </>
      )}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={status === "saving" || !canSubmit} className="bg-indigo-600 hover:bg-indigo-500">
          {status === "saving" ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Saving…</> : "Save & Test"}
        </Button>
        {status === "ok"    && <span className="flex items-center gap-1.5 text-sm text-green-400"><CheckCircle className="w-4 h-4" />{message}</span>}
        {status === "error" && <span className="flex items-center gap-1.5 text-sm text-red-400"><XCircle className="w-4 h-4" />{message}</span>}
      </div>
    </form>
  );
}

export function RatingsCacheClearButton() {
  const [status, setStatus] = useState<"idle" | "confirm" | "clearing" | "cleared" | "error">("idle");

  async function handleClear() {
    setStatus("clearing");
    const res = await fetch("/api/admin/clear-ratings-cache", { method: "DELETE" });
    if (res.ok) {
      const data = await res.json() as { cleared: number };
      console.log(`Cleared ${data.cleared} ratings cache entries`);
      setStatus("cleared");
    } else {
      setStatus("error");
    }
    setTimeout(() => setStatus("idle"), 3000);
  }

  return (
    <div className="pt-3 border-t border-zinc-800">
      <p className="text-xs text-zinc-500 mb-2">
        After changing API keys, clear the ratings cache to fetch fresh data on next page visit.
      </p>

      {status === "confirm" ? (
        <div className="flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-800/60 px-3 py-2.5 w-fit">
          <XCircle className="w-4 h-4 text-red-400 shrink-0" />
          <p className="text-sm text-zinc-200">Clear all cached ratings?</p>
          <Button
            type="button"
            size="sm"
            onClick={handleClear}
            className="bg-red-600 hover:bg-red-500 h-7 px-3 text-xs"
          >
            Clear
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setStatus("idle")}
            className="border-zinc-600 text-zinc-400 hover:text-white h-7 px-3 text-xs"
          >
            Cancel
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="outline"
            onClick={() => setStatus("confirm")}
            disabled={status === "clearing"}
            className="border-zinc-700 text-zinc-400 hover:text-white gap-2"
          >
            {status === "clearing" ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            Clear Ratings Cache
          </Button>
          {status === "cleared" && <span className="flex items-center gap-1.5 text-sm text-green-400"><CheckCircle className="w-4 h-4" />Cache cleared</span>}
          {status === "error"   && <span className="flex items-center gap-1.5 text-sm text-red-400"><XCircle className="w-4 h-4" />Failed</span>}
        </div>
      )}
    </div>
  );
}

export function RatingsWarmButton() {
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [results, setResults] = useState<{ omdb?: string; mdblist?: string } | null>(null);

  type MdblistWarmData = { fetched?: number; skipped?: number; total?: number; failed?: number; purged?: number; error?: string };

  async function runWarm(force: boolean) {
    setStatus("loading");
    setResults(null);
    try {
      const [omdbRes, mdblistRes] = await Promise.all([
        fetch("/api/admin/omdb-warm", { method: "POST" }),
        fetch("/api/admin/mdblist-warm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ force }),
        }),
      ]);

      const omdbData: { fetched?: number; skipped?: number; total?: number; failed?: number; error?: string } = await omdbRes.json();
      const mdblistData: MdblistWarmData = await mdblistRes.json();

      const omdbErr    = omdbData.error;
      const mdblistErr = mdblistData.error;

      const mdblistSummary = mdblistErr
        ?? `Fetched ${mdblistData.fetched ?? 0}, skipped ${mdblistData.skipped ?? 0}${(mdblistData.purged ?? 0) > 0 ? `, purged ${mdblistData.purged}` : ""}`;

      if (omdbErr || mdblistErr) {
        setStatus("error");
        setResults({
          omdb: omdbErr ?? `Fetched ${omdbData.fetched ?? 0}, skipped ${omdbData.skipped ?? 0}`,
          mdblist: mdblistSummary,
        });
      } else {
        setStatus("done");
        setResults({
          omdb: `Fetched ${omdbData.fetched ?? 0}, skipped ${omdbData.skipped ?? 0}`,
          mdblist: mdblistSummary,
        });
      }
    } catch {
      setStatus("error");
      setResults({ omdb: "Request failed" });
    }
    setTimeout(() => setStatus("idle"), 10000);
  }

  return (
    <div className="flex items-center gap-3 flex-wrap">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => runWarm(false)}
        disabled={status === "loading"}
        className="border-zinc-700 text-zinc-300 hover:text-white gap-2"
      >
        {status === "loading"
          ? <><Loader2 className="w-4 h-4 animate-spin" />Warming…</>
          : <><RefreshCw className="w-4 h-4" />Warm Ratings</>
        }
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => runWarm(true)}
        disabled={status === "loading"}
        className="border-zinc-700 text-zinc-400 hover:text-white gap-2"
        title="Purge all MDBList sentinels and re-fetch the entire library"
      >
        <RefreshCw className="w-4 h-4" />Full Sync
      </Button>
      {results && (
        <div className={`text-xs ${status === "error" ? "text-red-400" : "text-zinc-400"}`}>
          <div>OMDB: {results.omdb}</div>
          <div>MDBList: {results.mdblist}</div>
        </div>
      )}
      {status === "done" && (
        <CheckCircle className="w-4 h-4 text-green-400" />
      )}
    </div>
  );
}

export function ActivityWarmButton() {
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [result, setResult] = useState<string | null>(null);

  async function handleWarm() {
    setStatus("loading");
    setResult(null);
    try {
      const res = await fetch("/api/admin/activity-warm", { method: "POST" });
      const data: { warmed?: number; error?: string } = await res.json();
      if (data.error) {
        setStatus("error");
        setResult(data.error);
      } else {
        setStatus("done");
        setResult(`Warmed ${data.warmed ?? 0} entries`);
      }
    } catch {
      setStatus("error");
      setResult("Request failed");
    }
    setTimeout(() => setStatus("idle"), 10000);
  }

  return (
    <div className="flex items-center gap-3">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={handleWarm}
        disabled={status === "loading"}
        className="border-zinc-700 text-zinc-300 hover:text-white gap-2"
      >
        {status === "loading"
          ? <><Loader2 className="w-4 h-4 animate-spin" />Warming…</>
          : <><RefreshCw className="w-4 h-4" />Warm Activity</>
        }
      </Button>
      {result && (
        <span className={`text-xs ${status === "error" ? "text-red-400" : "text-zinc-400"}`}>
          {result}
        </span>
      )}
      {status === "done" && !result?.includes("error") && (
        <CheckCircle className="w-4 h-4 text-green-400" />
      )}
    </div>
  );
}

export function OmdbForm({ initialApiKey }: { initialApiKey: string }) {
  const [apiKey, setApiKey] = useState(initialApiKey);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "ok" | "error">("idle");
  const [testMessage, setTestMessage] = useState("");

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setStatus("saving");
    const res = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ omdbApiKey: apiKey }),
    });
    setStatus(res.ok ? "saved" : "error");
  }

  async function handleTest() {
    setTestStatus("testing");
    setTestMessage("");
    const res = await fetch("/api/settings/test-ratings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ service: "omdb" }),
    });
    const data = await res.json() as { ok: boolean; message?: string; error?: string };
    setTestStatus(data.ok ? "ok" : "error");
    setTestMessage(data.ok ? (data.message ?? "Connected") : (data.error ?? "Test failed"));
  }

  return (
    <form onSubmit={handleSave} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="omdb-key">OMDB API Key</Label>
        <Input
          id="omdb-key"
          type="password"
          value={apiKey}
          onChange={(e) => { setApiKey(e.target.value); setStatus("idle"); setTestStatus("idle"); }}
          placeholder="••••••••"
          className="bg-zinc-800 border-zinc-700 font-mono text-sm"
        />
        <p className="text-xs text-zinc-500">
          Enables IMDb and Rotten Tomatoes ratings on all detail pages. Get a free key at{" "}
          <a href="https://www.omdbapi.com/apikey.aspx" target="_blank" rel="noopener noreferrer" className="text-indigo-400 hover:underline">
            omdbapi.com
          </a>.
        </p>
      </div>
      <div className="flex items-center gap-3 flex-wrap">
        <Button type="submit" disabled={status === "saving"} className="bg-indigo-600 hover:bg-indigo-500">
          {status === "saving" ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Saving…</> : "Save"}
        </Button>
        <Button type="button" variant="outline" onClick={handleTest} disabled={testStatus === "testing"} className="border-zinc-700 text-zinc-400 hover:text-white gap-2">
          {testStatus === "testing" ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
          Test API
        </Button>
        {status === "saved" && <span className="flex items-center gap-1.5 text-sm text-green-400"><CheckCircle className="w-4 h-4" />Saved</span>}
        {status === "error"  && <span className="flex items-center gap-1.5 text-sm text-red-400"><XCircle className="w-4 h-4" />Failed to save</span>}
        {testStatus === "ok"    && <span className="flex items-center gap-1.5 text-sm text-green-400"><CheckCircle className="w-4 h-4" />{testMessage}</span>}
        {testStatus === "error" && <span className="flex items-center gap-1.5 text-sm text-red-400"><XCircle className="w-4 h-4" />{testMessage}</span>}
      </div>
    </form>
  );
}

export function MdblistForm({ initialApiKey }: { initialApiKey: string }) {
  const [apiKey, setApiKey] = useState(initialApiKey);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "ok" | "error">("idle");
  const [testMessage, setTestMessage] = useState("");

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setStatus("saving");
    const res = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mdblistApiKey: apiKey }),
    });
    setStatus(res.ok ? "saved" : "error");
  }

  async function handleTest() {
    setTestStatus("testing");
    setTestMessage("");
    const res = await fetch("/api/settings/test-ratings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ service: "mdblist" }),
    });
    const data = await res.json() as { ok: boolean; message?: string; error?: string };
    setTestStatus(data.ok ? "ok" : "error");
    setTestMessage(data.ok ? (data.message ?? "Connected") : (data.error ?? "Test failed"));
  }

  return (
    <form onSubmit={handleSave} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="mdblist-key">MDBList API Key</Label>
        <Input
          id="mdblist-key"
          type="password"
          value={apiKey}
          onChange={(e) => { setApiKey(e.target.value); setStatus("idle"); setTestStatus("idle"); }}
          placeholder="••••••••"
          className="bg-zinc-800 border-zinc-700 font-mono text-sm"
        />
        <p className="text-xs text-zinc-500">
          Adds RT Audience Score and Trakt ratings, and improves TV show coverage. Get a free key at{" "}
          <a href="https://mdblist.com/" target="_blank" rel="noopener noreferrer" className="text-indigo-400 hover:underline">
            mdblist.com
          </a>
          {" "}(Account → API). Free tier: 1,000 req/day.
        </p>
      </div>
      <div className="flex items-center gap-3 flex-wrap">
        <Button type="submit" disabled={status === "saving"} className="bg-indigo-600 hover:bg-indigo-500">
          {status === "saving" ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Saving…</> : "Save"}
        </Button>
        <Button type="button" variant="outline" onClick={handleTest} disabled={testStatus === "testing"} className="border-zinc-700 text-zinc-400 hover:text-white gap-2">
          {testStatus === "testing" ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
          Test API
        </Button>
        {status === "saved" && <span className="flex items-center gap-1.5 text-sm text-green-400"><CheckCircle className="w-4 h-4" />Saved</span>}
        {status === "error"  && <span className="flex items-center gap-1.5 text-sm text-red-400"><XCircle className="w-4 h-4" />Failed to save</span>}
        {testStatus === "ok"    && <span className="flex items-center gap-1.5 text-sm text-green-400"><CheckCircle className="w-4 h-4" />{testMessage}</span>}
        {testStatus === "error" && <span className="flex items-center gap-1.5 text-sm text-red-400"><XCircle className="w-4 h-4" />{testMessage}</span>}
      </div>
    </form>
  );
}

export function TraktForm({ initialApiKey }: { initialApiKey: string }) {
  const [apiKey, setApiKey] = useState(initialApiKey);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "ok" | "error">("idle");
  const [testMessage, setTestMessage] = useState("");

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setStatus("saving");
    const res = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ traktClientId: apiKey }),
    });
    setStatus(res.ok ? "saved" : "error");
  }

  async function handleTest() {
    setTestStatus("testing");
    setTestMessage("");
    const res = await fetch("/api/settings/test-ratings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ service: "trakt" }),
    });
    const data = await res.json() as { ok: boolean; message?: string; error?: string };
    setTestStatus(data.ok ? "ok" : "error");
    setTestMessage(data.ok ? (data.message ?? "Connected") : (data.error ?? "Test failed"));
  }

  return (
    <form onSubmit={handleSave} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="trakt-client-id">Trakt Client ID</Label>
        <Input
          id="trakt-client-id"
          type="password"
          value={apiKey}
          onChange={(e) => { setApiKey(e.target.value); setStatus("idle"); setTestStatus("idle"); }}
          placeholder="••••••••"
          className="bg-zinc-800 border-zinc-700 font-mono text-sm"
        />
        <p className="text-xs text-zinc-500">
          Adds Trakt popular and trending lists to the Top Rated page. Create a free app at{" "}
          <a href="https://trakt.tv/oauth/applications" target="_blank" rel="noopener noreferrer" className="text-indigo-400 hover:underline">
            trakt.tv/oauth/applications
          </a>
          {" "}and copy the Client ID.
        </p>
      </div>
      <div className="flex items-center gap-3 flex-wrap">
        <Button type="submit" disabled={status === "saving"} className="bg-indigo-600 hover:bg-indigo-500">
          {status === "saving" ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Saving…</> : "Save"}
        </Button>
        <Button type="button" variant="outline" onClick={handleTest} disabled={testStatus === "testing"} className="border-zinc-700 text-zinc-400 hover:text-white gap-2">
          {testStatus === "testing" ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
          Test API
        </Button>
        {status === "saved" && <span className="flex items-center gap-1.5 text-sm text-green-400"><CheckCircle className="w-4 h-4" />Saved</span>}
        {status === "error"  && <span className="flex items-center gap-1.5 text-sm text-red-400"><XCircle className="w-4 h-4" />Failed to save</span>}
        {testStatus === "ok"    && <span className="flex items-center gap-1.5 text-sm text-green-400"><CheckCircle className="w-4 h-4" />{testMessage}</span>}
        {testStatus === "error" && <span className="flex items-center gap-1.5 text-sm text-red-400"><XCircle className="w-4 h-4" />{testMessage}</span>}
      </div>
    </form>
  );
}

export function IpinfoForm({ initialApiKey }: { initialApiKey: string }) {
  const [apiKey, setApiKey] = useState(initialApiKey);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "ok" | "error">("idle");
  const [testMessage, setTestMessage] = useState("");

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setStatus("saving");
    const res = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ipinfoToken: apiKey }),
    });
    setStatus(res.ok ? "saved" : "error");
  }

  async function handleTest() {
    setTestStatus("testing");
    setTestMessage("");
    const res = await fetch("/api/settings/test-ratings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ service: "ipinfo" }),
    });
    const data = await res.json() as { ok: boolean; message?: string; error?: string };
    setTestStatus(data.ok ? "ok" : "error");
    setTestMessage(data.ok ? (data.message ?? "Connected") : (data.error ?? "Test failed"));
  }

  return (
    <form onSubmit={handleSave} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="ipinfo-token">ipinfo.io Access Token</Label>
        <Input
          id="ipinfo-token"
          type="password"
          value={apiKey}
          onChange={(e) => { setApiKey(e.target.value); setStatus("idle"); setTestStatus("idle"); }}
          placeholder="••••••••"
          className="bg-zinc-800 border-zinc-700 font-mono text-sm"
        />
        <p className="text-xs text-zinc-500">
          Resolves stream IPs to city, ISP, and approximate location on the activity pages. Get a free token at{" "}
          <a href="https://ipinfo.io/signup" target="_blank" rel="noopener noreferrer" className="text-indigo-400 hover:underline">
            ipinfo.io/signup
          </a>
          {" "}— free tier: 50,000 lookups/month. Results are cached per IP for 30 days.
        </p>
      </div>
      <div className="flex items-center gap-3 flex-wrap">
        <Button type="submit" disabled={status === "saving"} className="bg-indigo-600 hover:bg-indigo-500">
          {status === "saving" ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Saving…</> : "Save"}
        </Button>
        <Button type="button" variant="outline" onClick={handleTest} disabled={testStatus === "testing"} className="border-zinc-700 text-zinc-400 hover:text-white gap-2">
          {testStatus === "testing" ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
          Test API
        </Button>
        {status === "saved" && <span className="flex items-center gap-1.5 text-sm text-green-400"><CheckCircle className="w-4 h-4" />Saved</span>}
        {status === "error"  && <span className="flex items-center gap-1.5 text-sm text-red-400"><XCircle className="w-4 h-4" />Failed to save</span>}
        {testStatus === "ok"    && <span className="flex items-center gap-1.5 text-sm text-green-400"><CheckCircle className="w-4 h-4" />{testMessage}</span>}
        {testStatus === "error" && <span className="flex items-center gap-1.5 text-sm text-red-400"><XCircle className="w-4 h-4" />{testMessage}</span>}
      </div>
    </form>
  );
}

type MediaSampleData = { mountPoint: string; samples: string[] };
type ServerSamples   = { movie: MediaSampleData; tv: MediaSampleData };

interface LibraryMatchFormProps {
  initialPlexMoviePrefix:     string;
  initialPlexTvPrefix:        string;
  initialJellyfinMoviePrefix: string;
  initialJellyfinTvPrefix:    string;
}

export function LibraryMatchForm({
  initialPlexMoviePrefix,
  initialPlexTvPrefix,
  initialJellyfinMoviePrefix,
  initialJellyfinTvPrefix,
}: LibraryMatchFormProps) {
  const [plexMoviePrefix,     setPlexMoviePrefix]     = useState(initialPlexMoviePrefix);
  const [plexTvPrefix,        setPlexTvPrefix]        = useState(initialPlexTvPrefix);
  const [jellyfinMoviePrefix, setJellyfinMoviePrefix] = useState(initialJellyfinMoviePrefix);
  const [jellyfinTvPrefix,    setJellyfinTvPrefix]    = useState(initialJellyfinTvPrefix);
  const [saveStatus,          setSaveStatus]          = useState<SaveStatus>("idle");
  const [loading,             setLoading]             = useState(false);
  const [plex,                setPlex]                = useState<ServerSamples | null>(null);
  const [jellyfin,            setJellyfin]            = useState<ServerSamples | null>(null);
  const [loadError,           setLoadError]           = useState("");

  async function loadSamples() {
    setLoading(true);
    setLoadError("");
    try {
      const res = await fetch("/api/admin/library-sample-paths");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { plex: ServerSamples; jellyfin: ServerSamples };
      setPlex(data.plex);
      setJellyfin(data.jellyfin);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaveStatus("saving");
    const res = await fetch("/api/settings", {
      method:  "PATCH",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        plexMoviePathStripPrefix:     plexMoviePrefix,
        plexTvPathStripPrefix:        plexTvPrefix,
        jellyfinMoviePathStripPrefix: jellyfinMoviePrefix,
        jellyfinTvPathStripPrefix:    jellyfinTvPrefix,
      }),
    });
    const data: { ok: boolean } = await res.json();
    setSaveStatus(data.ok ? "ok" : "error");
    setTimeout(() => setSaveStatus("idle"), 3000);
  }

  function applyPrefix(path: string, prefix: string): string {
    if (!prefix) return path;
    const p = prefix.endsWith("/") ? prefix : prefix + "/";
    return path.startsWith(p) ? path.slice(p.length) : path;
  }

  function MediaBlock({
    mediaLabel, data, prefix, onChangePrefix, placeholder,
  }: {
    mediaLabel: string; data: MediaSampleData | null;
    prefix: string; onChangePrefix: (v: string) => void; placeholder: string;
  }) {
    return (
      <div className="space-y-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">{mediaLabel}</p>

        {data && (
          <>
            <div className="rounded bg-zinc-800/60 border border-zinc-700/60 px-3 py-2 space-y-0.5">
              <p className="text-[10px] text-zinc-600 uppercase tracking-wide">Mount point (auto-stripped)</p>
              <p className="text-xs text-zinc-300 font-mono">{data.mountPoint || "(none detected)"}</p>
            </div>

            <div className="rounded bg-zinc-800/60 border border-zinc-700/60 px-3 py-2 space-y-1">
              <p className="text-[10px] text-zinc-600 uppercase tracking-wide mb-1">Sample relative paths</p>
              {data.samples.length === 0
                ? <p className="text-[11px] text-zinc-600 italic">No paths found</p>
                : data.samples.map((s, i) => (
                    <p key={i} className="text-[11px] text-zinc-400 font-mono truncate" title={s}>{s}</p>
                  ))
              }
            </div>
          </>
        )}

        <div className="space-y-1">
          <Label className="text-xs text-zinc-400">Additional prefix to strip</Label>
          <Input
            value={prefix}
            onChange={(e) => { onChangePrefix(e.target.value); setSaveStatus("idle"); }}
            placeholder={placeholder}
            className="bg-zinc-800 border-zinc-700 font-mono text-sm h-8"
          />
        </div>

        {data && prefix && (
          <div className="rounded bg-zinc-800/60 border border-zinc-700/60 px-3 py-2 space-y-1">
            <p className="text-[10px] text-zinc-600 uppercase tracking-wide mb-1">Preview after stripping</p>
            {data.samples.map((s, i) => {
              const after   = applyPrefix(s, prefix);
              const changed = after !== s;
              return (
                <p key={i} className={`text-[11px] font-mono truncate ${changed ? "text-green-400" : "text-zinc-500"}`} title={after}>
                  {after}
                </p>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  function ServerBlock({
    label, accent, data, moviePrefix, tvPrefix, onChangeMoviePrefix, onChangeTvPrefix,
  }: {
    label: string; accent: string; data: ServerSamples | null;
    moviePrefix: string; tvPrefix: string;
    onChangeMoviePrefix: (v: string) => void; onChangeTvPrefix: (v: string) => void;
  }) {
    return (
      <div className="space-y-4">
        <p className={`text-xs font-semibold uppercase tracking-wide ${accent}`}>{label}</p>

        {!data && !loading && (
          <p className="text-xs text-zinc-600 italic">Click &quot;Load examples&quot; to see sample paths.</p>
        )}
        {loadError && <p className="text-xs text-red-400">{loadError}</p>}

        {data && (
          <div className="space-y-5">
            <MediaBlock
              mediaLabel="Movies"
              data={data.movie}
              prefix={moviePrefix}
              onChangePrefix={onChangeMoviePrefix}
              placeholder="e.g. movies/"
            />
            <div className="border-t border-zinc-800" />
            <MediaBlock
              mediaLabel="TV Shows"
              data={data.tv}
              prefix={tvPrefix}
              onChangePrefix={onChangeTvPrefix}
              placeholder="e.g. tv/"
            />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm text-zinc-400">
          Strip prefixes per server and media type so relative paths align when comparing Plex and Jellyfin for bad-match detection.
        </p>
        <Button
          type="button"
          variant="outline"
          onClick={loadSamples}
          disabled={loading}
          className="border-zinc-700 text-zinc-400 hover:text-white gap-2 shrink-0"
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          Load examples
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <ServerBlock
          label="Plex" accent="text-yellow-400"
          data={plex}
          moviePrefix={plexMoviePrefix} tvPrefix={plexTvPrefix}
          onChangeMoviePrefix={setPlexMoviePrefix} onChangeTvPrefix={setPlexTvPrefix}
        />
        <ServerBlock
          label="Jellyfin" accent="text-purple-400"
          data={jellyfin}
          moviePrefix={jellyfinMoviePrefix} tvPrefix={jellyfinTvPrefix}
          onChangeMoviePrefix={setJellyfinMoviePrefix} onChangeTvPrefix={setJellyfinTvPrefix}
        />
      </div>

      <form onSubmit={handleSave} className="flex items-center gap-3 flex-wrap">
        <Button type="submit" disabled={saveStatus === "saving"} className="bg-indigo-600 hover:bg-indigo-500">
          {saveStatus === "saving" ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Saving…</> : "Save"}
        </Button>
        {saveStatus === "ok"    && <span className="flex items-center gap-1.5 text-sm text-green-400"><CheckCircle className="w-4 h-4" />Saved</span>}
        {saveStatus === "error" && <span className="flex items-center gap-1.5 text-sm text-red-400"><XCircle className="w-4 h-4" />Failed to save</span>}
      </form>
    </div>
  );
}

interface QuotaFormProps {
  initialLimit: string;
  initialPeriod: string;
}

export function QuotaForm({ initialLimit, initialPeriod }: QuotaFormProps) {
  const [limit, setLimit] = useState(initialLimit);
  const [period, setPeriod] = useState(initialPeriod || "week");
  const [status, setStatus] = useState<SaveStatus>("idle");

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setStatus("saving");
    const res = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quotaLimit: limit, quotaPeriod: period }),
    });
    const data: { ok: boolean } = await res.json();
    setStatus(data.ok ? "ok" : "error");
    setTimeout(() => setStatus("idle"), 3000);
  }

  return (
    <form onSubmit={handleSave} className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="quota-limit">Request limit</Label>
          <Input
            id="quota-limit"
            type="number"
            min="0"
            value={limit}
            onChange={(e) => { setLimit(e.target.value); setStatus("idle"); }}
            placeholder="0"
            className="bg-zinc-800 border-zinc-700 text-sm"
          />
          <p className="text-xs text-zinc-500">Maximum requests per user in the period. Set to 0 to disable.</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="quota-period">Period</Label>
          <select
            id="quota-period"
            value={period}
            onChange={(e) => { setPeriod(e.target.value); setStatus("idle"); }}
            className="w-full h-9 rounded-md border border-zinc-700 bg-zinc-800 px-3 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          >
            <option value="day">Per day</option>
            <option value="week">Per week</option>
            <option value="month">Per month</option>
          </select>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={status === "saving"} className="bg-indigo-600 hover:bg-indigo-500">
          {status === "saving" ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Saving…</> : "Save"}
        </Button>
        {status === "ok"    && <span className="flex items-center gap-1.5 text-sm text-green-400"><CheckCircle className="w-4 h-4" />Saved</span>}
        {status === "error" && <span className="flex items-center gap-1.5 text-sm text-red-400"><XCircle className="w-4 h-4" />Failed to save</span>}
      </div>
    </form>
  );
}

export function EnableUserEmailsToggle({ initialEnabled }: { initialEnabled: boolean }) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [status, setStatus] = useState<SaveStatus>("idle");

  async function toggle() {
    const next = !enabled;
    setEnabled(next);
    setStatus("saving");
    const res = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enableUserEmails: next ? "true" : "false" }),
    });
    const data: { ok: boolean } = await res.json();
    setStatus(data.ok ? "ok" : "error");
    setTimeout(() => setStatus("idle"), 3000);
  }

  return (
    <div className="flex items-center justify-between gap-4 py-3 border-t border-zinc-800">
      <div>
        <p className="text-sm font-medium text-zinc-200">Send emails to users</p>
        <p className="text-xs text-zinc-500 mt-0.5">
          When enabled, users receive emails for approved, declined, and available events (based on their own preferences).
        </p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {status === "saving" && <Loader2 className="w-3.5 h-3.5 animate-spin text-zinc-500" />}
        {status === "ok"     && <CheckCircle className="w-3.5 h-3.5 text-green-400" />}
        {status === "error"  && <XCircle className="w-3.5 h-3.5 text-red-400" />}
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          onClick={toggle}
          className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 focus:ring-offset-zinc-900 ${enabled ? "bg-indigo-600" : "bg-zinc-700"}`}
        >
          <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${enabled ? "translate-x-4" : "translate-x-0.5"}`} />
        </button>
      </div>
    </div>
  );
}

export function DeletionVoteThresholdForm({ initialThreshold }: { initialThreshold: string }) {
  const [threshold, setThreshold] = useState(initialThreshold);
  const [status, setStatus] = useState<SaveStatus>("idle");

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setStatus("saving");
    const res = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deletionVoteThreshold: threshold }),
    });
    const data: { ok: boolean } = await res.json();
    setStatus(data.ok ? "ok" : "error");
    setTimeout(() => setStatus("idle"), 3000);
  }

  return (
    <form onSubmit={handleSave} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="deletion-vote-threshold">Vote threshold</Label>
        <Input
          id="deletion-vote-threshold"
          type="number"
          min="0"
          value={threshold}
          onChange={(e) => { setThreshold(e.target.value); setStatus("idle"); }}
          placeholder="0"
          className="bg-zinc-800 border-zinc-700 text-sm max-w-48"
        />
        <p className="text-xs text-zinc-500">
          When a library item reaches this many deletion votes, admins are notified via email, push, and Discord. Set to 0 to disable notifications.
        </p>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={status === "saving"}>
          {status === "saving" ? <Loader2 className="w-4 h-4 animate-spin" /> : "Save"}
        </Button>
        {status === "ok" && <CheckCircle className="w-4 h-4 text-green-400" />}
        {status === "error" && <XCircle className="w-4 h-4 text-red-400" />}
      </div>
    </form>
  );
}

export function DisableLocalLoginToggle({ initialDisabled }: { initialDisabled: boolean }) {
  const [disabled, setDisabled] = useState(initialDisabled);
  const [status, setStatus] = useState<SaveStatus>("idle");

  async function toggle() {
    const next = !disabled;
    setDisabled(next);
    setStatus("saving");
    const res = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ disableLocalLogin: next ? "true" : "false" }),
    });
    const data: { ok: boolean } = await res.json();
    setStatus(data.ok ? "ok" : "error");
    setTimeout(() => setStatus("idle"), 3000);
  }

  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <p className="text-sm font-medium text-zinc-200">Disable local login</p>
        <p className="text-xs text-zinc-500 mt-0.5">
          Hides the password sign-in form and blocks local registration. Users must sign in via an external provider (Plex, Jellyfin, or SSO/OIDC). Make sure at least one external provider is configured before enabling.
        </p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {status === "saving" && <Loader2 className="w-3.5 h-3.5 animate-spin text-zinc-500" />}
        {status === "ok"     && <CheckCircle className="w-3.5 h-3.5 text-green-400" />}
        {status === "error"  && <XCircle className="w-3.5 h-3.5 text-red-400" />}
        <button
          type="button"
          role="switch"
          aria-checked={disabled}
          onClick={toggle}
          className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 focus:ring-offset-zinc-900 ${disabled ? "bg-indigo-600" : "bg-zinc-700"}`}
        >
          <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${disabled ? "translate-x-4" : "translate-x-0.5"}`} />
        </button>
      </div>
    </div>
  );
}

export function EnableMachineSessionToggle({ initialEnabled }: { initialEnabled: boolean }) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [status, setStatus] = useState<SaveStatus>("idle");

  async function toggle() {
    const next = !enabled;
    setEnabled(next);
    setStatus("saving");
    const res = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enableMachineSession: next ? "true" : "false" }),
    });
    const data: { ok: boolean } = await res.json();
    setStatus(data.ok ? "ok" : "error");
    setTimeout(() => setStatus("idle"), 3000);
  }

  return (
    <div className="flex items-center justify-between gap-4 py-3 border-t border-zinc-800">
      <div>
        <p className="text-sm font-medium text-zinc-200">Machine session API</p>
        <p className="text-xs text-zinc-500 mt-0.5">
          Allow <code className="text-zinc-400">POST /api/auth/machine-session</code> to issue short-lived admin sessions via <code className="text-zinc-400">CRON_SECRET</code>. Used for automated screenshot capture and headless browser access.
        </p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {status === "saving" && <Loader2 className="w-3.5 h-3.5 animate-spin text-zinc-500" />}
        {status === "ok"     && <CheckCircle className="w-3.5 h-3.5 text-green-400" />}
        {status === "error"  && <XCircle className="w-3.5 h-3.5 text-red-400" />}
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          onClick={toggle}
          className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 focus:ring-offset-zinc-900 ${enabled ? "bg-indigo-600" : "bg-zinc-700"}`}
        >
          <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${enabled ? "translate-x-4" : "translate-x-0.5"}`} />
        </button>
      </div>
    </div>
  );
}
