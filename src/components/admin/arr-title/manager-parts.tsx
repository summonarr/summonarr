"use client";

// The title manager's own pieces (title-manager.tsx holds the state): the
// header, the command bar, the status line, and the discard-changes banner.

import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/design";
import { AlertTriangle, Check, Download, Loader2, RefreshCw, Search } from "@/components/icons";
import { useT } from "@/components/i18n/i18n-provider";
import { OpenInArrLink } from "@/components/admin/open-in-arr";
import { CommandWatchLine, type CommandWatch } from "@/components/admin/arr-command-watch";
import { queueFormatters } from "@/components/admin/queue-format";
import type { ArrTitle } from "@/lib/arr-title";
import type { ArrServiceName } from "./shared";

// The arr's own status word, translated (a literal map — never a built key);
// an unknown word shows as the arr sent it.
const TITLE_STATUS_KEYS: Record<string, string> = {
  tba: "adminArr.titleStatus.tba",
  announced: "adminArr.availability.announced",
  inCinemas: "adminArr.status.inCinemas",
  released: "adminArr.availability.released",
  deleted: "adminArr.titleStatus.deleted",
  continuing: "adminArr.titleStatus.continuing",
  ended: "adminArr.titleStatus.ended",
  upcoming: "adminArr.status.upcoming",
};

/** Under the dialog's title: the instance, monitoring, what is on disk, and the arr's own facts. */
export function TitleChips({ title, instanceLabel, isSeries, fmt }: { title: ArrTitle; instanceLabel: string; isSeries: boolean; fmt: ReturnType<typeof queueFormatters> }) {
  const t = useT();
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-zinc-500">
      <Chip>{instanceLabel}</Chip>
      <Chip tone={title.monitored ? "accent" : "neutral"}>{title.monitored ? t("adminArr.status.monitored") : t("adminArr.status.unmonitored")}</Chip>
      {isSeries ? (
        <Chip tone={title.episodeCount > 0 && title.episodeFileCount >= title.episodeCount ? "approved" : "pending"}>
          {t("adminArr.seasons.files", { have: title.episodeFileCount, count: title.episodeCount })}
        </Chip>
      ) : (
        <Chip tone={title.hasFile ? "approved" : "declined"}>{title.hasFile ? t("adminArr.status.downloaded") : t("adminArr.status.missing")}</Chip>
      )}
      {title.status && <span>{TITLE_STATUS_KEYS[title.status] ? t(TITLE_STATUS_KEYS[title.status]) : title.status}</span>}
      {title.sizeOnDisk > 0 && <span>{fmt.size(title.sizeOnDisk)}</span>}
      {title.network && <span>{title.network}</span>}
      {title.studio && <span>{title.studio}</span>}
    </div>
  );
}

/** The title's commands: search (Sonarr: missing), pick a release (Radarr), refresh — and "Open in". */
export function CommandBar({ service, instance, arrId, instanceLabel, busy, onSearch, onPickRelease, onRefresh }: {
  service: ArrServiceName;
  instance: string;
  arrId: number;
  instanceLabel: string;
  /** The command whose POST is out, if any: every button waits. */
  busy: "search" | "refresh" | null;
  onSearch: () => void;
  onPickRelease: () => void;
  onRefresh: () => void;
}) {
  const t = useT();
  const isSeries = service === "sonarr";
  return (
    <div className="flex flex-wrap items-center gap-2">
      {isSeries ? (
        <Button size="sm" disabled={busy !== null} onClick={onSearch} title={t("adminArr.actions.searchMissingHint")}>
          {busy === "search" ? <Loader2 className="animate-spin" /> : <Search />} {t("adminArr.actions.searchMissing")}
        </Button>
      ) : (
        <>
          <Button size="sm" disabled={busy !== null} onClick={onSearch} title={t("adminArr.actions.searchHint")}>
            {busy === "search" ? <Loader2 className="animate-spin" /> : <Search />} {t("adminArr.actions.search")}
          </Button>
          <Button variant="outline" size="sm" disabled={busy !== null} onClick={onPickRelease}>
            <Download /> {t("adminArr.actions.interactive")}
          </Button>
        </>
      )}
      <Button variant="outline" size="sm" disabled={busy !== null} onClick={onRefresh} title={t("adminArr.actions.refreshHint")}>
        {busy === "refresh" ? <Loader2 className="animate-spin" /> : <RefreshCw />} {t("adminArr.actions.refresh")}
      </Button>
      <span className="flex-1" />
      <OpenInArrLink service={service} instance={instance} target={{ arrId }} label={t("adminManage.openIn", { name: instanceLabel })} />
    </div>
  );
}

/** One line under the commands: an error, else the followed command's progress, else the last notice. */
export function StatusLine({ error, watch, notice, partialNote }: { error: string; watch: CommandWatch | undefined; notice: string; partialNote: string }) {
  return (
    <>
      {error ? (
        <p role="alert" className="m-0 flex items-center gap-1.5 text-xs" style={{ color: "var(--ds-danger)" }}>
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {error}
        </p>
      ) : watch ? (
        <CommandWatchLine watch={watch} />
      ) : notice ? (
        <p role="status" className="m-0 flex items-center gap-1.5 text-xs text-green-400">
          <Check className="h-3.5 w-3.5 shrink-0" /> {notice}
        </p>
      ) : null}
      {partialNote && !error && (
        <p role="status" className="m-0 text-xs text-zinc-400">{partialNote}</p>
      )}
    </>
  );
}

/** "Discard your changes?" — closing with unsaved Settings edits asks first (an alertdialog: it takes focus). */
export function DiscardBanner({ saving, keepRef, onKeep, onDiscard }: {
  saving: boolean;
  keepRef: React.Ref<HTMLButtonElement>;
  onKeep: () => void;
  onDiscard: () => void;
}) {
  const t = useT();
  return (
    <div role="alertdialog" aria-label={t("adminArr.settings.discardTitle")} className="flex flex-wrap items-center gap-3 rounded-lg px-3 py-2.5 text-sm" style={{ background: "color-mix(in oklab, var(--ds-warning) 12%, transparent)", border: "1px solid var(--ds-warning)" }}>
      <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" />
      <span className="min-w-0 flex-1 text-zinc-100">{t("adminArr.settings.discardTitle")}</span>
      <Button ref={keepRef} variant="ghost" size="sm" onClick={onKeep}>{t("adminArr.settings.keepEditing")}</Button>
      <Button size="sm" disabled={saving} className="bg-red-600 text-[var(--ds-on-status)] hover:bg-[var(--ds-danger-hover)]" onClick={onDiscard}>
        {t("adminArr.settings.discard")}
      </Button>
    </div>
  );
}
