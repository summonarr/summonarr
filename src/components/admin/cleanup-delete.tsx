"use client";

// The ONE delete flow both Library cleanup and the Never-watched report use:
// a dry run through POST /api/admin/cleanup/delete, then an execute that echoes
// the dry run's target count (guardrail 14b). The route re-judges every title
// live, so a selection made on either page is deleted only if it is still a
// candidate. Keeping this in one place is what stops the two pages' confirm
// steps drifting apart.
//
// What the admin confirmed is what is sent: the execute carries the PLAN's own
// titles and its target-set fingerprint (`cleanupExecuteBody`), never the live
// selection, and a dry-run (or a 409's fresh plan) answering for a selection
// that has since changed is dropped — the plan on screen is the one confirmed.
//
// An execute the browser got no answer to from the ROUTE — a proxy's 502/504
// after ~60 s while the deletes run on, a dropped connection — is outcome
// unknown, never "the delete failed": the plan is dropped and the page reloads,
// so "Delete N now" can't start a second run over titles the first may already
// have removed (cleanupExecuteFailure).

import { useCallback, useEffect, useRef, useState } from "react";
import { withBasePath } from "@/lib/base-path";
import { arrTitleDiffers, cleanupExecuteBody } from "@/lib/cleanup-delete-plan";
import { arrFailureText } from "@/lib/cleanup-error-text";
import { NOT_JSON, planFromAnswer, readExecuteAnswer, type CleanupExecResult, type CleanupPlan, type ExecuteAnswer } from "@/lib/cleanup-plan-answer";
import { fetchJson, jsonInit } from "@/lib/client/fetch-json";
import { useT } from "@/components/i18n/i18n-provider";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { SectionHeader } from "@/components/ui/design";
import { Loader2, Trash2 } from "@/components/icons";

export type { CleanupExecResult, CleanupPlan } from "@/lib/cleanup-plan-answer";

export type CleanupItem = { tmdbId: number; mediaType: "MOVIE" | "TV" };

export const cleanupKeyOf = (r: { tmdbId: number; mediaType: string }) => `${r.mediaType}:${r.tmdbId}`;

// "Radarr (anime)": the service and the instance SLUG. Not open-in-arr's
// arrInstanceLabel, which names an instance by its display name.
export const arrSlugLabel = (service: string, instance: string) =>
  `${service === "radarr" ? "Radarr" : "Sonarr"}${instance ? ` (${instance})` : ""}`;

// Server-supplied ISO timestamp → the viewer's locale. UTC so the day the
// server recorded is the day shown (no local-midnight shift); no clock read
// (guardrail 16). The Missing page's formatter, which reads a value that isn't
// a date as a dash: Intl throws a RangeError on an Invalid Date, and one
// malformed date from Radarr/Sonarr took the whole cleanup table down with it.
export { utcDayFormatter as dayFormatter } from "@/components/admin/missing-format";

// Binary units, locale digits/separators ("92,1 GB" for a German admin).
export function formatBytesIn(n: number | null, locale: string): string {
  if (n === null) return "—";
  if (n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const value = new Intl.NumberFormat(locale, { maximumFractionDigits: i >= 3 ? 1 : 0 }).format(n / 1024 ** i);
  return `${value} ${units[i]}`;
}

// The execute, as one answer (cleanup-plan-answer.ts reads it). Its own request
// on purpose, not fetchJson: no client deadline (the route runs every delete
// before it answers), and "no answer at all" must stay apart from a gateway's
// page, which fetchJson folds into one kind.
async function sendExecute(plan: CleanupPlan, blacklist: boolean): Promise<ExecuteAnswer> {
  try {
    const res = await fetch(withBasePath("/api/admin/cleanup/delete?execute=true"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cleanupExecuteBody(plan, blacklist)),
    });
    return readExecuteAnswer(res.status, await res.json().catch(() => NOT_JSON));
  } catch {
    // No answer at all: the same unknown outcome as a gateway's.
    return { kind: "unknown", messageKey: "adminManage.cleanup.error.deleteNetwork" };
  }
}

export function useCleanupDelete(opts: {
  items: () => CleanupItem[];
  onDeleted: () => Promise<void> | void;
}) {
  const t = useT();
  // Both callers pass fresh closures every render. Read through refs (updated
  // after each commit, never during render) behind stable wrappers, so the
  // callbacks below keep their identity instead of being rebuilt every render.
  const itemsRef = useRef(opts.items);
  const onDeletedRef = useRef(opts.onDeleted);
  useEffect(() => {
    itemsRef.current = opts.items;
    onDeletedRef.current = opts.onDeleted;
  });
  const items = useCallback(() => itemsRef.current(), []);
  const onDeleted = useCallback(() => onDeletedRef.current(), []);
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

  // The page reloads its own state (and the selection with it). A failed
  // reload reports itself on the page; it never makes the delete look failed.
  const reloadAfter = useCallback(async () => {
    try {
      await onDeleted();
    } catch {
      // The reload reports its own failure.
    }
  }, [onDeleted]);

  const dryRun = useCallback(async () => {
    const body = items();
    if (body.length === 0) return;
    const gen = ++planGen.current;
    setPlanning(true);
    setError("");
    setResult(null);
    const res = await fetchJson(withBasePath("/api/admin/cleanup/delete"), {
      init: jsonInit("POST", { items: body, blacklist }),
      // The route lists every Radarr/Sonarr instance live before it answers.
      timeoutMs: Infinity,
      fallbackError: t("adminManage.cleanup.error.dryRun"),
    });
    setPlanning(false);
    // An answer for a selection the admin has since changed is dropped whole.
    if (gen !== planGen.current) return;
    if (!res.ok) {
      setError(res.kind === "http" ? res.error : t("adminManage.cleanup.error.dryRunNetwork"));
      return;
    }
    const next = planFromAnswer(res.data);
    if (!next) {
      setError(t("adminManage.cleanup.error.dryRunNetwork"));
      return;
    }
    setPlan(next);
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
    // Only the request is in this await: what the answer then sets off (a
    // reload, the 409's plan) can never be read as the delete's own failure.
    const answer = await sendExecute(plan, blacklist);
    try {
      if (answer.kind === "conflict") {
        // Something changed since the dry run — show the fresh plan instead.
        // Not when the selection changed meanwhile: that cleared the plan, and
        // this one answers for the old selection.
        setError(t("adminManage.cleanup.error.changed"));
        if (answer.plan && gen === planGen.current) setPlan(answer.plan);
      } else if (answer.kind === "refused") {
        // The route's own refusal, answered before any delete: the plan stands.
        setError(answer.error);
      } else if (answer.kind === "unknown") {
        // A proxy's 502/504 (or a body that isn't the route's): the route may
        // still be deleting. Never offer "Delete N now" again over titles that
        // may be gone — the next delete starts from a fresh dry run.
        await settleUnknownOutcome(t(answer.messageKey));
      } else {
        setResult(answer.result);
        setPlan(null);
        await reloadAfter();
      }
    } finally {
      setExecuting(false);
    }
  }, [plan, blacklist, reloadAfter, settleUnknownOutcome, t]);

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
              const instance = arrSlugLabel(tg.service, tg.instance);
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
                list: r.failed.map((f) => arrFailureText(t, f.service ? arrSlugLabel(f.service, f.instance ?? "") : f.target, f)).join("; "),
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
