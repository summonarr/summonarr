"use client";

// The title manager's "Remove from Radarr/Sonarr": one title off ONE instance
// (POST /api/admin/arr/title/remove). The arr's own two choices — delete the
// files, and exclude it from import lists — nothing pre-selected; a dry run
// first (what goes, and whether an APPROVED request would make the sync put it
// straight back), then the remove, echoing the id the dry run named.

import { useMemo, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { AlertTriangle, Loader2, Trash2 } from "@/components/icons";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import { queueFormatters } from "@/components/admin/queue-format";
import type { ArrTitle } from "@/lib/arr-title";
import { arrApi, SERVICE_LABEL, type TitleRef } from "./shared";

interface Plan {
  title: ArrTitle;
  requests: { pending: number; approved: number; available: number };
}

export function RemovePanel({ titleRef, instanceLabel, onRemoved }: { titleRef: TitleRef; instanceLabel: string; onRemoved: () => void }) {
  const t = useT();
  const locale = useLocale();
  const fmt = useMemo(() => queueFormatters(locale), [locale]);
  const [open, setOpen] = useState(false);
  const [deleteFiles, setDeleteFiles] = useState(false);
  const [exclude, setExclude] = useState(false);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState<"plan" | "remove" | null>(null);
  const [error, setError] = useState("");
  const service = SERVICE_LABEL[titleRef.service];
  const base = { service: titleRef.service, instance: titleRef.instance, id: titleRef.arrId, deleteFiles, addImportExclusion: exclude };

  async function loadPlan() {
    setOpen(true);
    setBusy("plan");
    setError("");
    const res = await arrApi<Plan>("/api/admin/arr/title/remove", { method: "POST", body: base }, t("adminArr.remove.failed"));
    setBusy(null);
    if (res.ok) setPlan(res.data);
    else setError(res.error);
  }

  async function remove() {
    setBusy("remove");
    setError("");
    const res = await arrApi<{ removed: true }>(
      "/api/admin/arr/title/remove",
      { method: "POST", body: { ...base, execute: true, confirm: titleRef.arrId } },
      t("adminArr.remove.failed"),
    );
    setBusy(null);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    onRemoved();
  }

  if (!open) {
    return (
      <div className="flex flex-wrap items-center gap-3 border-t pt-4" style={{ borderColor: "var(--ds-border)" }}>
        <span className="min-w-0 flex-1 text-xs text-zinc-500">{t("adminArr.remove.hint", { name: instanceLabel })}</span>
        <Button variant="outline" size="sm" onClick={() => void loadPlan()}>
          <Trash2 /> {t("adminArr.remove.button", { name: instanceLabel })}
        </Button>
      </div>
    );
  }

  const blocked = (plan?.requests.approved ?? 0) > 0;
  return (
    <div
      role="alertdialog"
      aria-label={t("adminArr.remove.button", { name: instanceLabel })}
      className="grid gap-3 rounded-lg p-3"
      style={{ background: "color-mix(in oklab, var(--ds-danger) 8%, transparent)", border: "1px solid var(--ds-danger)" }}
    >
      <div className="text-sm font-medium text-zinc-100">{t("adminArr.remove.title", { name: instanceLabel })}</div>
      {busy === "plan" ? (
        <div className="flex items-center gap-2 text-xs text-zinc-500"><Loader2 className="h-4 w-4 animate-spin" /> {t("adminArr.common.loading")}</div>
      ) : plan ? (
        <p className="m-0 text-xs text-zinc-400">
          {t("adminArr.remove.summary", { title: plan.title.title, size: fmt.size(plan.title.sizeOnDisk) })}
          {plan.requests.available > 0 && <> {t("adminArr.remove.available", { count: plan.requests.available })}</>}
        </p>
      ) : null}
      <label className="flex items-start gap-2 text-sm text-zinc-300">
        <input type="checkbox" checked={deleteFiles} onChange={(e) => setDeleteFiles(e.target.checked)} className="mt-0.5 accent-[var(--ds-accent)]" />
        <span>
          {t("adminArr.remove.deleteFiles")}
          <span className="block text-xs text-zinc-500">{deleteFiles ? t("adminArr.remove.deleteFilesOn") : t("adminArr.remove.deleteFilesOff", { service })}</span>
        </span>
      </label>
      <label className="flex items-start gap-2 text-sm text-zinc-300">
        <input type="checkbox" checked={exclude} onChange={(e) => setExclude(e.target.checked)} className="mt-0.5 accent-[var(--ds-accent)]" />
        <span>
          {t("adminArr.remove.exclude")}
          <span className="block text-xs text-zinc-500">{t("adminArr.remove.excludeHint", { service })}</span>
        </span>
      </label>
      {blocked && plan && (
        <p role="alert" className="m-0 flex items-start gap-1.5 text-xs text-amber-400">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            {t("adminArr.remove.blocked", { count: plan.requests.approved, service })}{" "}
            <Link href="/admin" className="underline">{t("adminArr.remove.openRequests")}</Link>
          </span>
        </p>
      )}
      {error && (
        <p role="alert" className="m-0 flex items-center gap-1.5 text-xs" style={{ color: "var(--ds-danger)" }}>
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {error}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={() => { setOpen(false); setPlan(null); setError(""); }} disabled={busy === "remove"}>
          {t("adminArr.common.cancel")}
        </Button>
        <Button
          size="sm"
          className="bg-red-600 text-[var(--ds-on-status)] hover:bg-[var(--ds-danger-hover)]"
          onClick={() => void remove()}
          disabled={busy !== null || !plan || blocked}
        >
          {busy === "remove" ? <Loader2 className="animate-spin" /> : <Trash2 />}
          {deleteFiles ? t("adminArr.remove.confirmWithFiles") : t("adminArr.remove.confirm")}
        </Button>
      </div>
    </div>
  );
}
