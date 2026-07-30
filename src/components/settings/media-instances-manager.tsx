"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CheckCircle, XCircle, Loader2, Trash2, RefreshCw } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";

// Admin UI for NAMED Plex/Jellyfin instances (multi-server support), one
// service at a time — exported per-service (unlike ArrInstancesManager's
// both-in-one export) so a later phase can mount only the Jellyfin manager and
// add the Plex one afterward without a half-built component. The default
// instance keeps its own form (PlexConnectForm/JellyfinSyncForm) — this
// manages the extra registry-backed instances via /api/admin/media-instances.
// Secrets are write-only: a blank field means "unchanged".
//
// Deliberately thinner than ArrInstancesManager: no routing rule, no
// root-folder/quality-profile live fetch, no webhook secret — nothing routes a
// request to a specific Plex/Jellyfin server (availability is a union across
// every configured server of a type), so there's no routing metadata to manage.

const MASKED_VALUE = "••••••••";
const SLUG_RE = /^[a-z][a-z0-9]{0,23}$/;

export type MediaServerService = "plex" | "jellyfin";
type SaveStatus = "idle" | "saving" | "ok" | "error";

interface InstanceView {
  slug: string;
  name: string;
  serverUrl?: string; // plex
  adminEmail?: string; // plex
  hasAdminToken?: boolean; // plex
  url?: string; // jellyfin
  hasApiKey?: boolean; // jellyfin
  // jellyfin — the per-instance `jellyfin<Slug>RestrictSignIn` policy read by
  // isJellyfinSignInAllowed. The API resolves an absent Setting row to `true`,
  // matching auth.ts's fail-closed default, so this is never undefined in a GET
  // response; the `?` only keeps the shared Plex/Jellyfin view type honest.
  restrictSignIn?: boolean;
}

interface Draft {
  slug: string;
  name: string;
  url: string; // serverUrl (plex) or url (jellyfin) — one field, label varies
  token: string; // adminToken (plex) or apiKey (jellyfin)
  adminEmail: string; // plex only
  restrictSignIn: boolean; // jellyfin only
  hasToken: boolean;
  isNew: boolean;
}

function toDraft(v: InstanceView, service: MediaServerService): Draft {
  return {
    slug: v.slug,
    name: v.name,
    url: (service === "plex" ? v.serverUrl : v.url) ?? "",
    token: "",
    adminEmail: v.adminEmail ?? "",
    // Fail closed on anything we can't read as an explicit `false` — same
    // default as isJellyfinSignInAllowed, so the checkbox can never render
    // unchecked (= "anyone may sign in") for a server that is actually
    // restricted.
    restrictSignIn: v.restrictSignIn ?? true,
    hasToken: (service === "plex" ? v.hasAdminToken : v.hasApiKey) ?? false,
    isNew: false,
  };
}

// Only named instances are managed here — the default ("") has its own form.
const isNamed = (slug: string) => slug !== "";

