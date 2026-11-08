"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StyledSelect } from "@/components/ui/styled-select";
import { AlertTriangle, CheckCircle, XCircle, Loader2, Trash2, RefreshCw, Copy, Check } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import { fetchJson, jsonInit } from "@/lib/client/fetch-json";
import { apiErrorText } from "@/lib/client/api-error";
import { useCopyFeedback } from "@/hooks/use-copy-feedback";
import { useT } from "@/components/i18n/i18n-provider";
import { SECRET_MASK_SENTINEL } from "@/lib/secret-mask";
import { MINIMUM_AVAILABILITY_OPTIONS, readArrOptions, type ArrOptions } from "./arr-options";
import { ArrProfileSelect } from "./arr-profile-select";
import {
  draftsProblem,
  instancesPayload,
  newDraft,
  readInstancesGet,
  readSaveAnswer,
  toDraft,
  type ArrService,
  type Draft,
  type InstanceList,
  type TestResult,
} from "./arr-instances-data";

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
// The draft model, the answers' shape check and the save payload are in
// arr-instances-data.ts.

type SaveStatus = "idle" | "saving" | "ok" | "error";
type CardOptions = ArrOptions | "loading" | "error" | undefined;

function ServiceInstances({ service }: { service: ArrService }) {
  const t = useT();
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [loaded, setLoaded] = useState(false);
  // If loading fails, `drafts` stays empty, which looks exactly like "no
  // instances" — and saving an empty list deletes every named instance. So a
  // failed load blocks saving.
  const [loadFailed, setLoadFailed] = useState(false);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [message, setMessage] = useState("");
  const [tests, setTests] = useState<Record<string, TestResult>>({});
  // The draft whose Remove is waiting for confirmation (a draft id, not a
  // position). Anything that adds, removes or reloads drafts still resets it.
  const [confirmRemove, setConfirmRemove] = useState<number | null>(null);
  // The server's version of the list these drafts were loaded from, sent back
  // as `baseVersion` so a save over a list changed elsewhere (another tab or
  // admin) is refused instead of deleting what it added. Absent from an older
  // server, and then not sent.
  const [version, setVersion] = useState<string | undefined>(undefined);
  // Edits since the last load/save. Refresh replaces every draft with the
  // server copy (a pasted API key included), so while this is set it asks
  // before discarding them — same guard as MediaInstancesManager.
  const [dirty, setDirty] = useState(false);
  const [confirmRefresh, setConfirmRefresh] = useState(false);
  // Removed instances that still had PENDING/APPROVED requests pointing at
  // them, from the last save's `removed` field. Those requests are stranded
  // until re-routed or declined, so the admin is told which slugs and how many.
  const [strandedRemoved, setStrandedRemoved] = useState<Array<{ slug: string; openRequests: number }>>([]);
  // For each slug: its live root-folder/quality-profile options, or
  // "loading"/"error" while the fetch is running or after it failed.
  const [optionsBySlug, setOptionsBySlug] = useState<Record<string, ArrOptions | "loading" | "error">>({});
  // Per-slug request counter: the load, the post-save refetch and the Refresh
  // link can overlap, and only the LATEST request for a slug may write its
  // options — an older answer (from before a URL or key was saved) would
  // otherwise land last and overwrite the fresh one.
  const optionsSeq = useRef<Record<string, number>>({});
  const saving = status === "saving";

  // Fetch an instance's real root folders + quality profiles from Radarr/Sonarr
  // (the same endpoint the main config uses). That endpoint reads the saved URL
  // and API key, so it only works once the connection is saved: it runs after
  // load() and after a successful save(), and only for configured instances.
  const fetchOptions = useCallback(async (slug: string) => {
    const seq = (optionsSeq.current[slug] ?? 0) + 1;
    optionsSeq.current[slug] = seq;
    const latest = () => optionsSeq.current[slug] === seq;
    setOptionsBySlug((prev) => ({ ...prev, [slug]: "loading" }));
    // Radarr/Sonarr each get 30 s per call there (arrFetch), and Sonarr may need two.
    const res = await fetchJson(withBasePath(`/api/settings/arr-options?service=${service}&instance=${encodeURIComponent(slug)}`), { timeoutMs: 90_000 });
    const data = res.ok ? readArrOptions(res.data) : null;
    if (data) {
      if (latest()) setOptionsBySlug((prev) => ({ ...prev, [slug]: data }));
    } else {
      if (latest()) setOptionsBySlug((prev) => ({ ...prev, [slug]: "error" }));
    }
  }, [service]);

  // The drafts become the server's list: every per-card state goes with the
  // old drafts (the cards remount under new ids), and each configured
  // instance's dropdowns are (re)loaded.
  const applyList = useCallback((list: InstanceList) => {
    setDrafts(list.named.map(toDraft));
    setVersion(list.version);
    list.named.forEach((i) => { if (i.hasApiKey && i.url) void fetchOptions(i.slug); });
    setConfirmRemove(null);
    setDirty(false);
  }, [fetchOptions]);

  const load = useCallback(async () => {
    const res = await fetchJson(withBasePath("/api/admin/arr-instances"));
    const list = res.ok ? readInstancesGet(res.data, service) : null;
    if (list) {
      applyList(list);
      setLoadFailed(false);
      setStrandedRemoved([]);
      // Test results are keyed by slug and describe the config as it was at
      // the last Save & Test — stale once the instances are reloaded.
      setTests({});
      setStatus("idle");
    } else {
      // Saving an empty list means "remove every named instance", which
      // deletes their API keys and webhook secrets for good (they're encrypted
      // and can't be recovered). A failed load must never be mistaken for "no
      // instances", so flag it: saving is disabled and a message is shown.
      setLoadFailed(true);
    }
    setConfirmRefresh(false);
    setLoaded(true);
  }, [service, applyList]);

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
    // Create the webhook secret automatically so the admin doesn't have to
    // make one up — they just copy the webhook URL into Radarr/Sonarr.
    setDrafts((prev) => [...prev, newDraft(generateSecret())]);
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
    const problem = draftsProblem(drafts);
    if (problem) {
      setStatus("error");
      setMessage(problem.kind === "invalid"
        ? t("settings.arr.invalidSlug", { slug: problem.slug })
        : t("settings.instances.duplicateSlug", { slug: problem.slug }));
      return;
    }

    setStatus("saving");
    setMessage("");
    setStrandedRemoved([]);
    const instances = instancesPayload(drafts, service);
    // A 409 means the list changed elsewhere since it was loaded; nothing was
    // written and the error says to Refresh. The save tests every connection,
    // so it waits as long as the browser does.
    const res = await fetchJson(withBasePath("/api/admin/arr-instances"), {
      init: jsonInit("POST", { service, instances, ...(version !== undefined ? { baseVersion: version } : {}) }),
      timeoutMs: Infinity,
      fallbackError: t("settings.common.failedToSave"),
    });
    const body = res.ok && res.data && typeof res.data === "object" && !Array.isArray(res.data)
      ? (res.data as Record<string, unknown>)
      : null;
    const answer = body && body.ok === true ? readSaveAnswer(body) : null;
    if (!answer) {
      setStatus("error");
      setMessage(res.ok ? apiErrorText(body, t("settings.common.failedToSave")) : res.error || t("settings.common.failedToSave"));
      return;
    }
    // The connections are saved now, so applyList (re)loads each configured
    // instance's root folders + quality profiles to fill the dropdowns.
    applyList(answer);
    setTests(answer.testResults);
    setStrandedRemoved(answer.stranded);
    setStatus("ok");
    setMessage(t("settings.common.saved"));
  }

  const label = service === "radarr" ? "Radarr" : "Sonarr";

  if (!loaded) {
    return <p className="text-sm text-zinc-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" />{t("settings.instances.loading")}</p>;
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="font-semibold" style={{ fontSize: 14, color: "var(--ds-fg)", margin: 0 }}>{t("settings.arr.heading", { label })}</h3>
        <p className="text-xs text-zinc-500 mt-1">
          {t("settings.arr.intro", { label })}
        </p>
      </div>

      {drafts.length === 0 && <p className="text-sm text-zinc-500">{t("settings.arr.none", { label })}</p>}

      {/* Disabled while a save is in flight: its response replaces every
          draft, so anything typed meanwhile would be silently discarded. */}
      {drafts.length > 0 && (
      <fieldset disabled={saving} className="min-w-0 space-y-4">
      {drafts.map((d, idx) => (
        <InstanceCard
          key={d.id}
          service={service}
          draft={d}
          idx={idx}
          test={tests[d.slug]}
          options={optionsBySlug[d.slug]}
          confirmingRemove={confirmRemove === d.id}
          onUpdate={(patch) => update(d.id, patch)}
          onRefreshOptions={() => void fetchOptions(d.slug)}
          onAskRemove={() => (d.isNew ? removeInstance(d.id) : setConfirmRemove(d.id))}
          onRemove={() => removeInstance(d.id)}
          onCancelRemove={() => setConfirmRemove(null)}
        />
      ))}
      </fieldset>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button type="button" variant="outline" onClick={addInstance} disabled={saving} className="border-zinc-600 text-zinc-300 hover:text-zinc-100 h-8 px-3 text-xs">
          {t("settings.arr.add", { label })}
        </Button>
        <Button type="button" onClick={save} disabled={saving || loadFailed} className="h-8 px-3 text-xs">
          {saving ? <><Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />{t("settings.common.saving")}</> : t("settings.instances.saveAndTest")}
        </Button>
        {/* Refresh replaces every draft with the server copy, so with unsaved
            edits it asks first — otherwise a pasted API key is gone with one
            mis-click on the button beside Save. */}
        {confirmRefresh ? (
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-400">
            {t("settings.media.discardPrompt")}
            <button type="button" onClick={() => void load()} disabled={saving} className="min-h-8 px-2 text-red-400 hover:underline font-medium disabled:opacity-50">{t("settings.media.discard")}</button>
            <button type="button" onClick={() => setConfirmRefresh(false)} className="min-h-8 px-2 text-zinc-500 hover:text-zinc-100">{t("settings.common.cancel")}</button>
          </span>
        ) : (
          <button type="button" onClick={() => (dirty ? setConfirmRefresh(true) : load())} disabled={saving} className="flex items-center gap-1 min-h-8 px-2 text-xs text-zinc-500 hover:text-zinc-100 disabled:opacity-50"><RefreshCw className="w-3 h-3" />{t("settings.common.refresh")}</button>
        )}
      </div>
      {/* On its own line so a long save error wraps instead of running off
          the card beside the buttons at phone width. */}
      {status === "ok" && <p role="status" className="text-sm text-green-400 flex items-center gap-1.5"><CheckCircle className="w-4 h-4 shrink-0" />{message}</p>}
      {status === "error" && <p role="alert" className="text-sm text-red-400 flex items-center gap-1.5"><XCircle className="w-4 h-4 shrink-0" />{message}</p>}
      {/* The save went through, but requests still pointed at an instance it
          removed: they can't be approved or pushed any more (the slug's
          connection is gone — guardrail 32) until re-routed or declined. */}
      {status === "ok" && strandedRemoved.length > 0 && (
        <p role="status" className="text-sm text-amber-400 flex items-start gap-1.5">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>
            {t("settings.arr.removedOpenRequests", {
              label,
              list: strandedRemoved
                .map((r) => t("settings.arr.removedOpenRequestsItem", { slug: r.slug, count: r.openRequests }))
                .join(", "),
            })}
          </span>
        </p>
      )}
      {loadFailed && (
        <p role="alert" className="text-sm text-red-400 flex items-center gap-1.5">
          <XCircle className="w-4 h-4 shrink-0" />
          {t("settings.arr.loadFailed")}
        </p>
      )}
      <p className="text-xs text-zinc-500">{service === "radarr" ? t("settings.arr.sharedEndpointsMovies") : t("settings.arr.sharedEndpointsTv")}</p>
    </div>
  );
}


// One named instance's editor card. Its "copied" tick is its own (the card is
// keyed by the draft id, so it never moves to a neighbour after a removal).
function InstanceCard({
  service, draft: d, idx, test, options, confirmingRemove,
  onUpdate, onRefreshOptions, onAskRemove, onRemove, onCancelRemove,
}: {
  service: ArrService;
  draft: Draft;
  idx: number;
  test: TestResult | undefined;
  options: CardOptions;
  confirmingRemove: boolean;
  onUpdate: (patch: Partial<Draft>) => void;
  onRefreshOptions: () => void;
  // A never-saved draft has nothing on the server to delete, so the caller
  // drops it at once; only a saved one asks for confirmation.
  onAskRemove: () => void;
  onRemove: () => void;
  onCancelRemove: () => void;
}) {
  const t = useT();
  const { copied, copy } = useCopyFeedback();
  const label = service === "radarr" ? "Radarr" : "Sonarr";
  // Full webhook URL the admin pastes into Radarr/Sonarr (the ?token= form —
  // guardrail 2). Only shown after loading, which happens in the browser, so
  // `window` exists; the typeof check is just a safety net. A blocked
  // clipboard leaves the URL on screen to copy by hand.
  const webhookUrl = (secret: string) =>
    `${typeof window !== "undefined" ? window.location.origin : ""}${withBasePath(`/api/webhooks/${service}`)}?token=${encodeURIComponent(secret)}`;
  const opts = options;
  // The loaded options, or null while loading / after an error / before a
  // save — one narrowed value instead of casting `opts` at every use.
  const ready: ArrOptions | null = opts && typeof opts === "object" ? opts : null;
  const languageProfiles = ready?.languageProfiles ?? [];
  // Why the dropdowns aren't showing yet, for the note under each field.
  const optsNote = opts === "loading"
    ? t("settings.arr.optsLoading")
    : opts === "error"
      ? t("settings.arr.optsError")
      : t("settings.arr.optsSaveFirst");
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 space-y-3">
      <div className="lg:grid lg:grid-cols-2 lg:gap-4 space-y-3 lg:space-y-0">
        <div className="space-y-1.5">
          <Label htmlFor={`${service}-${idx}-slug`}>{t("settings.instances.slug")}</Label>
          <Input
            id={`${service}-${idx}-slug`}
            value={d.slug}
            disabled={!d.isNew}
            onChange={(e) => onUpdate({ slug: e.target.value.toLowerCase() })}
            placeholder="anime"
            className="bg-zinc-800 border-zinc-700 font-mono disabled:opacity-60"
          />
          {!d.isNew && <p className="text-xs text-zinc-500">{t("settings.instances.slugFixed")}</p>}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${service}-${idx}-name`}>{t("settings.instances.displayName")}</Label>
          <Input
            id={`${service}-${idx}-name`}
            value={d.name}
            onChange={(e) => onUpdate({ name: e.target.value })}
            placeholder="Anime"
            className="bg-zinc-800 border-zinc-700"
          />
        </div>
      </div>

      <div className="lg:grid lg:grid-cols-2 lg:gap-4 space-y-3 lg:space-y-0">
        <div className="space-y-1.5">
          <Label htmlFor={`${service}-${idx}-url`}>{t("settings.arr.url", { label })}</Label>
          <Input
            id={`${service}-${idx}-url`}
            type="url"
            value={d.url}
            onChange={(e) => onUpdate({ url: e.target.value })}
            placeholder={service === "radarr" ? "http://radarr-anime:7878" : "http://sonarr-anime:8989"}
            className="bg-zinc-800 border-zinc-700 font-mono"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${service}-${idx}-key`}>{t("settings.arr.apiKey")}</Label>
          <Input
            id={`${service}-${idx}-key`}
            type="password"
            // A secret for Radarr/Sonarr, not a login: a browser or
            // password manager must not fill the Summonarr password in.
            autoComplete="new-password"
            data-1p-ignore
            data-lpignore="true"
            value={d.apiKey}
            onChange={(e) => onUpdate({ apiKey: e.target.value })}
            placeholder={d.hasApiKey ? SECRET_MASK_SENTINEL : t("settings.arr.apiKeyPlaceholder")}
            className="bg-zinc-800 border-zinc-700 font-mono"
          />
          {/* Same "saved, hidden" helper the notification channels show —
              the masked placeholder alone doesn't say whether a blank
              field means "nothing saved" or "saved, write-only". */}
          {d.hasApiKey && !d.apiKey && (
            <p className="text-xs text-zinc-500">{t("settings.form.agents.secretKeep")}</p>
          )}
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={`${service}-${idx}-external-url`}>{t("settings.form.arr.externalUrl")}</Label>
        <Input
          id={`${service}-${idx}-external-url`}
          type="url"
          value={d.externalUrl}
          onChange={(e) => onUpdate({ externalUrl: e.target.value })}
          placeholder={service === "radarr" ? "https://radarr-anime.example.com" : "https://sonarr-anime.example.com"}
          className="bg-zinc-800 border-zinc-700 font-mono"
        />
        <p className="text-xs text-zinc-500">{t("settings.form.arr.externalUrlHelp", { service: label })}</p>
      </div>

      <div className="lg:grid lg:grid-cols-2 lg:gap-4 space-y-3 lg:space-y-0">
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor={`${service}-${idx}-folder`}>{t("settings.arr.rootFolder")} <span className="text-zinc-500">{t("settings.common.optional")}</span></Label>
            {ready && (
              <button type="button" onClick={onRefreshOptions} className="flex items-center gap-1 min-h-8 px-2 -my-2 -mr-2 text-xs text-zinc-500 hover:text-zinc-100">
                <RefreshCw className="w-3 h-3" />{t("settings.common.refresh")}
              </button>
            )}
          </div>
          {ready ? (
            <ArrProfileSelect
              id={`${service}-${idx}-folder`}
              value={d.rootFolder}
              onChange={(rootFolder) => onUpdate({ rootFolder })}
              defaultLabel={t("settings.arr.serviceDefault", { label })}
              options={ready.rootFolders.map((f) => ({ value: f.path, label: f.path }))}
              staleLabel={(value) => t("settings.arr.notFoundOnServer", { value })}
            />
          ) : (
            <p className="text-xs text-zinc-500 h-8 flex items-center">{optsNote}</p>
          )}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${service}-${idx}-profile`}>{t("settings.arr.qualityProfile")} <span className="text-zinc-500">{t("settings.common.optional")}</span></Label>
          {ready ? (
            <ArrProfileSelect
              id={`${service}-${idx}-profile`}
              value={d.qualityProfileId}
              onChange={(qualityProfileId) => onUpdate({ qualityProfileId })}
              defaultLabel={t("settings.arr.serviceDefault", { label })}
              options={ready.qualityProfiles.map((p) => ({ value: String(p.id), label: p.name }))}
              staleLabel={(id) => t("settings.arr.notFoundOnServer", { value: t("settings.arr.profileNumber", { id }) })}
            />
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
            <Label htmlFor={`${service}-${idx}-min-availability`}>{t("settings.arr.minAvailability")} <span className="text-zinc-500">{t("settings.common.optional")}</span></Label>
            <StyledSelect
              compact
              id={`${service}-${idx}-min-availability`}
              value={d.minimumAvailability}
              onChange={(e) => onUpdate({ minimumAvailability: e.target.value })}
            >
              <option value="">{t("settings.arr.serviceDefault", { label })}</option>
              {MINIMUM_AVAILABILITY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{t(o.labelKey)}</option>
              ))}
            </StyledSelect>
            <p className="text-xs text-zinc-500">{t("settings.arr.minAvailabilityHelp")}</p>
          </div>
        </div>
      )}

      {service === "sonarr" && languageProfiles.length > 0 && (
        <div className="lg:grid lg:grid-cols-2 lg:gap-4 space-y-3 lg:space-y-0">
          <div className="space-y-1.5">
            <Label htmlFor={`${service}-${idx}-language-profile`}>{t("settings.arr.languageProfile")} <span className="text-zinc-500">{t("settings.common.optional")}</span></Label>
            <ArrProfileSelect
              id={`${service}-${idx}-language-profile`}
              value={d.languageProfileId}
              onChange={(languageProfileId) => onUpdate({ languageProfileId })}
              defaultLabel={t("settings.arr.serviceDefault", { label })}
              options={languageProfiles.map((p) => ({ value: String(p.id), label: p.name }))}
              staleLabel={(id) => t("settings.arr.notFoundOnServer", { value: t("settings.arr.profileNumber", { id }) })}
            />
            <p className="text-xs text-zinc-500">{t("settings.arr.languageProfileHelp")}</p>
          </div>
        </div>
      )}

      <div className="space-y-1.5">
        <Label htmlFor={`${service}-${idx}-hook`}>{t("settings.arr.webhookSecret")} <span className="text-zinc-500">{t("settings.arr.webhookSecretHint", { label })}</span></Label>
        <div className="flex gap-2">
          <Input
            id={`${service}-${idx}-hook`}
            type="text"
            value={d.webhookSecret}
            onChange={(e) => onUpdate({ webhookSecret: e.target.value })}
            placeholder={d.hasWebhookSecret ? SECRET_MASK_SENTINEL : t("settings.arr.webhookSecretPlaceholder")}
            className="bg-zinc-800 border-zinc-700 font-mono"
          />
          <Button
            type="button"
            variant="outline"
            className="shrink-0 border-zinc-700 text-zinc-300 hover:text-zinc-100"
            onClick={() => onUpdate({ webhookSecret: generateSecret() })}
          >
            {t("settings.arr.generate")}
          </Button>
        </div>
        {d.webhookSecret && (
          <div className="space-y-1">
            <div className="flex items-center gap-2 rounded-md bg-zinc-800 border border-zinc-700 px-3 py-2">
              <span className="flex-1 font-mono text-xs text-zinc-300 truncate">{webhookUrl(d.webhookSecret)}</span>
              <button type="button" onClick={() => void copy(webhookUrl(d.webhookSecret))} className="shrink-0 p-2 -m-2 text-zinc-500 hover:text-zinc-100 transition-colors" aria-label={t("settings.arr.copyWebhook")}>
                {copied ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
              </button>
            </div>
            <p className="text-xs text-zinc-500">{t("settings.arr.webhookHelp", { label })}</p>
          </div>
        )}
        {d.hasWebhookSecret && !d.webhookSecret && (
          <p className="text-xs text-zinc-500">{t("settings.arr.webhookSaved")}</p>
        )}
      </div>

      <div className="flex flex-wrap gap-x-6 gap-y-2 pt-1">
        <label className="flex items-center gap-2 text-sm text-zinc-300">
          <input type="checkbox" checked={d.animeOnly} onChange={(e) => onUpdate({ animeOnly: e.target.checked })} />
          {t("settings.arr.autoRouteAnime")}
        </label>
        <label className="flex items-center gap-2 text-sm text-zinc-300">
          <input type="checkbox" checked={d.restricted} onChange={(e) => onUpdate({ restricted: e.target.checked })} />
          {t("settings.instances.restricted")}
        </label>
        <label className="flex items-center gap-2 text-sm text-zinc-300">
          <input type="checkbox" checked={d.serverAll} onChange={(e) => onUpdate({ serverAll: e.target.checked })} />
          {t("settings.arr.openToAll")}
        </label>
        <label className="flex items-center gap-2 text-sm text-zinc-300">
          <input type="checkbox" checked={d.skipLibraryCheck} onChange={(e) => onUpdate({ skipLibraryCheck: e.target.checked })} />
          {t("settings.arr.separateLibrary")}
        </label>
      </div>

      <div className="flex items-center justify-between pt-1">
        {test?.version && <span className="text-xs text-green-400 flex items-center gap-1"><CheckCircle className="w-3.5 h-3.5" />{t("settings.arr.connectedVersion", { version: test.version })}</span>}
        {test?.error && <span className="text-xs text-red-400 flex items-center gap-1"><XCircle className="w-3.5 h-3.5" />{test.error}</span>}
        {!test && <span />}
        {!confirmingRemove && (
          <button
            type="button"
            // A never-saved draft has nothing on the server to delete, so
            // drop it at once; only ask for confirmation on a saved one.
            onClick={onAskRemove}
            className="flex items-center gap-1 min-h-8 px-2 -my-2 -mr-2 text-xs text-red-400 hover:text-[var(--ds-danger-hover)]"
          >
            <Trash2 className="w-3.5 h-3.5" />{t("settings.common.remove")}
          </button>
        )}
      </div>

      {/* Removal only happens on Save, because the server replaces the
          whole instance list at once. The message spells out what is
          lost: the API key and webhook secret are encrypted and can't be
          recovered. Requests already sent to this instance are kept. */}
      {confirmingRemove && (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 p-3 space-y-2">
          <p className="text-xs text-red-400">
            {t("settings.arr.confirmRemove", { name: d.name.trim() || d.slug || t("settings.arr.thisInstance"), label })}{" "}
            <strong>{t("settings.arr.confirmRemoveKept")}</strong>
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onRemove}
              autoFocus
              className="inline-flex items-center gap-1 rounded-md bg-red-600 px-2.5 py-1 text-xs font-medium text-[var(--ds-on-status)] hover:bg-[var(--ds-danger-hover)] transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />{t("settings.arr.removeInstance")}
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

export function ArrInstancesManager() {
  return (
    <div className="space-y-8">
      <ServiceInstances service="radarr" />
      <div className="border-t border-zinc-800" />
      <ServiceInstances service="sonarr" />
    </div>
  );
}
