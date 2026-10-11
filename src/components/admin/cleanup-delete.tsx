"use client";

// The ONE delete flow both Library cleanup and the Never-watched report use:
// a dry run through POST /api/admin/cleanup/delete, then an execute that echoes
// the dry run's target count (guardrail 14b). The route re-judges every title
// live, so a selection made on either page is deleted only if it is still a
// candidate. Keeping this in one place is what stops the two pages' confirm
// steps drifting apart.

import { useCallback, useState } from "react";
import { withBasePath } from "@/lib/base-path";
import { useT } from "@/components/i18n/i18n-provider";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { SectionHeader } from "@/components/ui/design";
import { Loader2, Trash2 } from "@/components/icons";

export type CleanupItem = { tmdbId: number; mediaType: "MOVIE" | "TV" };

export type CleanupPlan = {
  targetCount: number;
  reclaimableBytes: number;
  items: Array<{ tmdbId: number; mediaType: "MOVIE" | "TV"; title: string; targets: Array<{ service: string; instance: string; title: string; sizeOnDisk: number }> }>;
  skipped: Array<{ tmdbId: number; mediaType: string; title: string | null; reason: string }>;
};

export type CleanupExecResult = {
  deletedCount: number;
  partialCount: number;
  failedCount: number;
  results: Array<{ tmdbId: number; mediaType: string; title: string; status: "deleted" | "partial" | "failed"; deleted: string[]; failed: Array<{ target: string; error: string }> }>;
};

export const cleanupKeyOf = (r: { tmdbId: number; mediaType: string }) => `${r.mediaType}:${r.tmdbId}`;

export const arrInstanceLabel = (service: string, instance: string) =>
  `${service === "radarr" ? "Radarr" : "Sonarr"}${instance ? ` (${instance})` : ""}`;

// Server-supplied ISO timestamp → the viewer's locale. UTC so the day the
// server recorded is the day shown (no local-midnight shift). `new Date(iso)`
// parses a fixed string — not a clock read (guardrail 16).
export function dayFormatter(locale: string) {
  const fmt = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" });
  return (iso: string | null) => (iso ? fmt.format(new Date(iso)) : "—");
}

// Binary units, locale digits/separators ("92,1 GB" for a German admin).
export function formatBytesIn(n: number | null, locale: string): string {
  if (n === null) return "—";
  if (n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const value = new Intl.NumberFormat(locale, { maximumFractionDigits: i >= 3 ? 1 : 0 }).format(n / 1024 ** i);
  return `${value} ${units[i]}`;
}

export async function readApiError(res: Response, fallback: string): Promise<string> {
  const d = (await res.json().catch(() => null)) as { error?: string } | null;
  return d?.error ?? fallback;
}

export function useCleanupDelete(opts: {
  items: () => CleanupItem[];
  onDeleted: () => Promise<void> | void;
}) {
  const t = useT();
  const { items, onDeleted } = opts;
  const [plan, setPlan] = useState<CleanupPlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [blacklist, setBlacklist] = useState(true);
  const [result, setResult] = useState<CleanupExecResult | null>(null);
  const [error, setError] = useState("");

  const dryRun = useCallback(async () => {
    const body = items();
    if (body.length === 0) return;
    setPlanning(true);
    setError("");
    setResult(null);
    try {
      const res = await fetch(withBasePath("/api/admin/cleanup/delete"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: body, blacklist }),
      });
      if (!res.ok) {
        setError(await readApiError(res, t("adminManage.cleanup.error.dryRun")));
        return;
      }
      setPlan((await res.json()) as CleanupPlan);
    } catch {
      setError(t("adminManage.cleanup.error.dryRunNetwork"));
    } finally {
      setPlanning(false);
    }
  }, [items, blacklist, t]);

  const execute = useCallback(async () => {
    if (!plan) return;
    setExecuting(true);
    setError("");
    try {
      const res = await fetch(withBasePath("/api/admin/cleanup/delete?execute=true"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: items(), blacklist, confirmTargets: plan.targetCount }),
      });
      if (res.status === 409) {
        // Something changed since the dry run — show the fresh plan instead.
        const fresh = (await res.json().catch(() => null)) as (CleanupPlan & { error?: string }) | null;
        setError(t("adminManage.cleanup.error.changed"));
        // The 409 body carries the fresh targets but no total, so the heading's
        // size is recomputed from them — a title that dropped out of the plan
        // must drop out of the number the admin confirms against too.
        if (fresh?.items) {
          const reclaimableBytes = fresh.items.reduce((n, it) => n + it.targets.reduce((m, tg) => m + tg.sizeOnDisk, 0), 0);
          setPlan({ targetCount: fresh.targetCount, reclaimableBytes, items: fresh.items, skipped: fresh.skipped ?? [] });
        }
        return;
      }
      if (!res.ok) {
        setError(await readApiError(res, t("adminManage.cleanup.error.delete")));
        return;
      }
      setResult((await res.json()) as CleanupExecResult);
      setPlan(null);
      await onDeleted();
    } catch {
      setError(t("adminManage.cleanup.error.deleteNetwork"));
    } finally {
      setExecuting(false);
    }
  }, [plan, items, blacklist, onDeleted, t]);

  return {
    plan,
    clearPlan: () => setPlan(null),
    planning,
    executing,
    blacklist,
    setBlacklist,
    result,
    error,
    setError,
    dryRun,
    execute,
  };
}

