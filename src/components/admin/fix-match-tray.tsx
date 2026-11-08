"use client";

import { useCallback, useEffect, useState } from "react";
import { withBasePath } from "@/lib/base-path";
import { FIX_MATCH_STARTED_EVENT } from "@/lib/client/fix-match";
import { fetchJson } from "@/lib/client/fetch-json";
import { useAsyncAction } from "@/hooks/use-async-action";
import { mediaInstanceLabel } from "@/lib/media-instances";
import { useT } from "@/components/i18n/i18n-provider";
import { trayJobsFrom, trayStatusText, type TrayJob } from "@/components/admin/fix-match-labels";
import { v } from "@/lib/validate";

// While anything is queued or running the list is re-read at this pace. With
// nothing active it is read on mount, when a job starts in this tab, when the
// tab comes back into view, and at the slow idle pace, so a job another admin
// (or another tab) started shows up without a reload.
const ACTIVE_POLL_MS = 6_000;
const IDLE_POLL_MS = 60_000;

// The jobs this tab's admin dismissed, for this browser session: a reload
// keeps them dismissed while the server still lists them (for up to an hour).
const DISMISSED_KEY = "summonarr:fix-match-tray:dismissed";
const DISMISSED_MAX = 100;

function readDismissed(): Set<string> {
  try {
    const raw: unknown = JSON.parse(sessionStorage.getItem(DISMISSED_KEY) ?? "[]");
    return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string").slice(-DISMISSED_MAX) : []);
  } catch {
    return new Set();
  }
}

function saveDismissed(ids: ReadonlySet<string>): void {
  try {
    sessionStorage.setItem(DISMISSED_KEY, JSON.stringify([...ids].slice(-DISMISSED_MAX)));
  } catch {}
}

// The feed's envelope; each job is checked on its own (trayJobsFrom), so one
// malformed entry is dropped instead of costing the whole list.
const JobsFeed = v.object({ jobs: v.array(v.unknown()) });

// Where an admin finds the outcome of a fix-match after hiding its dialog or
// leaving the page: a small pill bottom-right listing recent jobs (running,
// queued, and finished within the last hour). The jobs live in the server's
// memory, so a restart empties it.
export function FixMatchTray() {
  const t = useT();
  const [jobs, setJobs] = useState<TrayJob[]>([]);
  const [open, setOpen] = useState(false);
  // Read on the client only: the tray renders nothing until its first read lands.
  const [dismissed, setDismissed] = useState<Set<string>>(() => (typeof window === "undefined" ? new Set() : readDismissed()));
  const [hasActive, setHasActive] = useState(false);
  // A 401/403: this session can't read the feed, so the idle poll stops.
  const [denied, setDenied] = useState(false);
  // Reads can overlap (the poll and a start event): a new read aborts the one
  // in flight ("restart"), so a slow older answer never rolls a job back to
  // "running" or switches the poll off under a job that just started. Unmount
  // aborts it too.
  const reads = useAsyncAction();

  const refresh = useCallback(async () => {
    const res = await reads.run("refresh", (signal) =>
      fetchJson(withBasePath("/api/admin/fix-match/jobs"), { schema: JobsFeed, signal }));
    if (!res) return;
    let next: TrayJob[];
    if (res.ok) {
      next = trayJobsFrom(res.data.jobs);
    } else if (res.kind === "http" && (res.status === 401 || res.status === 403)) {
      // Signed out (or no longer allowed): nothing here can be read again.
      next = [];
      setDenied(true);
    } else {
      // Any other failure keeps the tray — and the poll — as they were, so a
      // job still running server-side is not dropped by one bad read.
      return;
    }
    setJobs(next);
    setHasActive(next.some((j) => j.status === "queued" || j.status === "running"));
  }, [reads]);

  useEffect(() => {
    const onStarted = () => { setOpen(true); void refresh(); };
    const onVisible = () => { if (!document.hidden) void refresh(); };
    window.addEventListener(FIX_MATCH_STARTED_EVENT, onStarted);
    document.addEventListener("visibilitychange", onVisible);
    void refresh();
    return () => {
      window.removeEventListener(FIX_MATCH_STARTED_EVENT, onStarted);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  // Re-read only while the tab is in view (coming back into view reads at
  // once, above): fast while something is queued or running, slowly otherwise.
  useEffect(() => {
    if (denied) return;
    const id = setInterval(() => { if (!document.hidden) void refresh(); }, hasActive ? ACTIVE_POLL_MS : IDLE_POLL_MS);
    return () => clearInterval(id);
  }, [hasActive, denied, refresh]);

  function dismiss(id: string) {
    setDismissed((prev) => {
      const next = new Set(prev).add(id);
      saveDismissed(next);
      return next;
    });
  }

  const visible = jobs.filter((j) => !dismissed.has(j.id));
  if (visible.length === 0) return null;
  const active = visible.filter((j) => j.status === "queued" || j.status === "running").length;

  const tone = (j: TrayJob): string =>
    j.status === "failed" ? "var(--ds-danger)" : j.status === "done" && !j.warning ? "var(--ds-success)" : j.status === "done" ? "var(--ds-warning)" : "var(--ds-fg-muted)";

  return (
    <div
      className="fixed z-40"
      style={{ right: 16, bottom: 16, maxWidth: "min(360px, calc(100vw - 32px))" }}
    >
      {open && (
        <ul
          className="m-0 list-none"
          style={{
            marginBottom: 8, padding: 8, maxHeight: 320, overflowY: "auto",
            background: "var(--ds-bg-2)", border: "1px solid var(--ds-border)", borderRadius: 8,
            boxShadow: "0 8px 24px color-mix(in oklab, black 25%, transparent)",
          }}
        >
          {visible.map((j) => (
            <li key={j.id} style={{ padding: "6px 8px", fontSize: 12, borderBottom: "1px solid var(--ds-border)" }}>
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-medium truncate" style={{ color: "var(--ds-fg)" }}>
                  {j.title ?? t("adminQueue.fixMatch.tray.untitled")}
                </span>
                <span className="ds-mono shrink-0" style={{ fontSize: 10, color: "var(--ds-fg-subtle)" }}>
                  {mediaInstanceLabel(j.server === "jellyfin" ? "jellyfin" : "plex", j.serverInstance ?? "")}
                </span>
              </div>
              <div className="flex items-start justify-between gap-2">
                <span style={{ color: tone(j), lineHeight: 1.35 }}>{trayStatusText(j, t)}</span>
                {(j.status === "done" || j.status === "failed") && (
                  <button
                    type="button"
                    className="shrink-0"
                    style={{ fontSize: 11, color: "var(--ds-fg-subtle)" }}
                    onClick={() => dismiss(j.id)}
                  >
                    {t("shared.common.dismiss")}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="ds-tap inline-flex items-center gap-2 font-medium"
        style={{
          marginLeft: "auto", display: "flex", padding: "6px 12px", fontSize: 12, borderRadius: 999,
          background: "var(--ds-bg-2)", border: "1px solid var(--ds-border)", color: "var(--ds-fg)",
        }}
      >
        <span aria-hidden style={{ color: active > 0 ? "var(--ds-accent-text)" : "var(--ds-fg-subtle)" }}>●</span>
        {t("adminQueue.fixMatch.tray.pill", { count: visible.length })}
      </button>
    </div>
  );
}
