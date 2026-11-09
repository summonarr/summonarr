"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/design";
import {
  AlertTriangle,
  CheckCircle,
  CircleDashed,
  Loader2,
  Play,
  RefreshCw,
  Sparkles,
  XCircle,
} from "@/components/icons";
import {
  KIND_LABEL_KEY,
  STARTER_PACK_ANSWER,
  type RunError,
  type StarterPackItem,
  type TrashService,
} from "./types";
import { ApplyLog } from "./apply-log";
import { RefreshErrorBanner } from "./banners";
import { answerOf, applyOutcome } from "./outcomes";
import { StatusNote } from "./status-note";
import { useCatalogRefresh } from "./use-catalog-refresh";
import { useTrashRun } from "./use-trash-run";
import { appliableStarterItems, mergeStarterSelection } from "./starter-pack-select";
import { withBasePath } from "@/lib/base-path";
import { fetchJson, LONG_RUN_TIMEOUT_MS, jsonInit } from "@/lib/client/fetch-json";
import { useAsyncAction } from "@/hooks/use-async-action";
import { check, v } from "@/lib/validate";
import { useT } from "@/components/i18n/i18n-provider";
import { rich } from "@/components/settings/forms/rich";

interface StarterPackCardProps {
  radarrConfigured: boolean;
  sonarrConfigured: boolean;
  // The card applies to the DEFAULT instance only (guardrail 32); when a named
  // instance exists it says so, pointing at the Instance picker on the spec tabs.
  namedInstancesConfigured?: boolean;
  // Notify parent when the starter pack catalog/apply state changed, so KPIs can refresh.
  onChanged?: () => void;
}

// A failed load's body may carry the db-push hint (the schema is behind).
const LOAD_FAILURE_BODY = v.object({ schemaDiagnostic: v.optional(v.string()) });

// The library list. Loads overlap (the mount, a catalog refresh, the re-read
// after an apply): each new load drops the one before it, so an older answer
// landing last can't overwrite a newer one, and leaving the page drops it too.
function useStarterPack() {
  const t = useT();
  const [items, setItems] = useState<StarterPackItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<RunError | null>(null);
  const action = useAsyncAction();
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  }, [t]);

  const load = useCallback(async () => {
    const res = await action.run("load", (signal) =>
      fetchJson(withBasePath(`/api/admin/trash-guides/starter-pack`), { schema: STARTER_PACK_ANSWER, signal }));
    if (!res || (!res.ok && res.kind === "aborted")) return;
    setLoaded(true);
    if (res.ok) {
      setItems(res.data.items ?? []);
      setLoadError(null);
      return;
    }
    // A failed load (500 from resolveStarterPack, 401/403 from withAdmin) must
    // not masquerade as "Library is empty." — surface the reason and keep
    // whatever list was already on screen rather than blanking it.
    const diagnostic = check(LOAD_FAILURE_BODY, res.body);
    const schemaDiagnostic = diagnostic.ok ? diagnostic.value.schemaDiagnostic : undefined;
    const reason = res.kind === "http" ? res.error || `HTTP ${res.status}`
      : res.kind === "invalid" ? `HTTP ${res.status}`
        : tRef.current("trash.spec.error.network");
    setLoadError({ errors: [reason], ...(schemaDiagnostic ? { schemaDiagnostic } : {}) });
  }, [action]);

  useEffect(() => {
    void load();
  }, [load]);

  return { items, loaded, loadError, dismissLoadError: () => setLoadError(null), load };
}

