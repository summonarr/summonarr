"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CheckCircle, XCircle, Loader2, Trash2, RefreshCw } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import { fetchJson, jsonInit } from "@/lib/client/fetch-json";
import { librariesPath, parseLibraryItems, type LibraryItem } from "@/lib/client/library-items";
import { parseLibrarySelection, reconcileLibrarySelection } from "@/lib/client/library-selection";
import { useAsyncAction } from "@/hooks/use-async-action";
import { useT } from "@/components/i18n/i18n-provider";
import { SECRET_MASK_SENTINEL } from "@/lib/secret-mask";
import type { SaveStatus } from "./forms/shared";
import {
  draftsProblem,
  instancesPayload,
  newDraft,
  readInstancesGet,
  readSaveAnswer,
  toDraft,
  type Draft,
  type MediaServerService,
  type TestResult,
} from "./media-instances-data";

// Admin UI for the EXTRA (named) Plex or Jellyfin servers, one service per
// component. The default server keeps its own form (PlexConnectForm /
// JellyfinSyncForm); this one manages the additional servers stored through
// /api/admin/media-instances. Secrets are write-only: a blank field means
// "keep the saved value".
//
// Simpler than ArrInstancesManager on purpose: nothing routes a request to a
// specific Plex/Jellyfin server (availability is combined across every server
// of a type — guardrail 35), so there are no routing rules to edit here.

export type { MediaServerService } from "./media-instances-data";

// A library list reaches the media server; give it room before calling it a failure.
const LIBRARIES_TIMEOUT_MS = 120_000;

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
  const [items, setItems] = useState<LibraryItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Saved keys the last load found missing from the server.
  const [stale, setStale] = useState(0);
  const action = useAsyncAction();
  const loading = action.busy("load");
  // The selection as it stands when a load answers (it can be edited meanwhile).
  const latestValue = useRef(value);
  useEffect(() => { latestValue.current = value; }, [value]);

  const selected = new Set(parseLibrarySelection(value));

  async function load() {
    setError(null);
    const res = await action.run("load", (signal) => fetchJson(withBasePath(librariesPath(service, slug)), {
      signal,
      timeoutMs: LIBRARIES_TIMEOUT_MS,
      fallbackError: t("settings.media.librariesLoadFailed"),
    }));
    if (!res) return;
    const listed = res.ok ? parseLibraryItems(service, res.data) : null;
    if (!listed) {
      setError((!res.ok && res.error) || t("settings.media.librariesLoadFailed"));
      return;
    }
    setItems(listed);
    // A saved key the server no longer lists (a deleted library) has no
    // checkbox, so it could never be unticked, yet it kept counting and was
    // saved again — and a selection of only such keys syncs nothing. Drop
    // them from the draft, which then asks to be saved.
    const current = parseLibrarySelection(latestValue.current);
    const kept = reconcileLibrarySelection(current, listed.map((i) => i.id));
    setStale(current.length - kept.length);
    if (kept.length !== current.length) onChange(kept.join(","));
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
            disabled={loading}
            className="min-h-8 px-2 -my-2 text-xs text-zinc-400 underline disabled:opacity-50"
          >
            {loading ? t("settings.media.loading") : items ? t("settings.media.reload") : t("settings.media.chooseLibraries")}
          </button>
        )}
      </div>
      {!canLoad && (
        <p className="text-xs text-zinc-500">{t("settings.media.saveFirst")}</p>
      )}
      {error !== null && <p role="alert" className="text-xs text-red-400">{error}</p>}
      {items && items.length === 0 && <p className="text-xs text-zinc-500">{t("settings.media.noLibraries")}</p>}
      {items && items.length > 0 && (
        <div className="mt-1 space-y-1">
          {items.map((i) => (
            <label key={i.id} className="flex items-center gap-2 text-xs text-zinc-300">
              <input type="checkbox" checked={selected.has(i.id)} onChange={() => toggle(i.id)} />
              {i.title}
            </label>
          ))}
        </div>
      )}
      {stale > 0 && <p className="text-xs text-amber-400">{t("settings.media.staleLibraries", { count: stale })}</p>}
      {selected.size === 0 ? (
        <p className="text-xs text-zinc-500">{t("settings.media.nothingSelected")}</p>
      ) : (
        <p className="text-xs text-zinc-500">{t("settings.media.selected", { count: selected.size })}</p>
      )}
    </div>
  );
}

