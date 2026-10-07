"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CheckCircle, XCircle, Loader2, Trash2, RefreshCw } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import { useT } from "@/components/i18n/i18n-provider";

// Admin UI for the EXTRA (named) Plex or Jellyfin servers, one service per
// component. The default server keeps its own form (PlexConnectForm /
// JellyfinSyncForm); this one manages the additional servers stored through
// /api/admin/media-instances. Secrets are write-only: a blank field means
// "keep the saved value".
//
// Simpler than ArrInstancesManager on purpose: nothing routes a request to a
// specific Plex/Jellyfin server (availability is combined across every server
// of a type — guardrail 35), so there are no routing rules to edit here.

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
  // BOTH services — gate this server's library behind a per-user `view` grant
  // (User.mediaServerGrants → canViewMediaInstance). Registry metadata, not a
  // Setting row, and REQUIRED on the wire: this view is round-tripped straight
  // back through POST, so an absent field here would read as `false` and every
  // save would silently un-restrict the server.
  restricted: boolean;
  // Comma-joined library ids/section keys to sync from THIS server. "" = sync
  // everything. Round-tripped like `restricted`, so it must be carried through
  // the draft: sending it back absent leaves it untouched, but sending "" would
  // clear a real selection.
  libraries?: string;
  // Per-server Movie/Tv path-strip prefixes. "" on the wire means "no row" —
  // the server inherits the DEFAULT instance's prefixes (Media tab → Library
  // Path Matching). Saving "" deletes the per-server row to restore that
  // inheritance, so blank here is always safe to round-trip.
  moviePathStripPrefix?: string;
  tvPathStripPrefix?: string;
}

// Per-instance library picker. Deliberately load-on-demand: the list comes from
// the SERVER (its own url+token), so there is nothing to show until the instance
// is saved, and eagerly fetching for every configured instance on mount would
// hit every media server every time the settings page opens.
function InstanceLibraryPicker({
  service,
  slug,
  canLoad,
  value,
  onChange,
}: {
  service: MediaServerService;
  slug: string;
  canLoad: boolean;
  value: string;
  onChange: (next: string) => void;
}) {
  const t = useT();
  const [items, setItems] = useState<{ key: string; title: string }[] | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [error, setError] = useState("");

  const selected = new Set(value.split(",").map((v) => v.trim()).filter(Boolean));

  async function load() {
    setState("loading");
    setError("");
    try {
      const res = await fetch(
        withBasePath(`/api/settings/${service}/libraries?instance=${encodeURIComponent(slug)}`),
      );
      const data: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const msg = data && typeof data === "object" && "error" in data ? String((data as { error: unknown }).error) : "";
        setError(msg || t("settings.media.librariesLoadFailed"));
        setState("error");
        return;
      }
      // Plex returns sections ({key,title}); Jellyfin returns folders
      // ({Id,Name}). Normalize to one shape — the stored value is the id in
      // both cases, and it is only ever meaningful on THIS server.
      const list = Array.isArray(data) ? data : [];
      setItems(
        list.map((raw) => {
          const o = raw as Record<string, unknown>;
          return {
            key: String(o.key ?? o.Id ?? ""),
            title: String(o.title ?? o.Name ?? ""),
          };
        }).filter((i) => i.key),
      );
      setState("idle");
    } catch {
      setError(t("settings.media.librariesLoadFailed"));
      setState("error");
    }
  }

  function toggle(key: string) {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onChange(Array.from(next).join(","));
  }

  return (
    <div className="pt-1">
      <div className="flex items-center gap-2">
        <span className="text-sm text-zinc-300">{t("settings.media.libraries")}</span>
        {canLoad && (
          <button
            type="button"
            onClick={load}
            disabled={state === "loading"}
            className="min-h-8 px-2 -my-2 text-xs text-zinc-400 underline disabled:opacity-50"
          >
            {state === "loading" ? t("settings.media.loading") : items ? t("settings.media.reload") : t("settings.media.chooseLibraries")}
          </button>
        )}
      </div>
      {!canLoad && (
        <p className="text-xs text-zinc-500">{t("settings.media.saveFirst")}</p>
      )}
      {state === "error" && <p className="text-xs text-red-400">{error}</p>}
      {items && items.length === 0 && <p className="text-xs text-zinc-500">{t("settings.media.noLibraries")}</p>}
      {items && items.length > 0 && (
        <div className="mt-1 space-y-1">
          {items.map((i) => (
            <label key={i.key} className="flex items-center gap-2 text-xs text-zinc-300">
              <input type="checkbox" checked={selected.has(i.key)} onChange={() => toggle(i.key)} />
              {i.title}
            </label>
          ))}
        </div>
      )}
      {selected.size === 0 ? (
        <p className="text-xs text-zinc-500">{t("settings.media.nothingSelected")}</p>
      ) : (
        <p className="text-xs text-zinc-500">{t("settings.media.selected", { count: selected.size })}</p>
      )}
    </div>
  );
}

