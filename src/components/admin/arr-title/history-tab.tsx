"use client";

// The title manager's History tab: every grab, import, failure, deletion and
// rename Radarr/Sonarr recorded for the title (GET /api/admin/arr/title/history),
// with "Mark as failed" on a grab.

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { AlertTriangle, Loader2, RefreshCw } from "@/components/icons";
import { useT } from "@/components/i18n/i18n-provider";
import { ArrHistoryList } from "@/components/admin/arr-history-list";
import type { ArrHistoryEvent } from "@/lib/arr-history";
import { arrApi, titleQuery, useTRef, type TitleRef } from "./shared";

export function HistoryTab({ titleRef }: { titleRef: TitleRef }) {
  const t = useT();
  const tRef = useTRef();
  const [events, setEvents] = useState<ArrHistoryEvent[] | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await arrApi<{ events: ArrHistoryEvent[] }>(`/api/admin/arr/title/history?${titleQuery(titleRef)}`, undefined, tRef.current("adminArr.history.loadFailed"));
    setLoading(false);
    if (res.ok) {
      setEvents(res.data.events);
      setError("");
    } else {
      setError(res.error);
      setEvents((e) => e ?? []);
    }
  }, [titleRef, tRef]);

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
    window.setTimeout(() => void load(), 2_000);
    return null;
  }

  if (events === null) {
    return <div className="flex items-center gap-2 py-8 text-sm text-zinc-500"><Loader2 className="h-4 w-4 animate-spin" /> {t("adminArr.common.loading")}</div>;
  }
  return (
    <div className="grid gap-3">
      <div className="flex items-center gap-2">
        {error && (
          <p role="alert" className="m-0 flex items-center gap-1.5 text-xs" style={{ color: "var(--ds-danger)" }}>
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {error}
          </p>
        )}
        <Button variant="ghost" size="sm" className="ml-auto" disabled={loading} onClick={() => void load()}>
          {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />} {t("adminArr.common.reload")}
        </Button>
      </div>
      <ArrHistoryList events={events} showTitle={false} onMarkFailed={markFailed} />
    </div>
  );
}
