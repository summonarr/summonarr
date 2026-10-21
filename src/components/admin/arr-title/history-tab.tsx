"use client";

// The title manager's History tab: every grab, import, failure, deletion and
// rename Radarr/Sonarr recorded for the title (GET /api/admin/arr/title/history),
// with "Mark as failed" on a grab, and a link to the title's downloads in the
// Download Queue (filtered to exactly this title on this instance). Following
// that link leaves the manager — through the manager's own close rules.
//
// "Instant, then live" (src/lib/arr-snapshot.ts): on open the history the
// server last read is painted while the live read is out — only over an EMPTY
// list; "Mark as failed" on a painted row is re-checked live by its route.

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { AlertTriangle, Download, Loader2, RefreshCw } from "@/components/icons";
import { useT } from "@/components/i18n/i18n-provider";
import { ArrHistoryList } from "@/components/admin/arr-history-list";
import { ArrSnapshotNote } from "@/components/admin/arr-snapshot-note";
import { useArrSnapshot } from "@/components/admin/use-arr-snapshot";
import { withBasePath } from "@/lib/base-path";
import { queueTitleHref } from "@/lib/arr-manage-links";
import { opensElsewhere } from "@/lib/arr-title-ui";
import type { ArrHistoryEvent } from "@/lib/arr-history";
import { arrApi, titleQuery, useTRef, type TitleRef } from "./shared";
import { snapshotMayPaint } from "./snapshot-rules";

export function HistoryTab({
  titleRef,
  onLeave,
}: {
  titleRef: TitleRef;
  /**
   * The queue link is being followed: the manager closes and answers true, or
   * answers false and stays open (unsaved Settings edits ask first, a save in
   * flight waits) — the navigation is then cancelled. The manager must close
   * itself: on the Download Queue, a link to the URL already open re-renders
   * nothing that would close it.
   */
  onLeave?: () => boolean;
}) {
  const t = useT();
  const tRef = useTRef();
  // null until the first read answers; a failed FIRST read is not "no history".
  const [events, setEvents] = useState<ArrHistoryEvent[] | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // The live read's URL — and its snapshot's (one builder: the server keys on it).
  const readPath = useMemo(() => `/api/admin/arr/title/history?${titleQuery(titleRef)}`, [titleRef]);
  const applySnapshot = useCallback((data: { events: ArrHistoryEvent[] }) => {
    if (!Array.isArray(data?.events)) return false;
    setEvents((prev) => (snapshotMayPaint(prev !== null, false) ? data.events : prev));
  }, []);
  const snap = useArrSnapshot<{ events: ArrHistoryEvent[] }>(withBasePath(readPath), applySnapshot);
  const markLive = snap.markLive;

  const load = useCallback(async () => {
    setLoading(true);
    const res = await arrApi<{ events: ArrHistoryEvent[] }>(readPath, undefined, tRef.current("adminArr.history.loadFailed"));
    setLoading(false);
    if (res.ok) {
      setEvents(res.data.events);
      setError("");
      markLive();
    } else {
      // A failed re-read keeps the list it had.
      setError(res.error);
    }
  }, [readPath, tRef, markLive]);

  useEffect(() => {
    void load();
  }, [load]);

  async function markFailed(e: ArrHistoryEvent): Promise<string | null> {
    const res = await arrApi<{ ok: true }>(
      "/api/admin/arr/history/failed",
      { method: "POST", body: { service: titleRef.service, instance: titleRef.instance, arrId: titleRef.arrId, historyId: e.id } },
      t("adminArr.history.markFailedError"),
    );
    if (!res.ok) return res.error;
    // The arr records the failure as it marks it: re-read now, never on a timer
    // that could outlive the manager.
    void load();
    return null;
  }

  if (events === null) {
    return error ? (
      <p role="alert" className="m-0 flex flex-wrap items-center gap-2 py-8 text-sm" style={{ color: "var(--ds-danger)" }}>
        <AlertTriangle className="h-4 w-4 shrink-0" /> {error}
        <Button variant="ghost" size="sm" disabled={loading} onClick={() => void load()}><RefreshCw /> {t("adminArr.common.retry")}</Button>
      </p>
    ) : (
      <div className="flex items-center gap-2 py-8 text-sm text-zinc-500"><Loader2 className="h-4 w-4 animate-spin" /> {t("adminArr.common.loading")}</div>
    );
  }
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {error && (
          <p role="alert" className="m-0 flex items-center gap-1.5 text-xs" style={{ color: "var(--ds-danger)" }}>
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {error}
          </p>
        )}
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          <Link
            href={queueTitleHref(titleRef)}
            onClick={(e) => {
              // A new tab or window leaves this page, and the manager, as they are.
              if (!onLeave || opensElsewhere(e)) return;
              if (!onLeave()) e.preventDefault();
            }}
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-[var(--ds-accent-text)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-accent-ring)]"
          >
            <Download className="h-3.5 w-3.5 shrink-0" aria-hidden /> {t("adminArr.history.queueLink")}
          </Link>
          <Button variant="ghost" size="sm" disabled={loading} onClick={() => void load()}>
            {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />} {t("adminArr.common.reload")}
          </Button>
        </div>
      </div>
      <ArrSnapshotNote at={snap.staleAt} refreshing={loading} />
      <ArrHistoryList events={events} showTitle={false} onMarkFailed={markFailed} />
    </div>
  );
}