interface Draft {
  slug: string;
  name: string;
  url: string; // serverUrl (plex) or url (jellyfin) — one field, label varies
  token: string; // adminToken (plex) or apiKey (jellyfin)
  adminEmail: string; // plex only
  restrictSignIn: boolean; // jellyfin only
  restricted: boolean; // both services — per-user view grant required
  hasToken: boolean;
  isNew: boolean;
  libraries: string;
  moviePathStripPrefix: string;
  tvPathStripPrefix: string;
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
    libraries: v.libraries ?? "",
    // Strict === true, matching the registry normalizer this value came from
    // (media-instance-registry.ts). Unlike restrictSignIn the safe default is
    // OPEN: a restricted server nobody has been granted is invisible to every
    // non-admin, so guessing "restricted" from a malformed response would blank
    // the library instead of merely widening access.
    restricted: v.restricted === true,
    hasToken: (service === "plex" ? v.hasAdminToken : v.hasApiKey) ?? false,
    isNew: false,
    moviePathStripPrefix: v.moviePathStripPrefix ?? "",
    tvPathStripPrefix: v.tvPathStripPrefix ?? "",
  };
}

// Only named instances are managed here — the default ("") has its own form.
const isNamed = (slug: string) => slug !== "";

export function MediaInstancesManager({ service }: { service: MediaServerService }) {
  const t = useT();
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
  // Edits since the last load/save. Refresh replaces every draft with the
  // server copy, so while this is set it asks before discarding them.
  const [dirty, setDirty] = useState(false);
  const [confirmRefresh, setConfirmRefresh] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(withBasePath("/api/admin/media-instances"));
      if (!res.ok) throw new Error();
      const data = (await res.json()) as Record<MediaServerService, InstanceView[]>;
      const named = (data[service] ?? []).filter((i) => isNamed(i.slug));
      setDrafts(named.map((v) => toDraft(v, service)));
      setConfirmRemove(null);
      setDirty(false);
      setLoadFailed(false);
    } catch {
      // An empty draft list saves as "remove every named instance", which
      // deletes their encrypted (unrecoverable) token/key. So a failed load must
      // never look like "the admin has no instances": block saving and say so.
      setLoadFailed(true);
    } finally {
      setConfirmRefresh(false);
      setLoaded(true);
    }
  }, [service]);

  useEffect(() => {
    load();
  }, [load]);

  const update = (idx: number, patch: Partial<Draft>) => {
    setDrafts((prev) => prev.map((d, i) => (i === idx ? { ...d, ...patch } : d)));
    setDirty(true);
    setStatus("idle");
  };

  const addInstance = () => {
    setDrafts((prev) => [
      ...prev,
      // restrictSignIn defaults to true — a brand-new server starts fail-closed,
      // matching isJellyfinSignInAllowed's default for an absent Setting row.
      // `restricted` defaults to FALSE for the opposite reason: an unrestricted
      // server is the status quo, and a restricted one with no grants yet issued
      // would be invisible to every non-admin the moment it finished syncing.
      { slug: "", name: "", url: "", token: "", adminEmail: "", restrictSignIn: true, restricted: false, hasToken: false, isNew: true, libraries: "", moviePathStripPrefix: "", tvPathStripPrefix: "" },
    ]);
    setConfirmRemove(null);
    setDirty(true);
    setStatus("idle");
  };

  const removeInstance = (idx: number) => {
    setDrafts((prev) => prev.filter((_, i) => i !== idx));
    setConfirmRemove(null);
    setDirty(true);
    setStatus("idle");
  };

  async function save() {
    // Client-side slug validation before hitting the server.
    for (const d of drafts) {
      if (!SLUG_RE.test(d.slug)) {
        setStatus("error");
        setMessage(t("settings.media.invalidSlug", { slug: d.slug }));
        return;
      }
    }
    const seen = new Set<string>();
    for (const d of drafts) {
      if (seen.has(d.slug)) {
        setStatus("error");
        setMessage(t("settings.instances.duplicateSlug", { slug: d.slug }));
        return;
      }
      seen.add(d.slug);
    }

    setStatus("saving");
    setMessage("");
    const instances = drafts.map((d) => ({
      slug: d.slug,
      name: d.name.trim() || d.slug,
      // Outside the per-service spread on purpose: visibility is the one access
      // field BOTH services share (restrictSignIn below is Jellyfin-only).
      restricted: d.restricted,
      libraries: d.libraries,
      moviePathStripPrefix: d.moviePathStripPrefix,
      tvPathStripPrefix: d.tvPathStripPrefix,
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
        setDirty(false);
        setTests(data.testResults ?? {});
        setStatus("ok");
        setMessage(t("settings.common.saved"));
      } else {
        setStatus("error");
        setMessage(data.error ?? t("settings.common.failedToSave"));
      }
    } catch {
      setStatus("error");
      setMessage(t("settings.common.failedToSave"));
    }
  }

  const label = service === "plex" ? "Plex" : "Jellyfin";
  const urlLabel = t("settings.media.serverUrl", { label });
  const tokenLabel = service === "plex" ? t("settings.media.adminToken") : t("settings.media.apiKey");

  if (!loaded) {
    return <p className="text-sm text-zinc-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" />{t("settings.instances.loading")}</p>;
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="font-semibold" style={{ fontSize: 14, color: "var(--ds-fg)", margin: 0 }}>{t("settings.media.heading", { label })}</h3>
        <p className="text-xs text-zinc-500 mt-1">
          {t("settings.media.intro", { label })}
        </p>
      </div>

      {drafts.length === 0 && <p className="text-sm text-zinc-500">{t("settings.media.none", { label })}</p>}

      {drafts.map((d, idx) => {
        const test = tests[d.slug];
        return (
          <div key={idx} className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 space-y-3">
            <div className="lg:grid lg:grid-cols-2 lg:gap-4 space-y-3 lg:space-y-0">
              <div className="space-y-1.5">
                <Label htmlFor={`${service}-${idx}-slug`}>{t("settings.instances.slug")}</Label>
                <Input
                  id={`${service}-${idx}-slug`}
                  value={d.slug}
                  disabled={!d.isNew}
                  onChange={(e) => update(idx, { slug: e.target.value.toLowerCase() })}
                  placeholder="remote"
                  className="bg-zinc-800 border-zinc-700 font-mono disabled:opacity-60"
                />
                {!d.isNew && <p className="text-xs text-zinc-500">{t("settings.instances.slugFixed")}</p>}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${service}-${idx}-name`}>{t("settings.instances.displayName")}</Label>
                <Input
                  id={`${service}-${idx}-name`}
                  value={d.name}
                  onChange={(e) => update(idx, { name: e.target.value })}
                  placeholder={t("settings.media.namePlaceholder")}
                  className="bg-zinc-800 border-zinc-700"
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
                  className="bg-zinc-800 border-zinc-700 font-mono"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${service}-${idx}-token`}>{tokenLabel}</Label>
                <Input
                  id={`${service}-${idx}-token`}
                  type="password"
                  value={d.token}
                  onChange={(e) => update(idx, { token: e.target.value })}
                  placeholder={d.hasToken ? MASKED_VALUE : t(service === "plex" ? "settings.media.tokenPlaceholder.plex" : "settings.media.tokenPlaceholder.jellyfin")}
                  className="bg-zinc-800 border-zinc-700 font-mono"
                />
                {/* Same "saved, hidden" helper the notification channels and
                    the arr manager show — the masked placeholder alone doesn't
                    say whether blank means "nothing saved" or "write-only". */}
                {d.hasToken && !d.token && (
                  <p className="text-xs text-zinc-500">{t("settings.form.agents.secretKeep")}</p>
                )}
              </div>
            </div>

            {service === "plex" && (
              <div className="space-y-1.5">
                <Label htmlFor={`${service}-${idx}-email`}>{t("settings.media.adminEmail")} <span className="text-zinc-500">{t("settings.common.optional")}</span></Label>
                <Input
                  id={`${service}-${idx}-email`}
                  type="email"
                  value={d.adminEmail}
                  onChange={(e) => update(idx, { adminEmail: e.target.value })}
                  placeholder="you@example.com"
                  className="bg-zinc-800 border-zinc-700"
                />
              </div>
            )}

            {/* Jellyfin-only sign-in policy. The default server's version is
                JellyfinRestrictSignInToggle; a named server's setting can only
                be changed here. When unset it defaults to restricted. */}
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
                    {t("settings.media.restrictSignIn")}
                    <span className="block text-xs text-zinc-500">
                      {t("settings.media.restrictSignInHelp")}
                    </span>
                  </span>
                </label>
              </div>
            )}

            {/* Per-server library selection. Load-on-demand rather than eager:
                enumerating needs THIS server's stored url+token, so it is only
                possible once the instance has been saved. An empty selection
                means "sync everything", which is what every named server does
                until an admin narrows it.

                Keyed by SLUG, not by the card's index: the picker holds a
                server-scoped `items` list with no reset-on-slug-change effect,
                so after a mid-list removal React would reuse the fiber and show
                the removed server's section keys on the next card — ticking one
                writes a key that doesn't exist on that server, and its scoped
                full-sync then wipes its library. The card itself stays on
                `key={idx}` on purpose: `d.slug` is editable while `isNew`, so
                keying the card on it would remount (and steal focus from) the
                slug field on every keystroke. */}
            <InstanceLibraryPicker
              key={`${service}-${d.slug}`}
              service={service}
              slug={d.slug}
              canLoad={!d.isNew && d.hasToken}
              value={d.libraries}
              onChange={(v) => update(idx, { libraries: v })}
            />

            {/* Per-server path-strip prefixes. Blank = inherit the DEFAULT
                server's prefixes (Media tab → Library Path Matching) — saving
                blank deletes the per-server Setting row, so inheritance is
                restored rather than shadowed by an empty override. Only worth
                setting when this server's mount layout differs from the
                default's; stripping is a conditional startsWith, so an
                inherited prefix that doesn't match is already a no-op. */}
            <div className="pt-1 space-y-2">
              <p className="text-sm text-zinc-300">{t("settings.media.pathPrefixes")} <span className="text-xs text-zinc-500">{t("settings.common.optional")}</span></p>
              <div className="lg:grid lg:grid-cols-2 lg:gap-4 space-y-3 lg:space-y-0">
                <div className="space-y-1.5">
                  <Label htmlFor={`${service}-${idx}-movie-prefix`}>{t("settings.media.moviePrefix")}</Label>
                  <Input
                    id={`${service}-${idx}-movie-prefix`}
                    value={d.moviePathStripPrefix}
                    onChange={(e) => update(idx, { moviePathStripPrefix: e.target.value })}
                    placeholder="movies"
                    className="bg-zinc-800 border-zinc-700 font-mono"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`${service}-${idx}-tv-prefix`}>{t("settings.media.tvPrefix")}</Label>
                  <Input
                    id={`${service}-${idx}-tv-prefix`}
                    value={d.tvPathStripPrefix}
                    onChange={(e) => update(idx, { tvPathStripPrefix: e.target.value })}
                    placeholder="tv"
                    className="bg-zinc-800 border-zinc-700 font-mono"
                  />
                </div>
              </div>
              <p className="text-xs text-zinc-500">
                {t("settings.media.pathPrefixesHelp")}
              </p>
            </div>

            {/* Service-AGNOSTIC, unlike restrictSignIn above: a restricted
                server's library contributes availability only for users granted
                `view` on it (User.mediaServerGrants → canViewMediaInstance),
                and that question is identical for Plex and Jellyfin. Grants are
                issued per user in Admin → Users → Permissions & Quota. The
                default server never appears in this list and can never be
                restricted — it is synthesized, not registry-backed. */}
            <div className="pt-1">
              <label className="flex items-start gap-2 text-sm text-zinc-300">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={d.restricted}
                  onChange={(e) => update(idx, { restricted: e.target.checked })}
                />
                <span>
                  {t("settings.instances.restricted")}
                  <span className="block text-xs text-zinc-500">
                    {t("settings.media.restrictedHelp")}
                  </span>
                </span>
              </label>
            </div>

            <div className="flex items-center justify-between pt-1">
              {test?.ok && <span className="text-xs text-green-400 flex items-center gap-1"><CheckCircle className="w-3.5 h-3.5" />{t("settings.common.connected")}</span>}
              {test?.error && <span className="text-xs text-red-400 flex items-center gap-1"><XCircle className="w-3.5 h-3.5" />{test.error}</span>}
              {!test && <span />}
              {confirmRemove !== idx && (
                <button
                  type="button"
                  // An `isNew` draft has never been saved, so nothing exists
                  // server-side to destroy — discard it straight away and only
                  // ask for confirmation on a persisted instance.
                  onClick={() => (d.isNew ? removeInstance(idx) : setConfirmRemove(idx))}
                  className="flex items-center gap-1 min-h-8 px-2 -my-2 -mr-2 text-xs text-red-400 hover:text-[var(--ds-danger-hover)]"
                >
                  <Trash2 className="w-3.5 h-3.5" />{t("settings.common.remove")}
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
              <div className="rounded-md border border-red-500/40 bg-red-500/10 p-3 space-y-2">
                <p className="text-xs text-red-400">
                  {t("settings.media.confirmRemove", { name: d.name.trim() || d.slug || t("settings.media.thisServer"), token: tokenLabel })}{" "}
                  <strong>{t("settings.media.confirmRemoveKept")}</strong>
                </p>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => removeInstance(idx)}
                    autoFocus
                    className="inline-flex items-center gap-1 rounded-md bg-red-600 px-2.5 py-1 text-xs font-medium text-[var(--ds-on-status)] hover:bg-[var(--ds-danger-hover)] transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" />{t("settings.media.removeServer")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmRemove(null)}
                    className="rounded-md px-2 py-1 text-xs text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors"
                  >
                    {t("settings.common.cancel")}
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="outline" onClick={addInstance} className="border-zinc-600 text-zinc-300 hover:text-zinc-100 h-8 px-3 text-xs">
          {t("settings.media.add", { label })}
        </Button>
        <Button type="button" onClick={save} disabled={status === "saving" || loadFailed} className="h-8 px-3 text-xs">
          {status === "saving" ? <><Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />{t("settings.common.saving")}</> : t("settings.instances.saveAndTest")}
        </Button>
        {confirmRefresh ? (
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-400">
            {t("settings.media.discardPrompt")}
            <button type="button" onClick={load} className="min-h-8 px-2 text-red-400 hover:underline font-medium">{t("settings.media.discard")}</button>
            <button type="button" onClick={() => setConfirmRefresh(false)} className="min-h-8 px-2 text-zinc-500 hover:text-zinc-100">{t("settings.common.cancel")}</button>
          </span>
        ) : (
          <button type="button" onClick={() => (dirty ? setConfirmRefresh(true) : load())} className="flex items-center gap-1 min-h-8 px-2 text-xs text-zinc-500 hover:text-zinc-100"><RefreshCw className="w-3 h-3" />{t("settings.common.refresh")}</button>
        )}
      </div>
      {/* On its own line so a long save error wraps instead of running off
          the card beside the buttons at phone width (same as the arr manager). */}
      {status === "ok" && <p className="text-sm text-green-400 flex items-center gap-1.5"><CheckCircle className="w-4 h-4 shrink-0" />{message}</p>}
      {status === "error" && <p className="text-sm text-red-400 flex items-center gap-1.5"><XCircle className="w-4 h-4 shrink-0" />{message}</p>}
      {loadFailed && (
        <p className="text-sm text-red-400 flex items-center gap-1.5">
          <XCircle className="w-4 h-4 shrink-0" />
          {t("settings.media.loadFailed")}
        </p>
      )}
    </div>
  );
}
