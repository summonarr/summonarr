"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/design";
import {
  AlertTriangle,
  CheckCircle,
  CircleDashed,
  Clock,
  Loader2,
  Play,
  RefreshCw,
  Sparkles,
  XCircle,
} from "@/components/icons";
import {
  KIND_LABEL_KEY,
  type ActionState,
  type ApplyResult,
  type StarterPackItem,
} from "./types";
import { ApplyLog } from "./apply-log";
import { RefreshErrorBanner } from "./banners";
import { withBasePath } from "@/lib/base-path";
import { useT } from "@/components/i18n/i18n-provider";

// Splits a translated template on {name} placeholders and drops in nodes.
function rich(template: string, nodes: Record<string, React.ReactNode>): React.ReactNode[] {
  return template.split(/(\{\w+\})/).map((part, i) => {
    const m = /^\{(\w+)\}$/.exec(part);
    return m && m[1] in nodes ? <span key={i}>{nodes[m[1]]}</span> : part;
  });
}

interface StarterPackCardProps {
  radarrConfigured: boolean;
  sonarrConfigured: boolean;
  // The card applies to the DEFAULT instance only (guardrail 32); when a named
  // instance exists it says so, pointing at the Instance picker on the spec tabs.
  namedInstancesConfigured?: boolean;
  // Notify parent when the starter pack catalog/apply state changed, so KPIs can refresh.
  onChanged?: () => void;
}

