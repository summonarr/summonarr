"use client";

// Admin → Arr System → Storage: per instance, the root folders (free space,
// reachable, folders the arr has no title for) and the disks.

import { useMemo, useState } from "react";
import { Chip } from "@/components/ui/design";
import { queueFormatters } from "@/components/admin/queue-format";
import { ChevronDown, ChevronRight, HardDrive } from "@/components/icons";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import type { ArrDisk, ArrRootFolder } from "@/lib/arr-system";
import { STORAGE_REPORT, type StorageResult } from "@/lib/client/arr-answers";
import { Card, InstanceErrors, labelOf, Loading, Toolbar, useReport } from "./arr-system-parts";
import { cardKey } from "./arr-system-state";

function UsageBar({ free, total }: { free: number | null; total: number | null }) {
  if (free === null || total === null || total <= 0) return null;
  const used = Math.max(0, Math.min(1, (total - free) / total));
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full" style={{ background: "var(--ds-bg-3)" }} aria-hidden>
      <div className="h-full rounded-full" style={{ width: `${used * 100}%`, background: used > 0.9 ? "var(--ds-danger)" : used > 0.75 ? "var(--ds-warning)" : "var(--ds-accent)" }} />
    </div>
  );
}

/** Disk-sized amounts: terabytes once past 1 TB ("8 TB", not "8,000GB"). */
function storageSize(locale: string) {
  const tb = new Intl.NumberFormat(locale, { style: "unit", unit: "terabyte", unitDisplay: "narrow", maximumFractionDigits: 1 });
  const small = queueFormatters(locale).size;
  return (bytes: number) => (bytes >= 1e12 ? tb.format(bytes / 1e12) : small(bytes));
}

type Size = (bytes: number) => string;

export function StorageTab() {
  const t = useT();
  const locale = useLocale();
  const size = useMemo(() => storageSize(locale), [locale]);
  const { report, loading, error, load, staleAt } = useReport<StorageResult>("/api/admin/arr/storage", STORAGE_REPORT, t("adminArr.system.loadFailed"), null);
  // The root folders whose unmapped folders are listed open.
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (k: string) => setOpen((s) => {
    const next = new Set(s);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    return next;
  });

  if (!report) return <Loading error={error} loading={loading} onRetry={() => void load()} />;
  return (
    <div className="grid gap-4">
      <Toolbar loading={loading} onReload={() => void load()} error={error} staleAt={staleAt} />
      <InstanceErrors report={report} />
      {report.results.map((r) => {
        const card = cardKey(r.service, r.instance);
        return (
          <Card key={card} title={labelOf(report, r.service, r.instance)}>
            <div className="grid gap-2">
              <h3 className="m-0 text-xs font-semibold uppercase tracking-wide text-zinc-500">{t("adminArr.system.rootFolders")}</h3>
              {r.rootFolders.length === 0 ? (
                <p className="m-0 text-xs text-zinc-500">{t("adminArr.system.noRootFolders")}</p>
              ) : (
                <ul className="m-0 grid list-none gap-0 rounded-lg p-0" style={{ border: "1px solid var(--ds-border)" }}>
                  {r.rootFolders.map((f, i) => {
                    const k = `${card}:${f.id}`;
                    return <RootFolderRow key={f.id} folder={f} first={i === 0} expanded={open.has(k)} onToggle={() => toggle(k)} size={size} />;
                  })}
                </ul>
              )}
              {r.rootFolders.some((f) => f.unmappedCount > 0) && <p className="m-0 text-xs text-zinc-500">{t("adminArr.system.unmappedHint")}</p>}
            </div>
            <div className="grid gap-2">
              <h3 className="m-0 text-xs font-semibold uppercase tracking-wide text-zinc-500">{t("adminArr.system.disks")}</h3>
              {r.disks.length === 0 ? (
                <p className="m-0 text-xs text-zinc-500">{t("adminArr.system.noDisks")}</p>
              ) : (
                <ul className="m-0 grid list-none gap-2 p-0 sm:grid-cols-2">
                  {r.disks.map((d) => <DiskItem key={d.path} disk={d} size={size} />)}
                </ul>
              )}
            </div>
          </Card>
        );
      })}
    </div>
  );
}

/** A root folder: its space, whether the arr can reach it, and the folders in it the arr has no title for. */
function RootFolderRow({ folder: f, first, expanded, onToggle, size }: { folder: ArrRootFolder; first: boolean; expanded: boolean; onToggle: () => void; size: Size }) {
  const t = useT();
  return (
    <li className="grid gap-1.5 px-3 py-2" style={!first ? { borderTop: "1px solid var(--ds-border)" } : undefined}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="break-all text-sm text-zinc-100">{f.path}</span>
        {!f.accessible && <Chip tone="declined">{t("adminArr.system.unreachable")}</Chip>}
        <span className="flex-1" />
        {f.freeSpace !== null && (
          <span className="text-xs text-zinc-400">
            {f.totalSpace !== null
              ? t("adminArr.system.freeOf", { free: size(f.freeSpace), total: size(f.totalSpace) })
              : t("adminArr.system.free", { size: size(f.freeSpace) })}
          </span>
        )}
      </div>
      <UsageBar free={f.freeSpace} total={f.totalSpace} />
      {f.unmappedCount > 0 && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={onToggle}
          className="flex items-center gap-1 justify-self-start text-xs text-amber-400 hover:underline"
        >
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          {t("adminArr.system.unmapped", { count: f.unmappedCount })}
        </button>
      )}
      {expanded && (
        <ul className="m-0 grid list-none gap-0.5 p-0 pl-5 text-xs text-zinc-400">
          {f.unmappedFolders.map((u) => <li key={u.path || u.name} className="break-all" title={u.path}>{u.name}</li>)}
          {f.unmappedCount > f.unmappedFolders.length && (
            <li className="text-zinc-500">{t("adminArr.system.andMore", { count: f.unmappedCount - f.unmappedFolders.length })}</li>
          )}
        </ul>
      )}
    </li>
  );
}

function DiskItem({ disk: d, size }: { disk: ArrDisk; size: Size }) {
  const t = useT();
  return (
    <li className="grid gap-1.5 rounded-lg px-3 py-2" style={{ border: "1px solid var(--ds-border)" }}>
      <div className="flex flex-wrap items-center gap-2">
        <HardDrive className="h-4 w-4 text-zinc-500" aria-hidden />
        <span className="break-all text-sm text-zinc-100">{d.path}</span>
        {d.label && d.label !== d.path && <span className="text-xs text-zinc-500">{d.label}</span>}
      </div>
      <UsageBar free={d.freeSpace} total={d.totalSpace} />
      {d.freeSpace !== null && d.totalSpace !== null && (
        <span className="text-xs text-zinc-400">{t("adminArr.system.freeOf", { free: size(d.freeSpace), total: size(d.totalSpace) })}</span>
      )}
    </li>
  );
}