export type CleanupDeleteState = ReturnType<typeof useCleanupDelete>;

export function CleanupPlanPanel({ del, formatBytes }: { del: CleanupDeleteState; formatBytes: (n: number | null) => string }) {
  const t = useT();
  const plan = del.plan;
  if (!plan) return null;
  return (
    <section className="flex flex-col gap-3 rounded-md bg-red-500/10" style={{ padding: 16, border: "1px solid var(--ds-border)" }} aria-labelledby="cleanup-plan">
      <div id="cleanup-plan" className="-mb-3">
        <SectionHeader
          title={
            <span className="text-red-400">
              {t("adminManage.cleanup.plan.title", {
                deletions: t("adminManage.cleanup.plan.deletions", { count: plan.targetCount }),
                titles: t("adminManage.cleanup.plan.titles", { count: plan.items.length }),
                size: formatBytes(plan.reclaimableBytes),
              })}
            </span>
          }
        />
      </div>
      <p style={{ fontSize: 12, color: "var(--ds-fg)", margin: 0 }}>
        {t("adminManage.cleanup.plan.warning")}
      </p>
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: "var(--ds-fg)" }}>
        {plan.items.map((it) => (
          <li key={cleanupKeyOf(it)}>
            {it.title} — {it.targets.map((tg) => `${arrInstanceLabel(tg.service, tg.instance)} (${formatBytes(tg.sizeOnDisk)})`).join(", ")}
          </li>
        ))}
      </ul>
      {plan.skipped.length > 0 && (
        <div style={{ fontSize: 12, color: "var(--ds-fg-subtle)" }}>
          {t("adminManage.cleanup.plan.skipped")}
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {plan.skipped.map((s) => <li key={cleanupKeyOf(s)}>{s.title ?? `${s.mediaType} ${s.tmdbId}`} — {s.reason}</li>)}
          </ul>
        </div>
      )}
      <label className="flex items-center gap-2" style={{ fontSize: 13, color: "var(--ds-fg)" }}>
        <Switch checked={del.blacklist} onCheckedChange={del.setBlacklist} aria-label={t("adminManage.cleanup.plan.blacklistAria")} />
        {t("adminManage.cleanup.plan.blacklist")}
      </label>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => void del.execute()}
          disabled={del.executing || plan.targetCount === 0}
          className="ds-hover-tint inline-flex items-center gap-1.5 rounded-md"
          style={{
            padding: "6px 12px",
            fontSize: 13,
            fontWeight: 600,
            background: "var(--ds-danger)",
            color: "var(--ds-on-status)",
            opacity: del.executing || plan.targetCount === 0 ? 0.6 : 1,
          }}
        >
          {del.executing ? <Loader2 className="animate-spin" style={{ width: 14, height: 14 }} /> : <Trash2 style={{ width: 14, height: 14 }} />}
          {t("adminManage.cleanup.plan.deleteNow", { count: plan.targetCount })}
        </button>
        <Button size="sm" variant="outline" onClick={del.clearPlan} disabled={del.executing}>{t("adminManage.common.cancel")}</Button>
      </div>
    </section>
  );
}

export function CleanupResultPanel({ result }: { result: CleanupExecResult | null }) {
  const t = useT();
  if (!result) return null;
  return (
    <section
      className="flex flex-col gap-2"
      style={{ padding: 16, borderRadius: 10, border: "1px solid var(--ds-border)", background: "var(--ds-bg-1)" }}
      aria-labelledby="cleanup-result"
    >
      <div id="cleanup-result" className="-mb-3">
        <SectionHeader
          title={
            <>
              {t("adminManage.cleanup.result.deleted", { count: result.deletedCount })}
              {result.partialCount > 0 ? t("adminManage.cleanup.result.partial", { count: result.partialCount }) : ""}
              {result.failedCount > 0 ? t("adminManage.cleanup.result.failed", { count: result.failedCount }) : ""}
            </>
          }
        />
      </div>
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: "var(--ds-fg)" }}>
        {result.results.map((r) => (
          <li key={cleanupKeyOf(r)}>
            <span className={r.status === "deleted" ? "text-green-400" : "text-red-400"}>{t(`adminManage.cleanup.status.${r.status}`)}</span> — {r.title}
            {r.failed.length > 0 ? ` ${t("adminManage.cleanup.result.failedOn", { list: r.failed.map((f) => `${f.target}: ${f.error}`).join("; ") })}` : ""}
          </li>
        ))}
      </ul>
    </section>
  );
}
