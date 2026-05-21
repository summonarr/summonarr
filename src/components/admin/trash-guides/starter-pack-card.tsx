"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
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
  KIND_LABEL,
  type ActionState,
  type ApplyResult,
  type StarterPackItem,
} from "./types";
import { ApplyLog } from "./apply-log";
import { RefreshErrorBanner } from "./banners";

interface StarterPackCardProps {
  radarrConfigured: boolean;
  sonarrConfigured: boolean;
  // Notify parent when the starter pack catalog/apply state changed, so KPIs can refresh.
  onChanged?: () => void;
}

export function StarterPackCard({
  radarrConfigured,
  sonarrConfigured,
  onChanged,
}: StarterPackCardProps) {
  const [items, setItems] = useState<StarterPackItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [applyState, setApplyState] = useState<ActionState>("idle");
  const [refreshState, setRefreshState] = useState<ActionState>("idle");
  const [applyLog, setApplyLog] = useState<ApplyResult[]>([]);
  const [refreshError, setRefreshError] = useState<{ errors: string[]; schemaDiagnostic?: string } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const lastResolvedKeyRef = useRef<string>("");

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/trash-guides/starter-pack`);
      const data = (await res.json()) as { items: StarterPackItem[] };
      setItems(data.items ?? []);
      setLoaded(true);
    } catch {
      setItems([]);
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
    setApplyLog([]);
    setRefreshError(null);
    try {
      const res = await fetch(`/api/admin/trash-guides/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (res.status === 409) {
        setRefreshState("error");
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setRefreshError({ errors: [data.error ?? "Trash sync already running. Try again in 30 seconds."] });
        setTimeout(() => setRefreshState((s) => (s === "error" ? s : "idle")), 3000);
        return;
      }
      const data = (await res.json()) as {
        ok?: boolean;
        errors?: string[];
        schemaDiagnostic?: string;
      };
      const hasErrors = !res.ok || !data.ok || (data.errors && data.errors.length > 0);
      setRefreshState(hasErrors ? "error" : "ok");
      if (hasErrors) {
        setRefreshError({ errors: data.errors ?? [`HTTP ${res.status}`], schemaDiagnostic: data.schemaDiagnostic });
      }
      await load();
      onChanged?.();
    } catch (err) {
      setRefreshState("error");
      setRefreshError({ errors: [err instanceof Error ? err.message : String(err)] });
    }
    setTimeout(() => setRefreshState((s) => (s === "error" ? s : "idle")), 3000);
  }

  async function handleApply() {
    if (selected.size === 0) return;
    setApplyState("running");
    setApplyLog([]);
    try {
      const res = await fetch(`/api/admin/trash-guides/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ specIds: [...selected] }),
      });
      if (res.status === 409) {
        setApplyState("error");
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setRefreshError({ errors: [data.error ?? "Trash sync already running. Try again in 30 seconds."] });
        setTimeout(() => setApplyState("idle"), 3000);
        return;
      }
      const data = (await res.json()) as { ok: boolean; results: ApplyResult[] };
      setApplyState(data.ok ? "ok" : "error");
      if (data.results) setApplyLog(data.results);
      await load();
      onChanged?.();
    } catch {
      setApplyState("error");
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
      <Card className="bg-gradient-to-br from-indigo-900/40 to-zinc-900 border-indigo-500/30 p-6">
        <div className="flex items-start justify-between gap-4 mb-4 flex-wrap">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-lg bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center shrink-0">
              <Sparkles className="w-5 h-5 text-indigo-300" />
            </div>
            <div>
              <h2 className="font-semibold text-white text-lg">Profile Library</h2>
              <p className="text-sm text-zinc-400 mt-0.5 max-w-2xl">
                Every TRaSH quality profile, naming scheme, and quality-size template in the catalog. The{" "}
                <span className="text-indigo-300">Recommended</span> baseline for 1080p movies and TV is pre-selected;
                applying any quality profile cascades to every custom format it references.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              onClick={handleRefresh}
              disabled={refreshState === "running"}
              className="bg-zinc-800 hover:bg-zinc-700 text-white"
              title="Pull the latest catalog from TRaSH"
            >
              {refreshState === "running"
                ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Refreshing…</>
                : <><RefreshCw className="w-4 h-4 mr-2" />Refresh Catalog</>}
            </Button>
            <Button
              type="button"
              onClick={handleApply}
              disabled={!canApply || applyState === "running"}
              className="bg-indigo-600 hover:bg-indigo-500 text-white"
            >
              {applyState === "running"
                ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Applying…</>
                : <><Play className="w-4 h-4 mr-2" />Apply selected ({selected.size})</>}
            </Button>
          </div>
        </div>

        {catalogEmpty && (
          <div className="mb-4 p-3 rounded-md bg-amber-500/10 border border-amber-500/30 flex items-start gap-2 text-xs text-amber-200">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <div>
              <p className="font-medium">Catalog is empty</p>
              <p className="mt-0.5 text-amber-300/80">
                Click <span className="font-semibold">Refresh Catalog</span> above to pull the TRaSH catalog into the database. This takes ~20 s the first time; subsequent refreshes only fetch changed specs.
              </p>
            </div>
          </div>
        )}

        {!loaded ? (
          <p className="text-xs text-zinc-500 italic">Loading library…</p>
        ) : items.length === 0 ? (
          <p className="text-xs text-zinc-500 italic">Library is empty.</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 mb-3 text-xs">
              <span className="text-zinc-500">Quick select:</span>
              <button
                type="button"
                onClick={selectRecommended}
                disabled={recommendedIds.length === 0 || recommendedSelected}
                className="px-2 py-0.5 rounded bg-indigo-600/30 hover:bg-indigo-600/50 text-indigo-200 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Recommended ({recommendedIds.length})
              </button>
              <button
                type="button"
                onClick={selectAll}
                disabled={resolvedIds.length === 0 || allSelected}
                className="px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                All ({resolvedIds.length})
              </button>
              {selected.size > 0 && (
                <button
                  type="button"
                  onClick={clearAll}
                  className="px-2 py-0.5 text-zinc-400 hover:text-white"
                >
                  Clear ({selected.size})
                </button>
              )}
            </div>
            {(["RADARR", "SONARR"] as const).map((service) => {
              const rows = service === "RADARR" ? grouped.radarr : grouped.sonarr;
              if (rows.length === 0) return null;
              return (
                <div key={service} className="mb-4 last:mb-0">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-2">
                    {service === "RADARR" ? "Radarr (Movies)" : "Sonarr (TV)"}
                    <span className="ml-2 font-normal normal-case tracking-normal text-zinc-600">{rows.length}</span>
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
              {missing.length} missing — try Refresh Catalog, then check upstream naming
            </span>
          )}
          {applied.length > 0 && (
            <span className="text-green-400 flex items-center gap-1.5">
              <CheckCircle className="w-3.5 h-3.5" />
              {applied.length} / {items.length} applied
            </span>
          )}
          {errored.length > 0 && (
            <span className="text-red-400 flex items-center gap-1.5">
              <XCircle className="w-3.5 h-3.5" />
              {errored.length} errored
            </span>
          )}
          {refreshState === "ok"    && <span className="text-green-400 flex items-center gap-1.5"><CheckCircle className="w-3.5 h-3.5" />Catalog refreshed</span>}
          {refreshState === "error" && <span className="text-red-400 flex items-center gap-1.5"><XCircle className="w-3.5 h-3.5" />Refresh failed — see banner below</span>}
          {applyState === "ok"    && <span className="text-green-400 flex items-center gap-1.5"><CheckCircle className="w-3.5 h-3.5" />Selection applied</span>}
          {applyState === "error" && <span className="text-red-400 flex items-center gap-1.5"><XCircle className="w-3.5 h-3.5" />One or more failed — see log below</span>}
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
  const { item, spec, application } = row;
  let status: { icon: React.ReactNode; label: string; tone: string };
  if (!spec) {
    status = { icon: <AlertTriangle className="w-3.5 h-3.5" />, label: "missing", tone: "text-amber-400" };
  } else if (application?.lastError) {
    status = { icon: <XCircle className="w-3.5 h-3.5" />, label: "error", tone: "text-red-400" };
  } else if (application?.appliedAt) {
    status = { icon: <CheckCircle className="w-3.5 h-3.5" />, label: "applied", tone: "text-green-400" };
  } else {
    status = { icon: <CircleDashed className="w-3.5 h-3.5" />, label: "ready", tone: "text-zinc-300" };
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
                <p className="text-sm text-zinc-100 font-medium">{item.label}</p>
                <span className="text-[10px] uppercase tracking-wider text-zinc-500 px-1.5 py-0.5 rounded bg-zinc-900 border border-zinc-800">
                  {KIND_LABEL[item.kind]}
                </span>
                {item.recommended && (
                  <span className="text-[10px] uppercase tracking-wider text-indigo-300 px-1.5 py-0.5 rounded bg-indigo-500/20 border border-indigo-500/40">
                    Recommended
                  </span>
                )}
              </div>
            </div>
            <span className={`text-xs inline-flex items-center gap-1 whitespace-nowrap ${status.tone}`}>
              {status.icon}
              {status.label}
            </span>
          </div>
          <p className="text-xs text-zinc-500 mt-1 whitespace-pre-line">{item.rationale}</p>
          {spec && (
            <p className="text-[11px] text-zinc-600 mt-2 font-mono truncate" title={spec.trashId}>
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
