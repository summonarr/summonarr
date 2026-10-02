"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { stripTrashHtml } from "@/lib/trash-html";
import { useHasMounted } from "@/hooks/use-has-mounted";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import { formatRelativeTimeLocalized } from "@/lib/relative-time";
import {
  CheckCircle,
  ChevronDown,
  ChevronRight,
  Loader2,
  Shield,
  ShieldOff,
  XCircle,
} from "@/components/icons";
import {
  type ApplyResult,
  type SpecDetail,
  type SpecStatus,
  type TrashService,
  type TrashSpecKind,
} from "./types";
import { ApplyLog } from "./apply-log";
import { withBasePath } from "@/lib/base-path";

interface SpecSectionProps {
  title: string;
  description: string;
  service: TrashService;
  kind: TrashSpecKind;
  // Which instance to manage — an instance slug ("" default, "4k", or a named
  // slug). The parent remounts this component (via a variant-keyed `key`) when
  // the toggle flips, so state resets cleanly.
  variant?: string;
  disabled: boolean;
  // Notify parent to refetch e.g. KPI counts when the application set changes.
  onChanged?: () => void;
}

export function SpecSection({
  title,
  description,
  service,
  kind,
  variant = "",
  disabled,
  onChanged,
}: SpecSectionProps) {
  const mounted = useHasMounted();
  const t = useT();
  const locale = useLocale();
  const [specs, setSpecs] = useState<SpecStatus[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [details, setDetails] = useState<Map<string, SpecDetail>>(new Map());
  const [applyState, setApplyState] = useState<"idle" | "running" | "ok" | "error">("idle");
  const [applyLog, setApplyLog] = useState<ApplyResult[]>([]);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "managed" | "unmanaged" | "errored">("all");
  const [search, setSearch] = useState("");
  const [confirmingForget, setConfirmingForget] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await fetch(withBasePath(`/api/admin/trash-guides/status?service=${service.toLowerCase()}&variant=${encodeURIComponent(variant)}`), { signal });
      const data = (await res.json().catch(() => ({}))) as { specs?: SpecStatus[]; error?: string };
      // A superseded request (service/variant switched) must not overwrite
      // the newer selection's specs.
      if (signal?.aborted) return;
      if (!res.ok) {
        setSpecs([]);
        setLoadError(data.error ?? `HTTP ${res.status}`);
      } else {
        setSpecs(data.specs ?? []);
        setLoadError(null);
      }
      setLoaded(true);
    } catch (err) {
      if (signal?.aborted) return;
      setSpecs([]);
      setLoadError(err instanceof Error ? err.message : String(err));
      setLoaded(true);
    }
  }, [service, variant]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const specsHere = useMemo(
    () => specs.filter((s) => s.service === service && s.kind === kind),
    [specs, service, kind],
  );

  const filtered = useMemo(() => {
    return specsHere.filter((s) => {
      if (filter === "managed" && !s.application) return false;
      if (filter === "unmanaged" && s.application) return false;
      if (filter === "errored" && !s.application?.lastError) return false;
      if (search && !s.name.toLowerCase().includes(search.toLowerCase()) && !s.trashId.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [specsHere, filter, search]);

  // Selections survive a filter/search change but must not be acted on while
  // hidden — every count, the header checkbox and the apply payload read the
  // intersection with the visible rows.
  const visibleSelected = useMemo(
    () => filtered.filter((s) => selected.has(s.id)),
    [filtered, selected],
  );

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAllFiltered() {
    setSelected(new Set(filtered.map((s) => s.id)));
  }
  function selectBy(pred: (s: SpecStatus) => boolean) {
    setSelected(new Set(filtered.filter(pred).map((s) => s.id)));
  }
  function clearSelection() {
    setSelected(new Set());
  }

  async function toggleRow(spec: SpecStatus) {
    const nextExpanded = new Set(expanded);
    if (nextExpanded.has(spec.id)) {
      nextExpanded.delete(spec.id);
      setExpanded(nextExpanded);
      return;
    }
    nextExpanded.add(spec.id);
    setExpanded(nextExpanded);
    if (!details.has(spec.id)) {
      setRowError(null);
      let failure: string | null = null;
      try {
        const res = await fetch(withBasePath(`/api/admin/trash-guides/spec/${spec.id}?variant=${encodeURIComponent(variant)}`));
        if (res.ok) {
          const detail = (await res.json()) as SpecDetail;
          setDetails((prev) => new Map(prev).set(spec.id, detail));
        } else {
          failure = t("trash.spec.error.loadDetail", { status: res.status });
        }
      } catch {
        failure = t("trash.spec.error.network");
      }
      if (failure) {
        setRowError(failure);
        setExpanded((prev) => {
          const next = new Set(prev);
          next.delete(spec.id);
          return next;
        });
      }
    }
  }

  async function applySelected() {
    const ids = visibleSelected.map((s) => s.id);
    if (ids.length === 0) return;
    setApplyState("running");
    setApplyLog([]);
    setApplyError(null);
    try {
      const res = await fetch(withBasePath(`/api/admin/trash-guides/apply`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ specIds: ids, variant }),
      });
      // A non-OK response (409 lock contention, 429 rate limit, 400 validation,
      // 5xx) returns an { error } body, not the success shape — keep the selection
      // intact so the user can retry, and surface that message rather than
      // reading the body as a results payload.
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setApplyError(body?.error ?? t("trash.spec.error.apply", { status: res.status }));
        setApplyState("error");
        setTimeout(() => setApplyState("idle"), 3000);
        return;
      }
      const data = (await res.json()) as { ok: boolean; results: ApplyResult[] };
      setApplyState(data.ok ? "ok" : "error");
      setSelected((prev) => {
        const next = new Set(prev);
        for (const id of ids) next.delete(id);
        return next;
      });
      setApplyLog(data.results ?? []);
      await load();
      onChanged?.();
    } catch {
      setApplyError(t("trash.spec.error.network"));
      setApplyState("error");
    }
    setTimeout(() => setApplyState("idle"), 3000);
  }

  async function toggleManagement(appId: string, enabled: boolean) {
    setRowError(null);
    try {
      const res = await fetch(withBasePath(`/api/admin/trash-guides/applications/${appId}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) {
        setRowError(enabled ? t("trash.spec.error.resume", { status: res.status }) : t("trash.spec.error.pause", { status: res.status }));
        return;
      }
    } catch {
      setRowError(t("trash.spec.error.network"));
      return;
    }
    await load();
    onChanged?.();
  }

  async function deleteApplication(appId: string) {
    setConfirmingForget(null);
    setRowError(null);
    try {
      const res = await fetch(withBasePath(`/api/admin/trash-guides/applications/${appId}`), {
        method: "DELETE",
      });
      if (!res.ok) {
        setRowError(t("trash.spec.error.forget", { status: res.status }));
        return;
      }
    } catch {
      setRowError(t("trash.spec.error.network"));
      return;
    }
    await load();
    onChanged?.();
  }

  const managedCount = specsHere.filter((s) => s.application?.enabled).length;
  const erroredCount = specsHere.filter((s) => s.application?.lastError).length;
  const allSelected = filtered.length > 0 && visibleSelected.length === filtered.length;
  const someSelected = visibleSelected.length > 0 && visibleSelected.length < filtered.length;

  return (
    <div className="space-y-4">
      <Card className="bg-zinc-900 border-zinc-800 p-6">
        <div className="flex items-start justify-between gap-4 mb-4 flex-wrap">
          <div>
            <h2 className="font-semibold text-zinc-100 text-lg">{title}</h2>
            <p className="text-sm text-zinc-500 mt-0.5">{description}</p>
          </div>
          <div className="flex items-center gap-3 text-xs text-zinc-500">
            <span>{t("trash.spec.total", { count: specsHere.length })}</span>
            <span className="text-green-400">{t("trash.spec.managedCount", { count: managedCount })}</span>
            {erroredCount > 0 && <span className="text-red-400">{t("trash.starter.erroredCount", { count: erroredCount })}</span>}
          </div>
        </div>

        {rowError && (
          <p className="text-sm text-red-400 mb-3">{rowError}</p>
        )}

        <div className="flex flex-wrap gap-2 mb-3">
          {(["all", "managed", "unmanaged", "errored"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                filter === f
                  ? "bg-indigo-600 text-[var(--ds-accent-fg)]"
                  : "bg-zinc-800 text-zinc-400 hover:text-zinc-100"
              }`}
            >
              {t(`trash.spec.filter.${f}`)}
            </button>
          ))}
          <input
            type="search"
            aria-label={t("trash.spec.searchAria")}
            placeholder={t("trash.spec.searchPlaceholder")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="ml-auto bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-indigo-500 w-60"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2 mb-3 text-xs">
          <span className="text-zinc-500">{t("trash.starter.quickSelect")}</span>
          <BulkButton onClick={selectAllFiltered}>{t("trash.spec.allVisible", { count: filtered.length })}</BulkButton>
          <BulkButton onClick={() => selectBy((s) => !s.application)}>{t("trash.spec.filter.unmanaged")}</BulkButton>
          <BulkButton onClick={() => selectBy((s) => !!s.application?.enabled)}>{t("trash.spec.filter.managed")}</BulkButton>
          <BulkButton onClick={() => selectBy((s) => !!s.application?.lastError)}>{t("trash.spec.filter.errored")}</BulkButton>
          {selected.size > 0 && (
            <BulkButton onClick={clearSelection} tone="ghost">{t("trash.starter.clearCount", { count: selected.size })}</BulkButton>
          )}
        </div>

        {!loaded ? (
          <p className="text-sm text-zinc-500 italic flex items-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" /> {t("trash.spec.loading")}
          </p>
        ) : loadError ? (
          <p className="text-sm text-red-400">{t("trash.spec.loadError", { error: loadError })}</p>
        ) : specsHere.length === 0 ? (
          <p className="text-sm text-zinc-500 italic">{t("trash.spec.emptyCatalog")}</p>
        ) : filtered.length === 0 ? (
          <p className="text-sm text-zinc-500 italic">{t("trash.spec.noMatch")}</p>
        ) : (
          <div className="overflow-x-auto -mx-6">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-800 text-left">
                  <th className="py-2 px-6 w-8">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      ref={(el) => { if (el) el.indeterminate = someSelected; }}
                      onChange={() => (allSelected ? clearSelection() : selectAllFiltered())}
                      className="w-4 h-4 rounded border-zinc-600 bg-zinc-800 accent-indigo-500"
                    />
                  </th>
                  <th className="py-2 pr-4 w-6" />
                  <th className="py-2 pr-4 text-xs font-semibold uppercase tracking-wider text-zinc-500">{t("trash.spec.col.name")}</th>
                  <th className="py-2 pr-4 text-xs font-semibold uppercase tracking-wider text-zinc-500">{t("trash.spec.col.status")}</th>
                  <th className="py-2 pr-4 text-xs font-semibold uppercase tracking-wider text-zinc-500">{t("trash.spec.col.lastApplied")}</th>
                  <th className="py-2 pr-6 text-xs font-semibold uppercase tracking-wider text-zinc-500 text-right">{t("trash.spec.col.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((spec) => {
                  const isOpen = expanded.has(spec.id);
                  const detail = details.get(spec.id);
                  return (
                    <Fragment key={spec.id}>
                      <tr className="border-b border-zinc-800/50 hover:bg-zinc-800/30">
                        <td className="py-2.5 px-6">
                          <input
                            type="checkbox"
                            checked={selected.has(spec.id)}
                            onChange={() => toggle(spec.id)}
                            disabled={disabled}
                            className="w-4 h-4 rounded border-zinc-600 bg-zinc-800 accent-indigo-500"
                          />
                        </td>
                        <td className="py-2.5 pr-2">
                          <button
                            onClick={() => toggleRow(spec)}
                            className="text-zinc-500 hover:text-zinc-100"
                            aria-label={isOpen ? t("trash.spec.collapse") : t("trash.spec.expand")}
                          >
                            {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                          </button>
                        </td>
                        <td className="py-2.5 pr-4">
                          <div className="text-zinc-100">{spec.name}</div>
                          <div className="text-xs text-zinc-500 font-mono">{spec.trashId.slice(0, 12)}…</div>
                        </td>
                        <td className="py-2.5 pr-4">
                          <div className="flex items-center gap-1.5">
                            <StatusBadge spec={spec} />
                            {spec.application && spec.application.errorCount > 1 && (
                              <span
                                className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/15 text-red-400 font-mono"
                                title={
                                  spec.application.lastErrorAt
                                    ? t("trash.spec.failuresLast", { count: spec.application.errorCount, last: spec.application.lastErrorAt })
                                    : t("trash.spec.failures", { count: spec.application.errorCount })
                                }
                              >
                                ×{spec.application.errorCount}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="py-2.5 pr-4 text-zinc-400 text-xs">
                          {mounted
                            ? spec.application?.appliedAt
                              ? formatRelativeTimeLocalized(spec.application.appliedAt, locale)
                              : t("trash.spec.never")
                            : ""}
                          {spec.application?.lastError && (
                            <div className="text-red-400 text-xs mt-1 max-w-xs truncate" title={spec.application.lastError}>
                              {spec.application.lastError}
                            </div>
                          )}
                        </td>
                        <td className="py-2.5 pr-6 text-right">
                          {spec.application ? (
                            confirmingForget === spec.application.id ? (
                              <div className="flex items-center gap-2 justify-end">
                                <button
                                  type="button"
                                  aria-label={t("trash.spec.confirmForgetAria")}
                                  onClick={() => deleteApplication(spec.application!.id)}
                                  className="text-xs px-2 py-0.5 rounded bg-red-600 text-[var(--ds-on-status)] hover:bg-[var(--ds-danger-hover)] inline-flex items-center gap-1"
                                  autoFocus
                                >
                                  {t("trash.spec.confirmForget")}
                                </button>
                                <button
                                  type="button"
                                  aria-label={t("trash.spec.cancelForgetAria")}
                                  onClick={() => setConfirmingForget(null)}
                                  className="text-xs px-2 py-0.5 text-zinc-400 hover:text-zinc-100"
                                >
                                  {t("trash.spec.cancel")}
                                </button>
                              </div>
                            ) : (
                              <div className="flex items-center gap-2 justify-end">
                                <button
                                  onClick={() => toggleManagement(spec.application!.id, !spec.application!.enabled)}
                                  className="text-xs text-zinc-400 hover:text-zinc-100 inline-flex items-center gap-1"
                                  title={spec.application.enabled ? t("trash.spec.pauseTitle") : t("trash.spec.resumeTitle")}
                                >
                                  {spec.application.enabled
                                    ? <><Shield className="w-3.5 h-3.5" />{t("trash.spec.status.managed")}</>
                                    : <><ShieldOff className="w-3.5 h-3.5" />{t("trash.spec.status.paused")}</>}
                                </button>
                                <button
                                  onClick={() => setConfirmingForget(spec.application!.id)}
                                  className="text-xs text-zinc-500 hover:text-red-400"
                                >
                                  {t("trash.spec.forget")}
                                </button>
                              </div>
                            )
                          ) : (
                            <span className="text-xs text-zinc-500">—</span>
                          )}
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="bg-zinc-950/50 border-b border-zinc-800/50">
                          <td colSpan={6} className="px-10 py-4">
                            <SpecDetailView detail={detail ?? null} kind={kind} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="mt-4 flex items-center gap-3">
          <Button
            type="button"
            onClick={applySelected}
            disabled={disabled || visibleSelected.length === 0 || applyState === "running"}
            className="bg-indigo-600 hover:bg-indigo-500 text-[var(--ds-accent-fg)]"
          >
            {applyState === "running"
              ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />{t("trash.starter.applying")}</>
              : <>{t("trash.starter.applySelected", { count: visibleSelected.length })}</>}
          </Button>
          {applyState === "ok"    && <span className="text-xs text-green-400 flex items-center gap-1.5"><CheckCircle className="w-3.5 h-3.5" />{t("trash.spec.applied")}</span>}
          {applyState === "error" && <span className="text-xs text-red-400 flex items-center gap-1.5"><XCircle className="w-3.5 h-3.5" />{applyError ?? t("trash.spec.someFailedLog")}</span>}
        </div>
      </Card>

      {applyLog.length > 0 && <ApplyLog results={applyLog} onDismiss={() => setApplyLog([])} />}
    </div>
  );
}

function BulkButton({
  onClick,
  children,
  tone = "solid",
}: {
  onClick: () => void;
  children: React.ReactNode;
  tone?: "solid" | "ghost";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        tone === "ghost"
          ? "px-2 py-0.5 text-xs text-zinc-400 hover:text-zinc-100 rounded"
          : "px-2 py-0.5 text-xs bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-zinc-100 rounded"
      }
    >
      {children}
    </button>
  );
}

function StatusBadge({ spec }: { spec: SpecStatus }) {
  const t = useT();
  const app = spec.application;
  if (!app) {
    return <span className="text-xs px-2 py-0.5 rounded bg-zinc-800 text-zinc-500 font-medium">{t("trash.spec.filter.unmanaged")}</span>;
  }
  if (app.lastError) {
    return <span className="text-xs px-2 py-0.5 rounded bg-red-500/20 text-red-400 font-medium">{t("trash.spec.status.error")}</span>;
  }
  if (!app.enabled) {
    return <span className="text-xs px-2 py-0.5 rounded bg-zinc-800 text-zinc-400 font-medium">{t("trash.spec.status.paused")}</span>;
  }
  if (app.appliedAt) {
    return <span className="text-xs px-2 py-0.5 rounded bg-green-500/20 text-green-400 font-medium">{t("trash.spec.status.managed")}</span>;
  }
  return <span className="text-xs px-2 py-0.5 rounded bg-amber-500/20 text-amber-400 font-medium">{t("trash.spec.status.pending")}</span>;
}

function SpecDetailView({ detail, kind }: { detail: SpecDetail | null; kind: TrashSpecKind }) {
  const t = useT();
  if (!detail) {
    return (
      <div className="text-xs text-zinc-500 flex items-center gap-2">
        <Loader2 className="w-3.5 h-3.5 animate-spin" /> {t("trash.spec.loadingDetail")}
      </div>
    );
  }
  if (kind === "CUSTOM_FORMAT") return <CustomFormatDetail detail={detail} />;
  if (kind === "CUSTOM_FORMAT_GROUP") return <CustomFormatGroupDetail detail={detail} />;
  if (kind === "QUALITY_PROFILE") return <QualityProfileDetail detail={detail} />;
  if (kind === "NAMING") return <NamingDetail detail={detail} />;
  if (kind === "QUALITY_SIZE") return <QualitySizeDetail detail={detail} />;
  return null;
}

function CustomFormatGroupDetail({ detail }: { detail: SpecDetail }) {
  const t = useT();
  const payload = detail.payload as {
    trash_id?: string;
    trash_description?: string;
    default?: string;
    custom_formats?: Array<{ name: string; trash_id: string; required: boolean }>;
    quality_profiles?: { include?: Record<string, string> };
  };
  const members = payload.custom_formats ?? [];
  const requiredCount = members.filter((m) => m.required).length;
  const includedProfiles = Object.entries(payload.quality_profiles?.include ?? {});
  return (
    <div className="space-y-3 text-xs text-zinc-300">
      <div className="grid grid-cols-2 gap-x-6 gap-y-1">
        <div><span className="text-zinc-500">trash_id:</span> <span className="font-mono">{payload.trash_id ?? "—"}</span></div>
        <div><span className="text-zinc-500">default:</span> {payload.default ?? "false"}</div>
        <div className="col-span-2"><span className="text-zinc-500">{t("trash.spec.detail.upstreamPath")}</span> <span className="font-mono">{detail.upstreamPath}</span></div>
      </div>
      {payload.trash_description && (
        <p className="text-zinc-400 italic whitespace-pre-line">{stripTrashHtml(payload.trash_description)}</p>
      )}
      {members.length > 0 && (
        <div>
          <p className="text-zinc-400 font-medium mb-1">
            {requiredCount > 0
              ? t("trash.spec.detail.membersRequired", { count: members.length, required: requiredCount })
              : t("trash.spec.detail.members", { count: members.length })}
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-0.5 max-h-60 overflow-y-auto">
            {members.map((m) => (
              <div key={m.trash_id} className="flex items-center gap-2 min-w-0">
                <span className="font-mono text-[11px] text-zinc-500 shrink-0" title={m.trash_id}>{m.trash_id.slice(0, 10)}…</span>
                <span className="text-zinc-300 truncate">{m.name}</span>
                {m.required && <span className="text-sky-400 text-[10px] uppercase shrink-0">{t("trash.spec.detail.required")}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
      {includedProfiles.length > 0 && (
        <div>
          <p className="text-zinc-400 font-medium mb-1">{t("trash.spec.detail.autoIncluded", { count: includedProfiles.length })}</p>
          <div className="flex flex-wrap gap-1.5 max-h-40 overflow-y-auto">
            {includedProfiles.map(([label, trashId]) => (
              <span key={trashId} className="px-2 py-0.5 bg-zinc-800 rounded">
                <span className="text-zinc-300">{label}</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function QualitySizeDetail({ detail }: { detail: SpecDetail }) {
  const t = useT();
  const payload = detail.payload as {
    trash_id?: string;
    type?: string;
    qualities?: Array<{ quality: string; min: number; preferred?: number; max: number }>;
  };
  const rows = payload.qualities ?? [];
  return (
    <div className="space-y-3 text-xs text-zinc-300">
      <div className="grid grid-cols-2 gap-x-6 gap-y-1">
        <div><span className="text-zinc-500">trash_id:</span> <span className="font-mono">{payload.trash_id ?? "—"}</span></div>
        <div><span className="text-zinc-500">type:</span> {payload.type ?? "—"}</div>
      </div>
      <div>
        <p className="text-zinc-400 font-medium mb-1">{t("trash.spec.detail.perQualityLimits")}</p>
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="border-b border-zinc-800 text-left text-zinc-500">
                <th className="py-1 pr-3 font-semibold">{t("trash.spec.detail.quality")}</th>
                <th className="py-1 pr-3 font-semibold text-right">{t("trash.spec.detail.min")}</th>
                <th className="py-1 pr-3 font-semibold text-right">{t("trash.spec.detail.preferred")}</th>
                <th className="py-1 pr-3 font-semibold text-right">{t("trash.spec.detail.max")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((q) => (
                <tr key={q.quality} className="border-b border-zinc-800/50">
                  <td className="py-1 pr-3 text-zinc-200">{q.quality}</td>
                  <td className="py-1 pr-3 text-right font-mono">{q.min}</td>
                  <td className="py-1 pr-3 text-right font-mono">{q.preferred ?? "—"}</td>
                  <td className="py-1 pr-3 text-right font-mono">{q.max}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function readSpecValue(fields: unknown): unknown {
  if (Array.isArray(fields)) {
    return (fields as Array<{ name?: string; value?: unknown }>)
      .find((f) => f.name === "value")?.value;
  }
  if (fields && typeof fields === "object") {
    return (fields as Record<string, unknown>).value;
  }
  return undefined;
}

function CustomFormatDetail({ detail }: { detail: SpecDetail }) {
  const t = useT();
  const payload = detail.payload as {
    trash_id?: string;
    trash_scores?: Record<string, number>;
    includeCustomFormatWhenRenaming?: boolean;
    specifications?: Array<{ name?: string; implementation?: string; negate?: boolean; required?: boolean; fields?: Array<{ name?: string; value?: unknown }> | Record<string, unknown> }>;
  };
  const scores = payload.trash_scores ?? {};
  const specs = payload.specifications ?? [];
  return (
    <div className="space-y-3 text-xs text-zinc-300">
      <div className="grid grid-cols-2 gap-x-6 gap-y-1">
        <div><span className="text-zinc-500">trash_id:</span> <span className="font-mono">{payload.trash_id}</span></div>
        <div><span className="text-zinc-500">includeCustomFormatWhenRenaming:</span> {String(payload.includeCustomFormatWhenRenaming ?? false)}</div>
        <div><span className="text-zinc-500">{t("trash.spec.detail.upstreamPath")}</span> <span className="font-mono">{detail.upstreamPath}</span></div>
        <div><span className="text-zinc-500">sha:</span> <span className="font-mono">{detail.upstreamSha?.slice(0, 12) ?? "—"}</span></div>
      </div>

      {Object.keys(scores).length > 0 && (
        <div>
          <p className="text-zinc-400 font-medium mb-1">{t("trash.spec.detail.trashScores")}</p>
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(scores).map(([set, score]) => (
              <span key={set} className="px-2 py-0.5 bg-zinc-800 rounded">
                <span className="text-zinc-500">{set}:</span> <span className="font-mono">{score > 0 ? "+" : ""}{score}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {specs.length > 0 && (
        <div>
          <p className="text-zinc-400 font-medium mb-1">{t("trash.spec.detail.specifications", { count: specs.length })}</p>
          <div className="space-y-1">
            {specs.map((s, i) => {
              const value = readSpecValue(s.fields);
              return (
                <div key={i} className="flex items-center gap-2 py-0.5">
                  <span className="font-medium text-zinc-200 min-w-0 truncate">{s.name}</span>
                  <span className="text-zinc-500">({s.implementation})</span>
                  {s.negate && <span className="text-amber-400 text-[10px] uppercase">{t("trash.spec.detail.negated")}</span>}
                  {s.required && <span className="text-sky-400 text-[10px] uppercase">{t("trash.spec.detail.required")}</span>}
                  {value != null && (
                    <span className="font-mono text-zinc-400 truncate text-[11px]">{String(value).slice(0, 60)}</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function QualityProfileDetail({ detail }: { detail: SpecDetail }) {
  const t = useT();
  const payload = detail.payload as {
    upgradeAllowed?: boolean;
    cutoff?: string;
    cutoffFormatScore?: number;
    minFormatScore?: number;
    minUpgradeFormatScore?: number;
    score_set?: string;
    language?: string;
    items?: Array<{ name?: string; allowed?: boolean; items?: string[] }>;
    formatItems?: Record<string, string>;
  };
  const items = payload.items ?? [];
  const allowedItems = items.filter((q) => q.allowed);
  const formatItems = Object.entries(payload.formatItems ?? {});

  return (
    <div className="space-y-3 text-xs text-zinc-300">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-1">
        <div><span className="text-zinc-500">{t("trash.spec.detail.upgradeAllowed")}</span> {String(payload.upgradeAllowed ?? true)}</div>
        <div><span className="text-zinc-500">{t("trash.spec.detail.cutoff")}</span> {payload.cutoff ?? "—"}</div>
        <div><span className="text-zinc-500">{t("trash.spec.detail.cutoffFormatScore")}</span> {payload.cutoffFormatScore ?? 0}</div>
        <div><span className="text-zinc-500">{t("trash.spec.detail.minFormatScore")}</span> {payload.minFormatScore ?? 0}</div>
        {payload.minUpgradeFormatScore != null && (
          <div><span className="text-zinc-500">{t("trash.spec.detail.minUpgradeScore")}</span> {payload.minUpgradeFormatScore}</div>
        )}
        <div><span className="text-zinc-500">{t("trash.spec.detail.scoreSet")}</span> {payload.score_set ?? "default"}</div>
        <div><span className="text-zinc-500">{t("trash.spec.detail.language")}</span> {payload.language ?? "Original"}</div>
      </div>

      {allowedItems.length > 0 && (
        <div>
          <p className="text-zinc-400 font-medium mb-1">{t("trash.spec.detail.allowedQualities", { allowed: allowedItems.length, total: items.length })}</p>
          <div className="flex flex-wrap gap-1.5">
            {allowedItems.map((q, i) => (
              <span key={i} className="px-2 py-0.5 bg-zinc-800 rounded">
                {q.items?.length ? (
                  <>
                    <span className="font-medium">{q.name}</span>
                    <span className="text-zinc-500"> ({q.items.join(", ")})</span>
                  </>
                ) : (
                  <span>{q.name}</span>
                )}
              </span>
            ))}
          </div>
        </div>
      )}

      {formatItems.length > 0 && (
        <div>
          <p className="text-zinc-400 font-medium mb-1">{t("trash.spec.detail.referencedFormats", { count: formatItems.length })}</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-0.5 max-h-60 overflow-y-auto">
            {formatItems.map(([label, trashId]) => (
              <div key={trashId} className="flex items-center gap-2 min-w-0">
                <span className="font-mono text-[11px] text-zinc-500 shrink-0" title={trashId}>{trashId.slice(0, 10)}…</span>
                <span className="text-zinc-300 truncate">{label}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function NamingDetail({ detail }: { detail: SpecDetail }) {
  const t = useT();
  const payload = detail.payload as Record<string, unknown>;
  const entries = Object.entries(payload).filter(([k]) => k !== "name");
  return (
    <div className="space-y-2 text-xs">
      <div className="text-zinc-500">{t("trash.spec.detail.upstream")} <span className="font-mono text-zinc-400">{detail.upstreamPath}</span></div>
      <table className="w-full">
        <tbody>
          {entries.map(([key, value]) => (
            <tr key={key} className="align-top">
              <td className="py-1 pr-3 text-zinc-400 font-medium whitespace-nowrap">{key}</td>
              <td className="py-1 font-mono text-zinc-300 break-all">{typeof value === "string" ? value : JSON.stringify(value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
