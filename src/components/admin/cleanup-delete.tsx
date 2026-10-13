"use client";

// The ONE delete flow both Library cleanup and the Never-watched report use:
// a dry run through POST /api/admin/cleanup/delete, then an execute that echoes
// the dry run's target count (guardrail 14b). The route re-judges every title
// live, so a selection made on either page is deleted only if it is still a
// candidate. Keeping this in one place is what stops the two pages' confirm
// steps drifting apart.
//
// What the admin confirmed is what is sent: the execute carries the PLAN's own
// titles (`cleanupExecuteBody`), never the live selection, and a dry-run (or a
// 409's fresh plan) answering for a selection that has since changed is dropped
// — the route checks only the target COUNT, so a same-sized different set would
// otherwise pass.
//
// An execute the browser got no answer to from the ROUTE — a proxy's 502/504
// after ~60 s while the deletes run on, a dropped connection — is outcome
// unknown, never "the delete failed": the plan is dropped and the page reloads,
// so "Delete N now" can't start a second run over titles the first may already
// have removed (cleanupExecuteFailure).

import { useCallback, useRef, useState } from "react";
import { withBasePath } from "@/lib/base-path";
import { arrTitleDiffers, cleanupExecuteBody } from "@/lib/cleanup-delete-plan";
import { arrFailureText } from "@/lib/cleanup-error-text";
import { cleanupExecuteFailure } from "@/lib/cleanup-execute-outcome";
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
  // `service`/`instance`/`kind` name and word a failure (arrFailureText);
  // `target` + `error` are the English fallback for a response without them.
  // `uncertain`: a delete got no answer (a timeout, a 502/504), so the arr may
  // have taken it anyway — its stamps were kept (guardrail 14b).
  results: Array<{ tmdbId: number; mediaType: string; title: string; status: "deleted" | "partial" | "failed"; deleted: string[]; failed: Array<{ target: string; error: string; service?: string; instance?: string; kind?: string }>; uncertain?: boolean }>;
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
  // Bumped by every selection change (clearPlan) and every dry run: an answer
  // whose generation is no longer current was computed for a selection the
  // admin has since changed, and is dropped instead of shown as the plan.
  const planGen = useRef(0);

  const clearPlan = useCallback(() => {
    planGen.current++;
    setPlan(null);
  }, []);

  const dryRun = useCallback(async () => {
    const body = items();
    if (body.length === 0) return;
    const gen = ++planGen.current;
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
        const msg = await readApiError(res, t("adminManage.cleanup.error.dryRun"));
        if (gen === planGen.current) setError(msg);
        return;
      }
      const next = (await res.json()) as CleanupPlan;
      if (gen === planGen.current) setPlan(next);
    } catch {
      if (gen === planGen.current) setError(t("adminManage.cleanup.error.dryRunNetwork"));
    } finally {
      setPlanning(false);
    }
  }, [items, blacklist, t]);

  // An execute whose outcome is unknown (cleanupExecuteFailure): drop the plan
  // (bumping its generation, so a late 409 plan can't come back either) and
  // reload the page's own state through onDeleted — the selection with it. The
  // message tells the admin some titles may already be gone.
  const settleUnknownOutcome = useCallback(async (message: string) => {
    clearPlan();
    setError(message);
    try {
      await onDeleted();
    } catch {
      // The reload reports its own failure; the message above still stands.
    }
  }, [clearPlan, onDeleted]);

  const execute = useCallback(async () => {
    if (!plan) return;
    const gen = planGen.current;
    setExecuting(true);
    setError("");
    try {
      const res = await fetch(withBasePath("/api/admin/cleanup/delete?execute=true"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cleanupExecuteBody(plan, blacklist)),
      });
      if (res.status === 409) {
        // Something changed since the dry run — show the fresh plan instead.
        const fresh = (await res.json().catch(() => null)) as (CleanupPlan & { error?: string }) | null;
        setError(t("adminManage.cleanup.error.changed"));
        // The 409 body carries the fresh targets but no total, so the heading's
        // size is recomputed from them — a title that dropped out of the plan
        // must drop out of the number the admin confirms against too. Not when
        // the selection changed meanwhile: that cleared the plan, and this one
        // answers for the old selection.
        if (fresh?.items && gen === planGen.current) {
          const reclaimableBytes = fresh.items.reduce((n, it) => n + it.targets.reduce((m, tg) => m + tg.sizeOnDisk, 0), 0);
          setPlan({ targetCount: fresh.targetCount, reclaimableBytes, items: fresh.items, skipped: fresh.skipped ?? [] });
        }
        return;
      }
      if (!res.ok) {
        const failure = cleanupExecuteFailure(res.status, await res.json().catch(() => null));
        if (failure.kind === "refused") {
          // The route's own refusal, answered before any delete: the plan stands.
          setError(failure.error);
          return;
        }
        // A proxy's 502/504 (or a body that isn't the route's): the route may
        // still be deleting. Never offer "Delete N now" again over titles that
        // may be gone — the next delete starts from a fresh dry run.
        await settleUnknownOutcome(t("adminManage.cleanup.error.deleteUnknown"));
        return;
      }
      setResult((await res.json()) as CleanupExecResult);
      setPlan(null);
      await onDeleted();
    } catch {
      // No answer at all (or an unreadable one): the same unknown outcome.
      await settleUnknownOutcome(t("adminManage.cleanup.error.deleteNetwork"));
    } finally {
      setExecuting(false);
    }
  }, [plan, blacklist, onDeleted, settleUnknownOutcome, t]);

  return {
    plan,
    clearPlan,
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
            {/* A target the instance holds under ANOTHER title (TMDB's TVDB
                cross-reference) is named, so the admin sees which entry — and
                whose files — the delete removes. */}
            {it.title} — {it.targets.map((tg) => {
              const instance = arrInstanceLabel(tg.service, tg.instance);
              const size = formatBytes(tg.sizeOnDisk);
              return arrTitleDiffers(it.title, tg.title)
                ? t("adminManage.cleanup.plan.targetAs", { instance, title: tg.title, size })
                : `${instance} (${size})`;
            }).join(", ")}
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
            {r.failed.length > 0
              ? ` ${t("adminManage.cleanup.result.failedReasons", {
                list: r.failed.map((f) => arrFailureText(t, f.service ? arrInstanceLabel(f.service, f.instance ?? "") : f.target, f)).join("; "),
              })}`
              : ""}
            {r.uncertain === true && (
              <span style={{ color: "var(--ds-fg-muted)" }}> {t("adminManage.cleanup.result.uncertain")}</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