// One server's card: its fields, its library picker, its last test result and
// its Remove confirmation.
function InstanceCard({
  service,
  draft: d,
  test,
  confirmingRemove,
  onUpdate,
  onAskRemove,
  onCancelRemove,
  onRemove,
}: {
  service: MediaServerService;
  draft: Draft;
  test: TestResult | undefined;
  confirmingRemove: boolean;
  onUpdate: (patch: Partial<Draft>) => void;
  onAskRemove: () => void;
  onCancelRemove: () => void;
  onRemove: () => void;
}) {
  const t = useT();
  const tokenLabel = service === "plex" ? t("settings.media.adminToken") : t("settings.media.apiKey");
  const field = (name: string) => `${service}-${d.id}-${name}`;
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 space-y-3">
      <div className="lg:grid lg:grid-cols-2 lg:gap-4 space-y-3 lg:space-y-0">
        <div className="space-y-1.5">
          <Label htmlFor={field("slug")}>{t("settings.instances.slug")}</Label>
          <Input
            id={field("slug")}
            value={d.slug}
            disabled={!d.isNew}
            onChange={(e) => onUpdate({ slug: e.target.value.toLowerCase() })}
            placeholder="remote"
            className="bg-zinc-800 border-zinc-700 font-mono disabled:opacity-60"
          />
          {!d.isNew && <p className="text-xs text-zinc-500">{t("settings.instances.slugFixed")}</p>}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={field("name")}>{t("settings.instances.displayName")}</Label>
          <Input
            id={field("name")}
            value={d.name}
            onChange={(e) => onUpdate({ name: e.target.value })}
            placeholder={t("settings.media.namePlaceholder")}
            className="bg-zinc-800 border-zinc-700"
          />
        </div>
      </div>

      <div className="lg:grid lg:grid-cols-2 lg:gap-4 space-y-3 lg:space-y-0">
        <div className="space-y-1.5">
          <Label htmlFor={field("url")}>{t("settings.media.serverUrl", { label: service === "plex" ? "Plex" : "Jellyfin" })}</Label>
          <Input
            id={field("url")}
            type="url"
            value={d.url}
            onChange={(e) => onUpdate({ url: e.target.value })}
            placeholder={service === "plex" ? "http://plex-remote:32400" : "http://jellyfin-remote:8096"}
            className="bg-zinc-800 border-zinc-700 font-mono"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={field("token")}>{tokenLabel}</Label>
          <Input
            id={field("token")}
            type="password"
            // A Plex/Jellyfin credential, not a login: a browser or
            // password manager must not fill the Summonarr password in
            // (it would be saved as the token and sent to plex.tv).
            autoComplete="new-password"
            data-1p-ignore
            data-lpignore="true"
            value={d.token}
            onChange={(e) => onUpdate({ token: e.target.value })}
            placeholder={d.hasToken ? SECRET_MASK_SENTINEL : t(service === "plex" ? "settings.media.tokenPlaceholder.plex" : "settings.media.tokenPlaceholder.jellyfin")}
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
          <Label htmlFor={field("email")}>{t("settings.media.adminEmail")} <span className="text-zinc-500">{t("settings.common.optional")}</span></Label>
          <Input
            id={field("email")}
            type="email"
            value={d.adminEmail}
            onChange={(e) => onUpdate({ adminEmail: e.target.value })}
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
              onChange={(e) => onUpdate({ restrictSignIn: e.target.checked })}
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

          Keyed by SLUG as well as by the card: the picker holds a
          server-scoped `items` list with no reset-on-slug-change effect, so
          a card whose slug is retyped must not keep the old server's
          section keys — ticking one would write a key that doesn't exist on
          that server, and its scoped full-sync then wipes its library. */}
      <InstanceLibraryPicker
        key={`${service}-${d.slug}`}
        service={service}
        slug={d.slug}
        canLoad={!d.isNew && d.hasToken}
        value={d.libraries}
        onChange={(v) => onUpdate({ libraries: v })}
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
            <Label htmlFor={field("movie-prefix")}>{t("settings.media.moviePrefix")}</Label>
            <Input
              id={field("movie-prefix")}
              value={d.moviePathStripPrefix}
              onChange={(e) => onUpdate({ moviePathStripPrefix: e.target.value })}
              placeholder="movies"
              className="bg-zinc-800 border-zinc-700 font-mono"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={field("tv-prefix")}>{t("settings.media.tvPrefix")}</Label>
            <Input
              id={field("tv-prefix")}
              value={d.tvPathStripPrefix}
              onChange={(e) => onUpdate({ tvPathStripPrefix: e.target.value })}
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
            onChange={(e) => onUpdate({ restricted: e.target.checked })}
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
        {test?.ok && <span role="status" className="text-xs text-green-400 flex items-center gap-1"><CheckCircle className="w-3.5 h-3.5" />{t("settings.common.connected")}</span>}
        {test?.error && <span role="status" className="text-xs text-red-400 flex items-center gap-1"><XCircle className="w-3.5 h-3.5" />{test.error}</span>}
        {!test && <span />}
        {!confirmingRemove && (
          <button
            type="button"
            // An `isNew` draft has never been saved, so nothing exists
            // server-side to destroy — discard it straight away and only
            // ask for confirmation on a persisted instance.
            onClick={() => (d.isNew ? onRemove() : onAskRemove())}
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
      {confirmingRemove && (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 p-3 space-y-2">
          <p className="text-xs text-red-400">
            {t("settings.media.confirmRemove", { name: d.name.trim() || d.slug || t("settings.media.thisServer"), token: tokenLabel })}{" "}
            <strong>{t("settings.media.confirmRemoveKept")}</strong>
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onRemove}
              autoFocus
              className="inline-flex items-center gap-1 rounded-md bg-red-600 px-2.5 py-1 text-xs font-medium text-[var(--ds-on-status)] hover:bg-[var(--ds-danger-hover)] transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />{t("settings.media.removeServer")}
            </button>
            <button
              type="button"
              onClick={onCancelRemove}
              className="rounded-md px-2 py-1 text-xs text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors"
            >
              {t("settings.common.cancel")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function MediaInstancesManager({ service }: { service: MediaServerService }) {
  const t = useT();
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [loaded, setLoaded] = useState(false);
  // A failed initial GET leaves `drafts` empty, which is indistinguishable from
  // "no instances configured" — and saving that wipes every named instance.
  const [loadFailed, setLoadFailed] = useState(false);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [message, setMessage] = useState("");
  const [tests, setTests] = useState<Record<string, TestResult>>({});
  // The draft (by id) whose Remove button is awaiting confirmation.
  const [confirmRemove, setConfirmRemove] = useState<number | null>(null);
  // Edits since the last load/save. Refresh replaces every draft with the
  // server copy, so while this is set it asks before discarding them.
  const [dirty, setDirty] = useState(false);
  const [confirmRefresh, setConfirmRefresh] = useState(false);
  // The server's version of the list these drafts were loaded from, sent back
  // as `baseVersion` so a save over a list changed elsewhere (another tab or
  // admin) is refused instead of removing the servers it added — with their
  // library, sessions and watch-sync pairs. Absent from an older server, and
  // then not sent.
  const [version, setVersion] = useState<string | undefined>(undefined);
  // One load at a time: a newer Refresh aborts the older one, so an older
  // answer can never land over a newer one.
  const action = useAsyncAction();
  const refreshing = action.busy("load");
  const saving = status === "saving";
  // A load's answer replaces every draft just as a save's does, so the editors
  // lock for either.
  const locked = saving || refreshing;

  const load = useCallback(async () => {
    const res = await action.run("load", (signal) => fetchJson(withBasePath("/api/admin/media-instances"), { signal }));
    if (res === undefined) return;
    const list = res.ok ? readInstancesGet(res.data, service) : null;
    setConfirmRefresh(false);
    setLoaded(true);
    if (!list) {
      // An empty draft list saves as "remove every named instance", which
      // deletes their encrypted (unrecoverable) token/key. So a failed load must
      // never look like "the admin has no instances": block saving and say so.
      setLoadFailed(true);
      return;
    }
    setDrafts(list.named.map((v) => toDraft(v, service)));
    setVersion(list.version);
    setConfirmRemove(null);
    setDirty(false);
    setLoadFailed(false);
    // Test results are keyed by slug and describe the config as it was at
    // the last Save & Test — stale once the instances are reloaded.
    setTests({});
    setStatus("idle");
  }, [service, action]);

  useEffect(() => {
    void load();
  }, [load]);

  // While a save is in flight the editors are disabled (its response replaces
  // every draft), and nothing here may flip "saving" back to "idle" — that
  // re-enabled Save for a second concurrent POST.
  const clearStatus = () => setStatus((s) => (s === "saving" ? s : "idle"));

  const update = (id: number, patch: Partial<Draft>) => {
    setDrafts((prev) => prev.map((d) => (d.id === id ? { ...d, ...patch } : d)));
    setDirty(true);
    clearStatus();
  };

  const addInstance = () => {
    setDrafts((prev) => [...prev, newDraft()]);
    setConfirmRemove(null);
    setDirty(true);
    clearStatus();
  };

  const removeInstance = (id: number) => {
    setDrafts((prev) => prev.filter((d) => d.id !== id));
    setConfirmRemove(null);
    setDirty(true);
    clearStatus();
  };

  async function save() {
    // Client-side slug validation before hitting the server (draftsProblem).
    const problem = draftsProblem(drafts);
    if (problem) {
      setStatus("error");
      setMessage(problem.kind === "invalid"
        ? t("settings.media.invalidSlug", { slug: problem.slug })
        : problem.kind === "reserved"
          ? t("settings.media.reservedSlug", { slug: problem.slug })
          : t("settings.instances.duplicateSlug", { slug: problem.slug }));
      return;
    }

    setStatus("saving");
    setMessage("");
    const instances = instancesPayload(drafts, service);
    const res = await fetchJson(withBasePath("/api/admin/media-instances"), {
      // A 409 means the list changed elsewhere since it was loaded; nothing
      // was written and the error says to Refresh.
      init: jsonInit("POST", { service, instances, ...(version !== undefined ? { baseVersion: version } : {}) }),
      // Every server is tested in turn before the answer comes back.
      timeoutMs: Infinity,
      fallbackError: t("settings.common.failedToSave"),
    });
    const answer = res.ok ? readSaveAnswer(res.data) : null;
    if (!answer) {
      setStatus("error");
      setMessage(res.ok ? t("settings.common.failedToSave") : res.error || t("settings.common.failedToSave"));
      return;
    }
    setDrafts(answer.named.map((v) => toDraft(v, service)));
    setVersion(answer.version);
    setConfirmRemove(null);
    setDirty(false);
    setTests(answer.testResults);
    setStatus("ok");
    setMessage(t("settings.common.saved"));
  }

  const label = service === "plex" ? "Plex" : "Jellyfin";

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

      {/* Not while the load failed: the list is unknown, not empty. */}
      {drafts.length === 0 && !loadFailed && <p className="text-sm text-zinc-500">{t("settings.media.none", { label })}</p>}

      {/* Disabled while a save or a reload is in flight: its answer replaces
          every draft, so anything typed meanwhile would be silently discarded. */}
      {drafts.length > 0 && (
      <fieldset disabled={locked} className="min-w-0 space-y-4">
      {drafts.map((d) => (
        <InstanceCard
          key={d.id}
          service={service}
          draft={d}
          test={tests[d.slug]}
          confirmingRemove={confirmRemove === d.id}
          onUpdate={(patch) => update(d.id, patch)}
          onAskRemove={() => setConfirmRemove(d.id)}
          onCancelRemove={() => setConfirmRemove(null)}
          onRemove={() => removeInstance(d.id)}
        />
      ))}
      </fieldset>
      )}

      <div className="flex flex-wrap items-center gap-3">
        {/* Not after a failed load either: a server added then could never be saved. */}
        <Button type="button" variant="outline" onClick={addInstance} disabled={locked || loadFailed} className="border-zinc-600 text-zinc-300 hover:text-zinc-100 h-8 px-3 text-xs">
          {t("settings.media.add", { label })}
        </Button>
        <Button type="button" onClick={save} disabled={locked || loadFailed} className="h-8 px-3 text-xs">
          {saving ? <><Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />{t("settings.common.saving")}</> : t("settings.instances.saveAndTest")}
        </Button>
        {confirmRefresh ? (
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-400">
            {t("settings.media.discardPrompt")}
            <button type="button" onClick={() => void load()} disabled={locked} className="min-h-8 px-2 text-red-400 hover:underline font-medium disabled:opacity-50">{t("settings.media.discard")}</button>
            <button type="button" onClick={() => setConfirmRefresh(false)} className="min-h-8 px-2 text-zinc-500 hover:text-zinc-100">{t("settings.common.cancel")}</button>
          </span>
        ) : (
          <button type="button" onClick={() => (dirty ? setConfirmRefresh(true) : load())} disabled={locked} className="flex items-center gap-1 min-h-8 px-2 text-xs text-zinc-500 hover:text-zinc-100 disabled:opacity-50">
            {refreshing ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}{t("settings.common.refresh")}
          </button>
        )}
      </div>
      {/* On its own line so a long save error wraps instead of running off
          the card beside the buttons at phone width (same as the arr manager).
          Live regions, so a screen reader hears the save land. */}
      {status === "ok" && <p role="status" className="text-sm text-green-400 flex items-center gap-1.5"><CheckCircle className="w-4 h-4 shrink-0" />{message}</p>}
      {status === "error" && <p role="alert" className="text-sm text-red-400 flex items-center gap-1.5"><XCircle className="w-4 h-4 shrink-0" />{message}</p>}
      {loadFailed && (
        <p role="alert" className="text-sm text-red-400 flex items-center gap-1.5">
          <XCircle className="w-4 h-4 shrink-0" />
          {t("settings.media.loadFailed")}
        </p>
      )}
    </div>
  );
}