export function StarterPackCard({
  radarrConfigured,
  sonarrConfigured,
  namedInstancesConfigured = false,
  onChanged,
}: StarterPackCardProps) {
  const t = useT();
  const [items, setItems] = useState<StarterPackItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [applyState, setApplyState] = useState<ActionState>("idle");
  const [refreshState, setRefreshState] = useState<ActionState>("idle");
  // 409 = the trash lock is held: nothing ran, so (like the Settings tab's
  // sync-settings card) it is neither a success nor a failure — an amber
  // "already running" that clears itself, not a red banner.
  const [refreshSkipped, setRefreshSkipped] = useState(false);
  const [applySkipped, setApplySkipped] = useState(false);
  const [applyLog, setApplyLog] = useState<ApplyResult[]>([]);
  const [refreshError, setRefreshError] = useState<{ errors: string[]; schemaDiagnostic?: string } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const lastResolvedKeyRef = useRef<string>("");

  const load = useCallback(async () => {
    try {
      const res = await fetch(withBasePath(`/api/admin/trash-guides/starter-pack`));
      const data = (await res.json().catch(() => ({}))) as {
        items?: StarterPackItem[];
        error?: string;
        schemaDiagnostic?: string;
      };
      if (!res.ok) {
        // A failed load (500 from resolveStarterPack, 401/403 from withAdmin) must not
        // masquerade as "Library is empty." — surface the reason and keep whatever
        // list was already on screen rather than blanking it.
        setRefreshError({ errors: [data.error ?? `HTTP ${res.status}`], schemaDiagnostic: data.schemaDiagnostic });
        setLoaded(true);
        return;
      }
      setItems(data.items ?? []);
      setLoaded(true);
    } catch (err) {
      setRefreshError({ errors: [err instanceof Error ? err.message : String(err)] });
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const resolvedIds = useMemo(
    () => items.filter((i) => i.spec).map((i) => i.spec!.id),
    [items],
  );
  const recommendedIds = useMemo(
    () => items.filter((i) => i.spec && i.item.recommended).map((i) => i.spec!.id),
    [items],
  );
  // Pre-select the recommended specs, but only when the set of available specs
  // actually changes. A reload after Apply returns the same set, so the admin's
  // own picks are kept.
  useEffect(() => {
    const key = resolvedIds.slice().sort().join(",");
    if (key !== lastResolvedKeyRef.current) {
      lastResolvedKeyRef.current = key;
      setSelected(new Set(recommendedIds));
    }
  }, [resolvedIds, recommendedIds]);

  const missing = items.filter((i) => !i.spec);
  const applied = items.filter((i) => i.application?.appliedAt && !i.application.lastError);
  const errored = items.filter((i) => i.application?.lastError);
  const catalogEmpty = items.length > 0 && missing.length === items.length;
  const configured = radarrConfigured || sonarrConfigured;
  const canApply = configured && selected.size > 0;
  const allSelected = resolvedIds.length > 0 && selected.size === resolvedIds.length;
  const recommendedSelected = recommendedIds.length > 0 && recommendedIds.every((id) => selected.has(id));

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function selectAll() { setSelected(new Set(resolvedIds)); }
  function selectRecommended() { setSelected(new Set(recommendedIds)); }
  function clearAll() { setSelected(new Set()); }

  async function handleRefresh() {
    setRefreshState("running");
    setRefreshSkipped(false);
    setApplyLog([]);
    setRefreshError(null);
    try {
      const res = await fetch(withBasePath(`/api/admin/trash-guides/refresh`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (res.status === 409) {
        setRefreshState("idle");
        setRefreshSkipped(true);
        setTimeout(() => setRefreshSkipped(false), 3000);
        return;
      }
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        errors?: string[];
        schemaDiagnostic?: string;
      };
      const hasErrors = !res.ok || !data.ok || (data.errors && data.errors.length > 0);
      setRefreshState(hasErrors ? "error" : "ok");
      if (hasErrors) {
        setRefreshError({
          errors: data.errors && data.errors.length > 0 ? data.errors : [data.error ?? `HTTP ${res.status}`],
          schemaDiagnostic: data.schemaDiagnostic,
        });
      }
      await load();
      onChanged?.();
    } catch (err) {
      setRefreshState("error");
      setRefreshError({ errors: [err instanceof Error ? err.message : String(err)] });
    }
    // Clear a success message after 3s; an error stays until the next click.
    setTimeout(() => setRefreshState((s) => (s === "error" ? s : "idle")), 3000);
  }

  async function handleApply() {
    if (selected.size === 0) return;
    setApplyState("running");
    setApplySkipped(false);
    setApplyLog([]);
    setRefreshError(null);
    try {
      const res = await fetch(withBasePath(`/api/admin/trash-guides/apply`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ specIds: [...selected] }),
      });
      if (res.status === 409) {
        setApplyState("idle");
        setApplySkipped(true);
        setTimeout(() => setApplySkipped(false), 3000);
        return;
      }
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        results?: ApplyResult[];
        error?: string;
      };
      const failed = !res.ok || !data.ok;
      setApplyState(failed ? "error" : "ok");
      if (data.results && data.results.length > 0) {
        setApplyLog(data.results);
      } else if (failed) {
        // 403 (integration disabled), 429 (rate limit) and 400 (bad body) answer a bare
        // `{ error }` with no per-spec results, so the log stays empty — surface the
        // reason in the banner instead of an error badge pointing at nothing.
        setRefreshError({ errors: [data.error ?? `HTTP ${res.status}`] });
      }
      await load();
      onChanged?.();
    } catch (err) {
      setApplyState("error");
      setRefreshError({ errors: [err instanceof Error ? err.message : String(err)] });
    }
    setTimeout(() => setApplyState("idle"), 3000);
  }

  const grouped = useMemo(() => {
    const radarr = items.filter((i) => i.item.service === "RADARR");
    const sonarr = items.filter((i) => i.item.service === "SONARR");
    return { radarr, sonarr };
  }, [items]);

  return (
    <div className="space-y-4">
      <Card
        className="border-indigo-500/30 p-6"
        style={{ background: "linear-gradient(135deg, color-mix(in oklab, var(--ds-accent) 12%, var(--ds-bg-1)), var(--ds-bg-1))" }}
      >
        <div className="flex items-start justify-between gap-4 mb-4 flex-wrap">
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
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              onClick={handleRefresh}
              disabled={refreshState === "running"}
              className="bg-zinc-800 hover:bg-zinc-700 text-zinc-100"
              title={t("trash.starter.refreshTitle")}
            >
              {refreshState === "running"
                ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />{t("trash.sync.refreshing")}</>
                : <><RefreshCw className="w-4 h-4 mr-2" />{t("trash.sync.refreshCatalog")}</>}
            </Button>
            <Button
              type="button"
              onClick={handleApply}
              disabled={!canApply || applyState === "running"}
              className="bg-indigo-600 hover:bg-indigo-500 text-[var(--ds-accent-fg)]"
            >
              {applyState === "running"
                ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />{t("trash.starter.applying")}</>
                : <><Play className="w-4 h-4 mr-2" />{t("trash.starter.applySelected", { count: selected.size })}</>}
            </Button>
          </div>
        </div>

        {catalogEmpty && (
          <div className="mb-4 p-3 rounded-md bg-amber-500/10 border border-amber-500/30 flex items-start gap-2 text-xs text-amber-400">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <div>
              <p className="font-medium">{t("trash.starter.catalogEmpty")}</p>
              <p className="mt-0.5 text-zinc-400">
                {t("trash.starter.catalogEmptyHint")}
              </p>
            </div>
          </div>
        )}

        {!loaded ? (
          <p className="text-xs text-zinc-500 italic">{t("trash.starter.loading")}</p>
        ) : items.length === 0 ? (
          <p className="text-xs text-zinc-500 italic">{t("trash.starter.empty")}</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 mb-3 text-xs">
              <span className="text-zinc-500">{t("trash.starter.quickSelect")}</span>
              <button
                type="button"
                onClick={selectRecommended}
                disabled={recommendedIds.length === 0 || recommendedSelected}
                className="px-2 py-0.5 rounded bg-indigo-600/30 hover:bg-indigo-600/20 text-zinc-100 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {t("trash.starter.recommendedCount", { count: recommendedIds.length })}
              </button>
              <button
                type="button"
                onClick={selectAll}
                disabled={resolvedIds.length === 0 || allSelected}
                className="px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {t("trash.starter.allCount", { count: resolvedIds.length })}
              </button>
              {selected.size > 0 && (
                <button
                  type="button"
                  onClick={clearAll}
                  className="px-2 py-0.5 text-zinc-400 hover:text-zinc-100"
                >
                  {t("trash.starter.clearCount", { count: selected.size })}
                </button>
              )}
            </div>
            {(["RADARR", "SONARR"] as const).map((service) => {
              const rows = service === "RADARR" ? grouped.radarr : grouped.sonarr;
              if (rows.length === 0) return null;
              return (
                <div key={service} className="mb-4 last:mb-0">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-2">
                    {service === "RADARR" ? t("trash.starter.radarrHeading") : t("trash.starter.sonarrHeading")}
                    <span className="ml-2 font-normal normal-case tracking-normal text-zinc-500">{rows.length}</span>
                  </h3>
                  <div className="grid sm:grid-cols-2 gap-3">
                    {rows.map((row, i) => (
                      <StarterPackRow
                        key={`${service}-${i}`}
                        row={row}
                        selected={!!row.spec && selected.has(row.spec.id)}
                        onToggle={() => row.spec && toggle(row.spec.id)}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-3 text-xs pt-4 border-t border-indigo-500/20">
          {missing.length > 0 && !catalogEmpty && (
            <span className="text-amber-400 flex items-center gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5" />
              {t("trash.starter.missingCount", { count: missing.length })}
            </span>
          )}
          {applied.length > 0 && (
            <span className="text-green-400 flex items-center gap-1.5">
              <CheckCircle className="w-3.5 h-3.5" />
              {t("trash.starter.appliedOf", { applied: applied.length, total: items.length })}
            </span>
          )}
          {errored.length > 0 && (
            <span className="text-red-400 flex items-center gap-1.5">
              <XCircle className="w-3.5 h-3.5" />
              {t("trash.starter.erroredCount", { count: errored.length })}
            </span>
          )}
          {refreshState === "ok"    && <span className="text-green-400 flex items-center gap-1.5"><CheckCircle className="w-3.5 h-3.5" />{t("trash.sync.catalogRefreshed")}</span>}
          {refreshState === "error" && <span className="text-red-400 flex items-center gap-1.5"><XCircle className="w-3.5 h-3.5" />{t("trash.starter.refreshFailedSee")}</span>}
          {refreshSkipped && <span className="text-amber-400 flex items-center gap-1.5"><Clock className="w-3.5 h-3.5" />{t("trash.sync.refreshAlreadyRunning")}</span>}
          {applyState === "ok"    && <span className="text-green-400 flex items-center gap-1.5"><CheckCircle className="w-3.5 h-3.5" />{t("trash.starter.selectionApplied")}</span>}
          {applyState === "error" && <span className="text-red-400 flex items-center gap-1.5"><XCircle className="w-3.5 h-3.5" />{t("trash.starter.someFailed")}</span>}
          {applySkipped && <span className="text-amber-400 flex items-center gap-1.5"><Clock className="w-3.5 h-3.5" />{t("trash.sync.alreadyRunning")}</span>}
        </div>
      </Card>

      {refreshError && <RefreshErrorBanner error={refreshError} onDismiss={() => setRefreshError(null)} />}
      {applyLog.length > 0 && <ApplyLog results={applyLog} onDismiss={() => setApplyLog([])} />}
    </div>
  );
}

function StarterPackRow({
  row,
  selected,
  onToggle,
}: {
  row: StarterPackItem;
  selected: boolean;
  onToggle: () => void;
}) {
  const t = useT();
  const { item, spec, application } = row;
  let status: { icon: React.ReactNode; label: string; tone: string };
  if (!spec) {
    status = { icon: <AlertTriangle className="w-3.5 h-3.5" />, label: t("trash.status.missing"), tone: "text-amber-400" };
  } else if (application?.lastError) {
    status = { icon: <XCircle className="w-3.5 h-3.5" />, label: t("trash.status.error"), tone: "text-red-400" };
  } else if (application?.appliedAt) {
    status = { icon: <CheckCircle className="w-3.5 h-3.5" />, label: t("trash.status.applied"), tone: "text-green-400" };
  } else {
    status = { icon: <CircleDashed className="w-3.5 h-3.5" />, label: t("trash.status.ready"), tone: "text-zinc-300" };
  }

  const interactive = !!spec;
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
          checked={selected}
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
