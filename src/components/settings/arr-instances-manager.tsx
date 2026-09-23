"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CheckCircle, XCircle, Loader2, Trash2, RefreshCw, Copy, Check } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";

// 24 random bytes as a hex string — same as generateSecret() in
// forms/webhook-secret-form.tsx (the HD/4K webhook-secret field). Browser-only
// (crypto.getRandomValues), so it is only called from click handlers, never
// during the server render.
function generateSecret(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Admin UI for extra, NAMED Radarr/Sonarr instances (e.g. an "anime" one). The
// default and 4K instances have their own forms above; this one manages the
// extra instances through /api/admin/arr-instances (guardrail 32). Secrets are
// write-only: the saved value is never shown, and a blank field means "keep it".

const MASKED_VALUE = "••••••••";
const SLUG_RE = /^[a-z][a-z0-9]{0,23}$/;

type ArrService = "radarr" | "sonarr";
type SaveStatus = "idle" | "saving" | "ok" | "error";

interface InstanceView {
  slug: string;
  name: string;
  restricted: boolean;
  serverAll: boolean;
  skipLibraryCheck: boolean;
  autoRoute: { animeOnly?: boolean } | null;
  url: string;
  rootFolder: string;
  qualityProfileId: string;
  minimumAvailability: string;
  languageProfileId: string;
  hasApiKey: boolean;
  hasWebhookSecret: boolean;
}

// Root folders + quality profiles read live from a configured instance (the
// shape /api/settings/arr-options returns), so they show as dropdowns instead
// of fields where you type an id. languageProfiles only appears for Sonarr v3
// (Sonarr v4 removed language profiles).
interface ArrOptions {
  rootFolders: { path: string }[];
  qualityProfiles: { id: number; name: string }[];
  languageProfiles?: { id: number; name: string }[];
}

// Radarr's fixed list of choices for when a movie counts as "available" to search for.
const MINIMUM_AVAILABILITY_OPTIONS = [
  { value: "announced", label: "Announced" },
  { value: "inCinemas", label: "In Cinemas" },
  { value: "released", label: "Released" },
] as const;

interface Draft {
  slug: string;
  name: string;
  url: string;
  apiKey: string;
  rootFolder: string;
  qualityProfileId: string;
  minimumAvailability: string; // radarr only
  languageProfileId: string; // sonarr v3 only
  webhookSecret: string;
  restricted: boolean;
  serverAll: boolean;
  skipLibraryCheck: boolean;
  animeOnly: boolean;
  hasApiKey: boolean;
  hasWebhookSecret: boolean;
  isNew: boolean;
}

function toDraft(v: InstanceView): Draft {
  return {
    slug: v.slug,
    name: v.name,
    url: v.url,
    apiKey: "",
    rootFolder: v.rootFolder,
    qualityProfileId: v.qualityProfileId,
    minimumAvailability: v.minimumAvailability ?? "",
    languageProfileId: v.languageProfileId ?? "",
    webhookSecret: "",
    restricted: v.restricted,
    serverAll: v.serverAll,
    skipLibraryCheck: v.skipLibraryCheck,
    animeOnly: v.autoRoute?.animeOnly === true,
    hasApiKey: v.hasApiKey,
    hasWebhookSecret: v.hasWebhookSecret,
    isNew: false,
  };
}

// Only named instances are managed here — the default ("") and legacy 4K ("4k")
// have their own forms.
const isNamed = (slug: string) => slug !== "" && slug !== "4k";

function ServiceInstances({ service }: { service: ArrService }) {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [loaded, setLoaded] = useState(false);
  // If loading fails, `drafts` stays empty, which looks exactly like "no
  // instances" — and saving an empty list deletes every named instance. So a
  // failed load blocks saving.
  const [loadFailed, setLoadFailed] = useState(false);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [message, setMessage] = useState("");
  const [tests, setTests] = useState<Record<string, { version?: string; error?: string }>>({});
  const [copiedHook, setCopiedHook] = useState<number | null>(null);
  // Position of the draft whose Remove is waiting for confirmation. Positions
  // shift when the list changes, so anything that adds, removes or reloads
  // drafts resets this.
  const [confirmRemove, setConfirmRemove] = useState<number | null>(null);
  // For each slug: its live root-folder/quality-profile options, or
  // "loading"/"error" while the fetch is running or after it failed.
  const [optionsBySlug, setOptionsBySlug] = useState<Record<string, ArrOptions | "loading" | "error">>({});

  // Full webhook URL the admin pastes into Radarr/Sonarr (the ?token= form —
  // guardrail 2). Only shown after loading, which happens in the browser, so
  // `window` exists; the typeof check is just a safety net.
  const webhookUrl = (secret: string) =>
    `${typeof window !== "undefined" ? window.location.origin : ""}${withBasePath(`/api/webhooks/${service}`)}?token=${encodeURIComponent(secret)}`;

  async function copyHook(idx: number, secret: string) {
    try {
      await navigator.clipboard.writeText(webhookUrl(secret));
      setCopiedHook(idx);
      setTimeout(() => setCopiedHook(null), 2000);
    } catch {
      /* clipboard blocked — the URL is on screen, so it can be copied by hand */
    }
  }

  // Fetch an instance's real root folders + quality profiles from Radarr/Sonarr
  // (the same endpoint the main config uses). That endpoint reads the saved URL
  // and API key, so it only works once the connection is saved: it runs after
  // load() and after a successful save(), and only for configured instances.
  const fetchOptions = useCallback(async (slug: string) => {
    setOptionsBySlug((prev) => ({ ...prev, [slug]: "loading" }));
    try {
      const res = await fetch(withBasePath(`/api/settings/arr-options?service=${service}&instance=${encodeURIComponent(slug)}`));
      if (!res.ok) throw new Error();
      const data = (await res.json()) as ArrOptions;
      setOptionsBySlug((prev) => ({ ...prev, [slug]: data }));
    } catch {
      setOptionsBySlug((prev) => ({ ...prev, [slug]: "error" }));
    }
  }, [service]);

  const load = useCallback(async () => {
    try {
      const res = await fetch(withBasePath("/api/admin/arr-instances"));
      if (!res.ok) throw new Error();
      const data = (await res.json()) as Record<ArrService, InstanceView[]>;
      const named = (data[service] ?? []).filter((i) => isNamed(i.slug));
      setDrafts(named.map(toDraft));
      named.forEach((i) => { if (i.hasApiKey && i.url) fetchOptions(i.slug); });
      setLoadFailed(false);
      setConfirmRemove(null);
    } catch {
      // Saving an empty list means "remove every named instance", which
      // deletes their API keys and webhook secrets for good (they're encrypted
      // and can't be recovered). A failed load must never be mistaken for "no
      // instances", so flag it: saving is disabled and a message is shown.
      setLoadFailed(true);
    } finally {
      setLoaded(true);
    }
  }, [service, fetchOptions]);

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
      {
        // Create the webhook secret automatically so the admin doesn't have to
        // make one up — they just copy the webhook URL into Radarr/Sonarr.
        slug: "", name: "", url: "", apiKey: "", rootFolder: "", qualityProfileId: "",
        minimumAvailability: "", languageProfileId: "", webhookSecret: generateSecret(),
        restricted: false, serverAll: false, skipLibraryCheck: false, animeOnly: false,
        hasApiKey: false, hasWebhookSecret: false, isNew: true,
      },
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
    // Check slugs here first, before sending anything to the server.
    for (const d of drafts) {
      if (!SLUG_RE.test(d.slug) || d.slug === "hd") {
        setStatus("error");
        setMessage(`Invalid slug "${d.slug}" — use lowercase letters/digits, starting with a letter (not "hd").`);
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
      url: d.url.trim(),
      apiKey: d.apiKey ? d.apiKey : d.hasApiKey ? MASKED_VALUE : undefined,
      rootFolder: d.rootFolder,
      qualityProfileId: d.qualityProfileId || null,
      // null deletes the saved value, so an empty dropdown means "use Radarr's/Sonarr's own default".
      ...(service === "radarr" ? { minimumAvailability: d.minimumAvailability || null } : {}),
      ...(service === "sonarr" ? { languageProfileId: d.languageProfileId || null } : {}),
      webhookSecret: d.webhookSecret ? d.webhookSecret : d.hasWebhookSecret ? MASKED_VALUE : undefined,
      restricted: d.restricted,
      serverAll: d.serverAll,
      skipLibraryCheck: d.skipLibraryCheck,
      autoRoute: d.animeOnly ? { animeOnly: true } : null,
    }));

    try {
      const res = await fetch(withBasePath("/api/admin/arr-instances"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service, instances }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        instances?: InstanceView[];
        testResults?: Record<string, { version?: string; error?: string }>;
      };
      if (res.ok && data.ok) {
        const named = (data.instances ?? []).filter((i) => isNamed(i.slug));
        setDrafts(named.map(toDraft));
        setTests(data.testResults ?? {});
        // The connections are saved now, so (re)load each configured instance's
        // root folders + quality profiles to fill the dropdowns.
        named.forEach((i) => { if (i.hasApiKey && i.url) fetchOptions(i.slug); });
        setConfirmRemove(null);
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

  const label = service === "radarr" ? "Radarr" : "Sonarr";
  const mediaWord = service === "radarr" ? "movies" : "TV";

  if (!loaded) {
    return <p className="text-sm text-zinc-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" />Loading instances…</p>;
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="font-semibold" style={{ fontSize: 14, color: "var(--ds-fg)", margin: 0 }}>{label} — additional instances</h3>
        <p className="text-xs text-zinc-500 mt-1">
          Extra {label} instances (e.g. a dedicated <strong>anime</strong>{" "}instance). Requests auto-route here when an instance&apos;s
          rule matches; a request can also target one explicitly. Restricted instances need a per-user grant (Users → Instance access).
        </p>
      </div>

      {drafts.length === 0 && <p className="text-sm text-zinc-500">No additional {label} instances configured.</p>}

      {drafts.map((d, idx) => {
        const test = tests[d.slug];
        const opts = optionsBySlug[d.slug];
        const optsReady = opts != null && opts !== "loading" && opts !== "error";
        // Why the dropdowns aren't showing yet, for the note under each field.
        const optsNote = opts === "loading"
          ? "Loading options…"
          : opts === "error"
            ? "Couldn't load — check the connection above."
            : "Save the connection to load options.";
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
                  placeholder="anime"
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
                  placeholder="Anime"
                  className="bg-zinc-800 border-zinc-700 text-sm"
                />
              </div>
            </div>

            <div className="lg:grid lg:grid-cols-2 lg:gap-4 space-y-3 lg:space-y-0">
              <div className="space-y-1.5">
                <Label htmlFor={`${service}-${idx}-url`}>{label} URL</Label>
                <Input
                  id={`${service}-${idx}-url`}
                  type="url"
                  value={d.url}
                  onChange={(e) => update(idx, { url: e.target.value })}
                  placeholder={service === "radarr" ? "http://radarr-anime:7878" : "http://sonarr-anime:8989"}
                  className="bg-zinc-800 border-zinc-700 font-mono text-sm"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${service}-${idx}-key`}>API Key</Label>
                <Input
                  id={`${service}-${idx}-key`}
                  type="password"
                  value={d.apiKey}
                  onChange={(e) => update(idx, { apiKey: e.target.value })}
                  placeholder={d.hasApiKey ? MASKED_VALUE : "API key"}
                  className="bg-zinc-800 border-zinc-700 font-mono text-sm"
                />
              </div>
            </div>

            <div className="lg:grid lg:grid-cols-2 lg:gap-4 space-y-3 lg:space-y-0">
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label htmlFor={`${service}-${idx}-folder`}>Root Folder <span className="text-zinc-500">(optional)</span></Label>
                  {optsReady && (
                    <button type="button" onClick={() => fetchOptions(d.slug)} className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-100">
                      <RefreshCw className="w-3 h-3" />Refresh
                    </button>
                  )}
                </div>
                {optsReady ? (
                  <select
                    id={`${service}-${idx}-folder`}
                    value={d.rootFolder}
                    onChange={(e) => update(idx, { rootFolder: e.target.value })}
                    className="h-8 w-full rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  >
                    <option value="">— {label}&apos;s default —</option>
                    {/* If the saved folder is no longer on the server, the select
                        would silently show the first option ("default") while
                        still holding the old value — so list it, marked
                        "not found", instead of hiding it. */}
                    {d.rootFolder && !(opts as ArrOptions).rootFolders.some((f) => f.path === d.rootFolder) && (
                      <option value={d.rootFolder}>{d.rootFolder} (not found on server)</option>
                    )}
                    {(opts as ArrOptions).rootFolders.map((f) => (
                      <option key={f.path} value={f.path}>{f.path}</option>
                    ))}
                  </select>
                ) : (
                  <p className="text-xs text-zinc-500 h-8 flex items-center">{optsNote}</p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${service}-${idx}-profile`}>Quality Profile <span className="text-zinc-500">(optional)</span></Label>
                {optsReady ? (
                  <select
                    id={`${service}-${idx}-profile`}
                    value={d.qualityProfileId}
                    onChange={(e) => update(idx, { qualityProfileId: e.target.value })}
                    className="h-8 w-full rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  >
                    <option value="">— {label}&apos;s default —</option>
                    {d.qualityProfileId && !(opts as ArrOptions).qualityProfiles.some((p) => String(p.id) === d.qualityProfileId) && (
                      <option value={d.qualityProfileId}>Profile #{d.qualityProfileId} (not found on server)</option>
                    )}
                    {(opts as ArrOptions).qualityProfiles.map((p) => (
                      <option key={p.id} value={String(p.id)}>{p.name}</option>
                    ))}
                  </select>
                ) : (
                  <p className="text-xs text-zinc-500 h-8 flex items-center">{optsNote}</p>
                )}
              </div>
            </div>

            {/* A fixed list, so it shows right away with no fetch. Sonarr's
                language profile below DOES need the fetch (only Sonarr v3
                provides that list). */}
            {service === "radarr" && (
              <div className="lg:grid lg:grid-cols-2 lg:gap-4 space-y-3 lg:space-y-0">
                <div className="space-y-1.5">
                  <Label htmlFor={`${service}-${idx}-min-availability`}>Minimum Availability <span className="text-zinc-500">(optional)</span></Label>
                  <select
                    id={`${service}-${idx}-min-availability`}
                    value={d.minimumAvailability}
                    onChange={(e) => update(idx, { minimumAvailability: e.target.value })}
                    className="h-8 w-full rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  >
                    <option value="">— {label}&apos;s default —</option>
                    {MINIMUM_AVAILABILITY_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                  <p className="text-xs text-zinc-500">When added movies count as available to search.</p>
                </div>
              </div>
            )}

            {service === "sonarr" && optsReady && ((opts as ArrOptions).languageProfiles?.length ?? 0) > 0 && (
              <div className="lg:grid lg:grid-cols-2 lg:gap-4 space-y-3 lg:space-y-0">
                <div className="space-y-1.5">
                  <Label htmlFor={`${service}-${idx}-language-profile`}>Language Profile <span className="text-zinc-500">(optional)</span></Label>
                  <select
                    id={`${service}-${idx}-language-profile`}
                    value={d.languageProfileId}
                    onChange={(e) => update(idx, { languageProfileId: e.target.value })}
                    className="h-8 w-full rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  >
                    <option value="">— {label}&apos;s default —</option>
                    {d.languageProfileId && !(opts as ArrOptions).languageProfiles!.some((p) => String(p.id) === d.languageProfileId) && (
                      <option value={d.languageProfileId}>Profile #{d.languageProfileId} (not found on server)</option>
                    )}
                    {(opts as ArrOptions).languageProfiles!.map((p) => (
                      <option key={p.id} value={String(p.id)}>{p.name}</option>
                    ))}
                  </select>
                  <p className="text-xs text-zinc-500">Sonarr v3 only — v4 handles language via custom formats.</p>
                </div>
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor={`${service}-${idx}-hook`}>Webhook Secret <span className="text-zinc-500">(auto-generated — paste the URL below into {label})</span></Label>
              <div className="flex gap-2">
                <Input
                  id={`${service}-${idx}-hook`}
                  type="text"
                  value={d.webhookSecret}
                  onChange={(e) => update(idx, { webhookSecret: e.target.value })}
                  placeholder={d.hasWebhookSecret ? MASKED_VALUE : "auto-generated when you add an instance"}
                  className="bg-zinc-800 border-zinc-700 font-mono text-sm"
                />
                <Button
                  type="button"
                  variant="outline"
                  className="shrink-0 border-zinc-700 text-zinc-300 hover:text-zinc-100"
                  onClick={() => update(idx, { webhookSecret: generateSecret() })}
                >
                  Generate
                </Button>
              </div>
              {d.webhookSecret && (
                <div className="space-y-1">
                  <div className="flex items-center gap-2 rounded-md bg-zinc-800 border border-zinc-700 px-3 py-2">
                    <span className="flex-1 font-mono text-xs text-zinc-300 truncate">{webhookUrl(d.webhookSecret)}</span>
                    <button type="button" onClick={() => copyHook(idx, d.webhookSecret)} className="shrink-0 text-zinc-500 hover:text-zinc-100 transition-colors" aria-label="Copy webhook URL">
                      {copiedHook === idx ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
                    </button>
                  </div>
                  <p className="text-xs text-zinc-500">Add this as a webhook (Connect → Webhook, method POST) in {label}, then Save &amp; Test here.</p>
                </div>
              )}
              {d.hasWebhookSecret && !d.webhookSecret && (
                <p className="text-xs text-zinc-500">A webhook secret is saved. Click <strong>Generate</strong> to replace it — the current value can&apos;t be shown again.</p>
              )}
            </div>

            <div className="flex flex-wrap gap-x-6 gap-y-2 pt-1">
              <label className="flex items-center gap-2 text-sm text-zinc-300">
                <input type="checkbox" checked={d.animeOnly} onChange={(e) => update(idx, { animeOnly: e.target.checked })} />
                Auto-route anime here
              </label>
              <label className="flex items-center gap-2 text-sm text-zinc-300">
                <input type="checkbox" checked={d.restricted} onChange={(e) => update(idx, { restricted: e.target.checked })} />
                Restricted (needs a grant)
              </label>
              <label className="flex items-center gap-2 text-sm text-zinc-300">
                <input type="checkbox" checked={d.serverAll} onChange={(e) => update(idx, { serverAll: e.target.checked })} />
                Open to all requesters
              </label>
              <label className="flex items-center gap-2 text-sm text-zinc-300">
                <input type="checkbox" checked={d.skipLibraryCheck} onChange={(e) => update(idx, { skipLibraryCheck: e.target.checked })} />
                Separate library (skip &quot;already available&quot; check)
              </label>
            </div>

            <div className="flex items-center justify-between pt-1">
              {test?.version && <span className="text-xs text-green-400 flex items-center gap-1"><CheckCircle className="w-3.5 h-3.5" />Connected · v{test.version}</span>}
              {test?.error && <span className="text-xs text-red-400 flex items-center gap-1"><XCircle className="w-3.5 h-3.5" />{test.error}</span>}
              {!test && <span />}
              {confirmRemove !== idx && (
                <button
                  type="button"
                  // A never-saved draft has nothing on the server to delete, so
                  // drop it at once; only ask for confirmation on a saved one.
                  onClick={() => (d.isNew ? removeInstance(idx) : setConfirmRemove(idx))}
                  className="flex items-center gap-1 text-xs text-red-400 hover:text-[var(--ds-danger-hover)]"
                >
                  <Trash2 className="w-3.5 h-3.5" />Remove
                </button>
              )}
            </div>

            {/* Removal only happens on Save, because the server replaces the
                whole instance list at once. The message spells out what is
                lost: the API key and webhook secret are encrypted and can't be
                recovered. Requests already sent to this instance are kept. */}
            {confirmRemove === idx && (
              <div className="rounded-md border border-red-500/40 bg-red-500/10 p-3 space-y-2">
                <p className="text-xs text-red-400">
                  Remove <strong>{d.name.trim() || d.slug || "this instance"}</strong>? On <strong>Save &amp; Test</strong> this
                  deletes its stored URL, API key and webhook secret (encrypted — not recoverable, so you would need to
                  re-copy the key from {label} and re-add the webhook), and clears its cached wanted/available
                  rows. <strong>Existing requests are preserved.</strong>
                </p>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => removeInstance(idx)}
                    autoFocus
                    className="inline-flex items-center gap-1 rounded-md bg-red-600 px-2.5 py-1 text-xs font-medium text-[var(--ds-on-status)] hover:bg-[var(--ds-danger-hover)] transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" />Remove instance
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmRemove(null)}
                    className="rounded-md px-2 py-1 text-xs text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors"
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
        <Button type="button" variant="outline" onClick={addInstance} className="border-zinc-600 text-zinc-300 hover:text-zinc-100 h-8 px-3 text-xs">
          + Add {label} instance
        </Button>
        <Button type="button" onClick={save} disabled={status === "saving" || loadFailed} className="bg-indigo-600 hover:bg-indigo-500 h-8 px-3 text-xs">
          {status === "saving" ? <><Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />Saving…</> : "Save & Test"}
        </Button>
        <button type="button" onClick={load} className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-100"><RefreshCw className="w-3 h-3" />Refresh</button>
        {status === "ok" && <span className="text-sm text-green-400 flex items-center gap-1.5"><CheckCircle className="w-4 h-4" />{message}</span>}
        {status === "error" && <span className="text-sm text-red-400 flex items-center gap-1.5"><XCircle className="w-4 h-4" />{message}</span>}
      </div>
      {loadFailed && (
        <p className="text-sm text-red-400 flex items-center gap-1.5">
          <XCircle className="w-4 h-4 shrink-0" />
          Couldn&apos;t load the current instances — saving is disabled so an empty list can&apos;t wipe them. Hit Refresh.
        </p>
      )}
      <p className="text-xs text-zinc-500">Extra {mediaWord} instances share the same webhook endpoints — each authenticates with its own webhook secret.</p>
    </div>
  );
}

export function ArrInstancesManager() {
  return (
    <div className="space-y-8">
      <ServiceInstances service="radarr" />
      <div className="border-t border-zinc-800" />
      <ServiceInstances service="sonarr" />
    </div>
  );
}