export function MediaInstancesManager({ service }: { service: MediaServerService }) {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [loaded, setLoaded] = useState(false);
  // A failed initial GET leaves `drafts` empty, which is indistinguishable from
  // "no instances configured" — and saving that wipes every named instance.
  const [loadFailed, setLoadFailed] = useState(false);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [message, setMessage] = useState("");
  const [tests, setTests] = useState<Record<string, { ok?: boolean; error?: string }>>({});
  // Index of the draft whose Remove button is awaiting confirmation. Indexes
  // shift whenever the list changes, so every path that adds/removes/replaces
  // drafts clears this.
  const [confirmRemove, setConfirmRemove] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(withBasePath("/api/admin/media-instances"));
      if (!res.ok) throw new Error();
      const data = (await res.json()) as Record<MediaServerService, InstanceView[]>;
      const named = (data[service] ?? []).filter((i) => isNamed(i.slug));
      setDrafts(named.map((v) => toDraft(v, service)));
      setConfirmRemove(null);
      setLoadFailed(false);
    } catch {
      // Leaving `drafts` empty here used to be silent — and an empty draft list
      // saves as "remove every named instance", which deletes their (encrypted,
      // unrecoverable) token/key. A failed load must never be mistaken for "the
      // admin has no instances", so block saving and say so.
      setLoadFailed(true);
    } finally {
      setLoaded(true);
    }
  }, [service]);

  useEffect(() => {
    load();
  }, [load]);

  const update = (idx: number, patch: Partial<Draft>) => {
    setDrafts((prev) => prev.map((d, i) => (i === idx ? { ...d, ...patch } : d)));
    setStatus("idle");
  };

  const addInstance = () => {
    setDrafts((prev) => [
      ...prev,
      // restrictSignIn defaults to true — a brand-new server starts fail-closed,
      // matching isJellyfinSignInAllowed's default for an absent Setting row.
      { slug: "", name: "", url: "", token: "", adminEmail: "", restrictSignIn: true, hasToken: false, isNew: true },
    ]);
    setConfirmRemove(null);
    setStatus("idle");
  };

  const removeInstance = (idx: number) => {
    setDrafts((prev) => prev.filter((_, i) => i !== idx));
    setConfirmRemove(null);
    setStatus("idle");
  };

  async function save() {
    // Client-side slug validation before hitting the server.
    for (const d of drafts) {
      if (!SLUG_RE.test(d.slug)) {
        setStatus("error");
        setMessage(`Invalid slug "${d.slug}" — use lowercase letters/digits, starting with a letter.`);
        return;
      }
    }
    const seen = new Set<string>();
    for (const d of drafts) {
      if (seen.has(d.slug)) {
        setStatus("error");
        setMessage(`Duplicate slug "${d.slug}".`);
        return;
      }
      seen.add(d.slug);
    }

    setStatus("saving");
    setMessage("");
    const instances = drafts.map((d) => ({
      slug: d.slug,
      name: d.name.trim() || d.slug,
      ...(service === "plex"
        ? {
            serverUrl: d.url.trim(),
            adminToken: d.token ? d.token : d.hasToken ? MASKED_VALUE : undefined,
            adminEmail: d.adminEmail.trim(),
          }
        : {
            url: d.url.trim(),
            apiKey: d.token ? d.token : d.hasToken ? MASKED_VALUE : undefined,
            restrictSignIn: d.restrictSignIn,
          }),
    }));

    try {
      const res = await fetch(withBasePath("/api/admin/media-instances"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service, instances }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        instances?: InstanceView[];
        testResults?: Record<string, { ok?: boolean; error?: string }>;
      };
      if (res.ok && data.ok) {
        const named = (data.instances ?? []).filter((i) => isNamed(i.slug));
        setDrafts(named.map((v) => toDraft(v, service)));
        setConfirmRemove(null);
        setTests(data.testResults ?? {});
        setStatus("ok");
        setMessage("Saved");
      } else {
        setStatus("error");
        setMessage(data.error ?? "Failed to save");
      }
    } catch {
      setStatus("error");
      setMessage("Failed to save");
    }
  }

  const label = service === "plex" ? "Plex" : "Jellyfin";
  const urlLabel = service === "plex" ? "Plex server URL" : "Jellyfin server URL";
  const tokenLabel = service === "plex" ? "Admin token" : "API key";

  if (!loaded) {
    return <p className="text-sm text-zinc-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" />Loading instances…</p>;
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="font-semibold" style={{ fontSize: 14, color: "var(--ds-fg)", margin: 0 }}>{label} — additional servers</h3>
        <p className="text-xs text-zinc-500 mt-1">
          Extra {label} servers (e.g. a friend&apos;s separate server, or a second library). Availability and activity are combined across
          every configured server of this type.
        </p>
      </div>

      {drafts.length === 0 && <p className="text-sm text-zinc-500">No additional {label} servers configured.</p>}

      {drafts.map((d, idx) => {
        const test = tests[d.slug];
        return (
          <div key={idx} className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 space-y-3">
            <div className="lg:grid lg:grid-cols-2 lg:gap-4 space-y-3 lg:space-y-0">
              <div className="space-y-1.5">
                <Label htmlFor={`${service}-${idx}-slug`}>Slug</Label>
                <Input
                  id={`${service}-${idx}-slug`}
                  value={d.slug}
                  disabled={!d.isNew}
                  onChange={(e) => update(idx, { slug: e.target.value.toLowerCase() })}
                  placeholder="remote"
                  className="bg-zinc-800 border-zinc-700 font-mono text-sm disabled:opacity-60"
                />
                {!d.isNew && <p className="text-xs text-zinc-500">Slug is fixed once created.</p>}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${service}-${idx}-name`}>Display name</Label>
                <Input
                  id={`${service}-${idx}-name`}
                  value={d.name}
                  onChange={(e) => update(idx, { name: e.target.value })}
                  placeholder="Friend's server"
                  className="bg-zinc-800 border-zinc-700 text-sm"
                />
              </div>
            </div>

            <div className="lg:grid lg:grid-cols-2 lg:gap-4 space-y-3 lg:space-y-0">
              <div className="space-y-1.5">
                <Label htmlFor={`${service}-${idx}-url`}>{urlLabel}</Label>
                <Input
                  id={`${service}-${idx}-url`}
                  type="url"
                  value={d.url}
                  onChange={(e) => update(idx, { url: e.target.value })}
                  placeholder={service === "plex" ? "http://plex-remote:32400" : "http://jellyfin-remote:8096"}
                  className="bg-zinc-800 border-zinc-700 font-mono text-sm"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${service}-${idx}-token`}>{tokenLabel}</Label>
                <Input
                  id={`${service}-${idx}-token`}
                  type="password"
                  value={d.token}
                  onChange={(e) => update(idx, { token: e.target.value })}
                  placeholder={d.hasToken ? MASKED_VALUE : tokenLabel}
                  className="bg-zinc-800 border-zinc-700 font-mono text-sm"
                />
              </div>
            </div>

            {service === "plex" && (
              <div className="space-y-1.5">
                <Label htmlFor={`${service}-${idx}-email`}>Admin email <span className="text-zinc-500">(optional)</span></Label>
                <Input
                  id={`${service}-${idx}-email`}
                  type="email"
                  value={d.adminEmail}
                  onChange={(e) => update(idx, { adminEmail: e.target.value })}
                  placeholder="you@example.com"
                  className="bg-zinc-800 border-zinc-700 text-sm"
                />
              </div>
            )}

            {/* Jellyfin-only sign-in policy. Mirrors the default instance's
                JellyfinRestrictSignInToggle, which writes `jellyfinRestrictSignIn`
                via /api/settings; a named instance's key is only reachable here.
                Until this shipped a named instance was permanently fail-closed —
                isJellyfinSignInAllowed reads the Setting and defaults to
                restricted, and nothing could ever write it. */}
            {service === "jellyfin" && (
              <div className="pt-1">
                <label className="flex items-start gap-2 text-sm text-zinc-300">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={d.restrictSignIn}
                    onChange={(e) => update(idx, { restrictSignIn: e.target.checked })}
                  />
                  <span>
                    Restrict sign-in to synced members
                    <span className="block text-xs text-zinc-500">
                      Only accounts this server has already synced into Summonarr — or anyone who has signed in
                      before — may sign in. Unchecking lets ANY valid account on this Jellyfin server sign in and
                      create a Summonarr account (not recommended).
                    </span>
                  </span>
                </label>
              </div>
            )}

            <div className="flex items-center justify-between pt-1">
              {test?.ok && <span className="text-xs text-green-400 flex items-center gap-1"><CheckCircle className="w-3.5 h-3.5" />Connected</span>}
              {test?.error && <span className="text-xs text-red-400 flex items-center gap-1"><XCircle className="w-3.5 h-3.5" />{test.error}</span>}
              {!test && <span />}
              {confirmRemove !== idx && (
                <button
                  type="button"
                  // An `isNew` draft has never been saved, so nothing exists
                  // server-side to destroy — discard it straight away and only
                  // ask for confirmation on a persisted instance.
                  onClick={() => (d.isNew ? removeInstance(idx) : setConfirmRemove(idx))}
                  className="flex items-center gap-1 text-xs text-red-400/80 hover:text-red-400"
                >
                  <Trash2 className="w-3.5 h-3.5" />Remove
                </button>
              )}
            </div>

            {/* Removal is genuinely destructive, and it lands on Save — not on
                the click — because the server reconciles the whole list. Name
                what goes and what stays before the admin commits: the stored
                URL + credentials are encrypted and cannot be recovered, and the
                cached library/session rows are rebuilt only by re-adding the
                server. Play history deliberately survives (guardrail 28 — its
                MediaServerUser rows are soft-deleted, never hard-deleted). */}
            {confirmRemove === idx && (
              <div className="rounded-md border border-red-900/60 bg-red-950/30 p-3 space-y-2">
                <p className="text-xs text-red-200">
                  Remove <strong>{d.name.trim() || d.slug || "this server"}</strong>? On <strong>Save</strong> this deletes
                  its cached library items, its active sessions, and its stored URL + {tokenLabel} (encrypted —
                  not recoverable), and marks its media-server users departed. <strong>Play history is preserved.</strong>
                </p>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => removeInstance(idx)}
                    autoFocus
                    className="inline-flex items-center gap-1 rounded-md bg-red-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-red-500 transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" />Remove server
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmRemove(null)}
                    className="rounded-md px-2 py-1 text-xs text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}

      <div className="flex items-center gap-3">
        <Button type="button" variant="outline" onClick={addInstance} className="border-zinc-600 text-zinc-300 hover:text-white h-8 px-3 text-xs">
          + Add {label} server
        </Button>
        <Button type="button" onClick={save} disabled={status === "saving" || loadFailed} className="bg-indigo-600 hover:bg-indigo-500 h-8 px-3 text-xs">
          {status === "saving" ? <><Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />Saving…</> : "Save & Test"}
        </Button>
        <button type="button" onClick={load} className="flex items-center gap-1 text-xs text-zinc-500 hover:text-white"><RefreshCw className="w-3 h-3" />Refresh</button>
        {status === "ok" && <span className="text-sm text-green-400 flex items-center gap-1.5"><CheckCircle className="w-4 h-4" />{message}</span>}
        {status === "error" && <span className="text-sm text-red-400 flex items-center gap-1.5"><XCircle className="w-4 h-4" />{message}</span>}
      </div>
      {loadFailed && (
        <p className="text-sm text-red-400 flex items-center gap-1.5">
          <XCircle className="w-4 h-4 shrink-0" />
          Couldn&apos;t load the current servers — saving is disabled so an empty list can&apos;t wipe them. Hit Refresh.
        </p>
      )}
    </div>
  );
}