export function StarterPackCard({
  radarrConfigured,
  sonarrConfigured,
  namedInstancesConfigured = false,
  onChanged,
}: StarterPackCardProps) {
  const t = useT();
  const { items, loaded, loadError, dismissLoadError, load } = useStarterPack();
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  // Apply's own run: a 409 is "already running" (amber, clears itself); a
  // refusal's reason goes to its banner, a run's failures to the log.
  const apply = useTrashRun();
  const lastResolvedKeyRef = useRef<string>("");
  const seenIdsRef = useRef<ReadonlySet<string>>(new Set());

  const refresh = useCatalogRefresh(async () => {
    await load();
    onChanged?.();
  });

  // Only a service with a configured connection can take an apply
  // (starter-pack-select.ts).
  const serviceConfigured = useCallback(
    (service: TrashService) => (service === "RADARR" ? radarrConfigured : sonarrConfigured),
    [radarrConfigured, sonarrConfigured],
  );
  const appliable = useMemo(() => appliableStarterItems(items, serviceConfigured), [items, serviceConfigured]);
  const resolvedIds = useMemo(() => appliable.map((i) => i.spec.id), [appliable]);
  const recommendedIds = useMemo(
    () => appliable.filter((i) => i.item.recommended).map((i) => i.spec.id),
    [appliable],
  );
  // Pre-select the recommended specs, but only when the set of available specs
  // actually changes. A reload after Apply returns the same set, so the admin's
  // own picks are kept; a spec that appears or disappears leaves the other
  // picks alone and ticks only the newcomer, if recommended.
  useEffect(() => {
    const key = resolvedIds.slice().sort().join(",");
    if (key !== lastResolvedKeyRef.current) {
      lastResolvedKeyRef.current = key;
      const seen = seenIdsRef.current;
      seenIdsRef.current = new Set(resolvedIds);
      setSelected((prev) => mergeStarterSelection(prev, seen, resolvedIds, recommendedIds));
    }
  }, [resolvedIds, recommendedIds]);

  // What Apply sends: the ticks that are still appliable.
  const toApply = resolvedIds.filter((id) => selected.has(id));
  const canApply = (radarrConfigured || sonarrConfigured) && toApply.length > 0;

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleRefresh() {
    apply.dismissLog();
    void refresh.run();
  }

  async function handleApply() {
    if (toApply.length === 0 || apply.busy()) return;
    apply.begin();
    // Every selected spec is written to its instance in one request: no client
    // timeout, or a slow success would read as a failure.
    const res = await apply.request((signal) =>
      fetchJson(withBasePath(`/api/admin/trash-guides/apply`), { init: jsonInit("POST", { specIds: toApply }), timeoutMs: LONG_RUN_TIMEOUT_MS, signal }),
    );
    if (!res) return;
    const answer = answerOf(res);
    if (answer === undefined) return;
    if (answer === null) {
      apply.fail(t("trash.spec.error.network"));
      return;
    }
    const outcome = applyOutcome(answer.status, answer.body, t("trash.spec.error.apply", { status: answer.status }));
    if (outcome.kind === "skipped") {
      apply.skip("running");
      return;
    }
    // 403 (integration disabled), 429 (rate limit) and 400 (bad body) answer
    // a bare `{ error }` with no per-spec results: the reason goes to the
    // banner instead of an error badge pointing at nothing.
    apply.done(outcome.failed, outcome.errors.length > 0 ? { errors: outcome.errors } : null, outcome.results);
    if (outcome.results.length > 0 || !outcome.failed) {
      await load();
      onChanged?.();
    }
  }

  return (
    <div className="space-y-4">
      <Card
        className="border-indigo-500/30 p-6"
        style={{ background: "linear-gradient(135deg, color-mix(in oklab, var(--ds-accent) 12%, var(--ds-bg-1)), var(--ds-bg-1))" }}
      >
        <div className="flex items-start justify-between gap-4 mb-4 flex-wrap">
          <StarterPackIntro namedInstancesConfigured={namedInstancesConfigured} />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              onClick={handleRefresh}
              disabled={refresh.state === "running"}
              className="bg-zinc-800 hover:bg-zinc-700 text-zinc-100"
              title={t("trash.starter.refreshTitle")}
            >
              {refresh.state === "running"
                ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />{t("trash.sync.refreshing")}</>
                : <><RefreshCw className="w-4 h-4 mr-2" />{t("trash.sync.refreshCatalog")}</>}
            </Button>
            <Button
              type="button"
              onClick={handleApply}
              disabled={!canApply || apply.running}
              className="bg-indigo-600 hover:bg-indigo-500 text-[var(--ds-accent-fg)]"
            >
              {apply.running
                ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />{t("trash.starter.applying")}</>
                : <><Play className="w-4 h-4 mr-2" />{t("trash.starter.applySelected", { count: toApply.length })}</>}
            </Button>
          </div>
        </div>

        {items.length > 0 && items.every((i) => !i.spec) && <CatalogEmptyNote />}

        {!loaded ? (
          <p className="text-xs text-zinc-500 italic">{t("trash.starter.loading")}</p>
        ) : items.length === 0 ? (
          <p className="text-xs text-zinc-500 italic">{t("trash.starter.empty")}</p>
        ) : (
          <>
            <StarterQuickSelect
              recommendedIds={recommendedIds}
              resolvedIds={resolvedIds}
              selected={selected}
              onSelect={(ids) => setSelected(new Set(ids))}
            />
            {(["RADARR", "SONARR"] as const).map((service) => (
              <StarterPackGroup
                key={service}
                service={service}
                rows={items.filter((i) => i.item.service === service)}
                configured={serviceConfigured(service)}
                selected={selected}
                onToggle={toggle}
              />
            ))}
          </>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-3 text-xs pt-4 border-t border-indigo-500/20">
          <StarterPackTally items={items} />
          {refresh.state === "ok" && <StatusNote tone="ok">{t("trash.sync.catalogRefreshed")}</StatusNote>}
          {refresh.state === "error" && <StatusNote tone="error">{t("trash.starter.refreshFailedSee")}</StatusNote>}
          {refresh.skipped && <StatusNote tone="running">{t("trash.sync.refreshAlreadyRunning")}</StatusNote>}
          {apply.state === "ok" && <StatusNote tone="ok">{t("trash.starter.selectionApplied")}</StatusNote>}
          {apply.state === "error" && <StatusNote tone="error">{t("trash.starter.someFailed")}</StatusNote>}
          {apply.skipped && <StatusNote tone="running">{t("trash.sync.alreadyRunning")}</StatusNote>}
        </div>
      </Card>

      {loadError && <RefreshErrorBanner error={loadError} title={t("trash.banner.loadFailed")} onDismiss={dismissLoadError} />}
      {refresh.error && <RefreshErrorBanner error={refresh.error} onDismiss={refresh.dismiss} />}
      {apply.error && <RefreshErrorBanner error={apply.error} title={t("trash.banner.applyFailed")} onDismiss={apply.dismissError} />}
      {apply.log.length > 0 && <ApplyLog results={apply.log} onDismiss={apply.dismissLog} />}
    </div>
  );
}

function StarterPackIntro({ namedInstancesConfigured }: { namedInstancesConfigured: boolean }) {
  const t = useT();
  return (
    <div className="flex items-start gap-3">
      <div className="w-10 h-10 rounded-lg bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center shrink-0">
        <Sparkles className="w-5 h-5 text-indigo-300" />
      </div>
      <div>
        <h2 className="font-semibold text-zinc-100 text-lg">{t("trash.starter.title")}</h2>
        <p className="text-sm text-zinc-400 mt-0.5 max-w-2xl">
          {rich(t("trash.starter.description"), {
            recommended: <span className="text-indigo-300">{t("trash.starter.recommended")}</span>,
          })}
        </p>
        {namedInstancesConfigured && (
          <p className="text-xs text-zinc-500 mt-1 max-w-2xl">{t("trash.starter.defaultInstanceNote")}</p>
        )}
      </div>
    </div>
  );
}

// Every curated row is missing from the local catalog: it was never pulled.
function CatalogEmptyNote() {
  const t = useT();
  return (
    <div className="mb-4 p-3 rounded-md bg-amber-500/10 border border-amber-500/30 flex items-start gap-2 text-xs text-amber-400">
      <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
      <div>
        <p className="font-medium">{t("trash.starter.catalogEmpty")}</p>
        <p className="mt-0.5 text-zinc-400">
          {t("trash.starter.catalogEmptyHint")}
        </p>
      </div>
    </div>
  );
}

function StarterQuickSelect({
  recommendedIds,
  resolvedIds,
  selected,
  onSelect,
}: {
  recommendedIds: readonly string[];
  resolvedIds: readonly string[];
  selected: ReadonlySet<string>;
  onSelect: (ids: readonly string[]) => void;
}) {
  const t = useT();
  const allSelected = resolvedIds.length > 0 && resolvedIds.every((id) => selected.has(id));
  const recommendedSelected = recommendedIds.length > 0 && recommendedIds.every((id) => selected.has(id));
  return (
    <div className="flex flex-wrap items-center gap-2 mb-3 text-xs">
      <span className="text-zinc-500">{t("trash.starter.quickSelect")}</span>
      <button
        type="button"
        onClick={() => onSelect(recommendedIds)}
        disabled={recommendedIds.length === 0 || recommendedSelected}
        className="px-2 py-0.5 rounded bg-indigo-600/30 hover:bg-indigo-600/20 text-zinc-100 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {t("trash.starter.recommendedCount", { count: recommendedIds.length })}
      </button>
      <button
        type="button"
        onClick={() => onSelect(resolvedIds)}
        disabled={resolvedIds.length === 0 || allSelected}
        className="px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {t("trash.starter.allCount", { count: resolvedIds.length })}
      </button>
      {selected.size > 0 && (
        <button
          type="button"
          onClick={() => onSelect([])}
          className="px-2 py-0.5 text-zinc-400 hover:text-zinc-100"
        >
          {t("trash.starter.clearCount", { count: selected.size })}
        </button>
      )}
    </div>
  );
}

function StarterPackGroup({
  service,
  rows,
  configured,
  selected,
  onToggle,
}: {
  service: TrashService;
  rows: readonly StarterPackItem[];
  configured: boolean;
  selected: ReadonlySet<string>;
  onToggle: (id: string) => void;
}) {
  const t = useT();
  if (rows.length === 0) return null;
  return (
    <div className="mb-4 last:mb-0">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-2">
        {service === "RADARR" ? t("trash.starter.radarrHeading") : t("trash.starter.sonarrHeading")}
        <span className="ml-2 font-normal normal-case tracking-normal text-zinc-500">{rows.length}</span>
      </h3>
      <div className="grid sm:grid-cols-2 gap-3">
        {rows.map((row, i) => (
          <StarterPackRow
            key={`${service}-${i}`}
            row={row}
            configured={configured}
            selected={!!row.spec && selected.has(row.spec.id)}
            onToggle={() => row.spec && onToggle(row.spec.id)}
          />
        ))}
      </div>
    </div>
  );
}

// Missing from the catalog, applied cleanly, and errored — across both services.
function StarterPackTally({ items }: { items: readonly StarterPackItem[] }) {
  const t = useT();
  const missing = items.filter((i) => !i.spec).length;
  const applied = items.filter((i) => i.application?.appliedAt && !i.application.lastError).length;
  const errored = items.filter((i) => i.application?.lastError).length;
  const catalogEmpty = items.length > 0 && missing === items.length;
  return (
    <>
      {missing > 0 && !catalogEmpty && (
        <span className="text-amber-400 flex items-center gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5" />
          {t("trash.starter.missingCount", { count: missing })}
        </span>
      )}
      {applied > 0 && (
        <span className="text-green-400 flex items-center gap-1.5">
          <CheckCircle className="w-3.5 h-3.5" />
          {t("trash.starter.appliedOf", { applied, total: items.length })}
        </span>
      )}
      {errored > 0 && (
        <span className="text-red-400 flex items-center gap-1.5">
          <XCircle className="w-3.5 h-3.5" />
          {t("trash.starter.erroredCount", { count: errored })}
        </span>
      )}
    </>
  );
}

function StarterPackRow({
  row,
  configured,
  selected,
  onToggle,
}: {
  row: StarterPackItem;
  /** The row's service has a connection; without one it can't be applied. */
  configured: boolean;
  selected: boolean;
  onToggle: () => void;
}) {
  const t = useT();
  const { item, spec, application } = row;
  let status: { icon: React.ReactNode; label: string; tone: string };
  if (!spec) {
    status = { icon: <AlertTriangle className="w-3.5 h-3.5" />, label: t("trash.status.missing"), tone: "text-amber-400" };
  } else if (!configured) {
    status = { icon: <AlertTriangle className="w-3.5 h-3.5" />, label: t("trash.status.notConfigured"), tone: "text-zinc-400" };
  } else if (application?.lastError) {
    status = { icon: <XCircle className="w-3.5 h-3.5" />, label: t("trash.status.error"), tone: "text-red-400" };
  } else if (application?.appliedAt) {
    status = { icon: <CheckCircle className="w-3.5 h-3.5" />, label: t("trash.status.applied"), tone: "text-green-400" };
  } else {
    status = { icon: <CircleDashed className="w-3.5 h-3.5" />, label: t("trash.status.ready"), tone: "text-zinc-300" };
  }

  const interactive = !!spec && configured;
  return (
    <label
      className={`block rounded-md border p-3 transition-colors ${
        interactive
          ? selected
            ? "border-indigo-500/50 bg-indigo-500/10 cursor-pointer hover:bg-indigo-500/15"
            : item.recommended
              ? "border-indigo-500/30 bg-zinc-950/60 cursor-pointer hover:bg-indigo-500/5"
              : "border-zinc-800 bg-zinc-950/60 cursor-pointer hover:bg-zinc-900/60"
          : "border-zinc-800 bg-zinc-950/40 opacity-60"
      }`}
    >
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={selected && interactive}
          onChange={onToggle}
          disabled={!interactive}
          className="mt-0.5 w-4 h-4 rounded border-zinc-600 bg-zinc-800 accent-indigo-500 disabled:cursor-not-allowed"
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 flex-wrap">
                <p className="text-sm text-zinc-100 font-medium">
                  {item.labelKey ? t(item.labelKey, item.labelVars) : item.label}
                </p>
                <Chip tone="neutral">{t(KIND_LABEL_KEY[item.kind])}</Chip>
                {item.recommended && <Chip tone="accent">{t("trash.starter.recommended")}</Chip>}
              </div>
            </div>
            <span className={`text-xs inline-flex items-center gap-1 whitespace-nowrap ${status.tone}`}>
              {status.icon}
              {status.label}
            </span>
          </div>
          <p className="text-xs text-zinc-500 mt-1 whitespace-pre-line">
            {item.rationaleKey ? t(item.rationaleKey) : item.rationale}
          </p>
          {spec && (
            <p className="text-[11px] text-zinc-500 mt-2 font-mono truncate" title={spec.trashId}>
              {spec.name} · {spec.trashId.slice(0, 14)}…
            </p>
          )}
          {application?.lastError && (
            <p className="text-[11px] text-red-400 mt-1 truncate" title={application.lastError}>
              {application.lastError}
            </p>
          )}
        </div>
      </div>
    </label>
  );
}
