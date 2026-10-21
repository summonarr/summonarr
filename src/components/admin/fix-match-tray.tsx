"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { withBasePath } from "@/lib/base-path";
import { FIX_MATCH_STARTED_EVENT } from "@/lib/client/fix-match";
import { mediaInstanceLabel } from "@/lib/media-instances";
import { useT } from "@/components/i18n/i18n-provider";

type TrayJob = {
  id: string;
  status: "queued" | "running" | "done" | "failed";
  title: string | null;
  server: string;
  startedAt: number;
  finishedAt: number | null;
  queueAhead?: number;
  progress?: { phase: string; attempt: number; attempts: number; copy?: number; copies?: number };
  warning?: string;
  error?: string;
};

// While anything is queued or running the list is re-read at this pace; with
// nothing active it is read once on mount and when a job starts.
const ACTIVE_POLL_MS = 6_000;

// Where an admin finds the outcome of a fix-match after hiding its dialog or
// leaving the page: a small pill bottom-right listing recent jobs (running,
// queued, and finished within the last hour). The jobs live in the server's
// memory, so a restart empties it.
export function FixMatchTray() {
  const t = useT();
  const [jobs, setJobs] = useState<TrayJob[]>([]);
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const [hasActive, setHasActive] = useState(false);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    let next: TrayJob[] = [];
    try {
      const res = await fetch(withBasePath("/api/admin/fix-match/jobs"));
      if (res.ok) next = ((await res.json()) as { jobs?: TrayJob[] }).jobs ?? [];
    } catch {
      // A blip leaves the tray as it was on the next successful read.
      return;
    }
    if (!alive.current) return;
    setJobs(next);
    setHasActive(next.some((j) => j.status === "queued" || j.status === "running"));
  }, []);

  useEffect(() => {
    alive.current = true;
    const onStarted = () => { setOpen(true); void refresh(); };
    window.addEventListener(FIX_MATCH_STARTED_EVENT, onStarted);
    void refresh();
    return () => {
      alive.current = false;
      window.removeEventListener(FIX_MATCH_STARTED_EVENT, onStarted);
    };
  }, [refresh]);

  // Re-read only while something is queued or running.
  useEffect(() => {
    if (!hasActive) return;
    const id = setInterval(() => { void refresh(); }, ACTIVE_POLL_MS);
    return () => clearInterval(id);
  }, [hasActive, refresh]);

  const visible = jobs.filter((j) => !dismissed.has(j.id));
  if (visible.length === 0) return null;
  const active = visible.filter((j) => j.status === "queued" || j.status === "running").length;

  const statusText = (j: TrayJob): string => {
    if (j.status === "queued") return t("adminQueue.fixMatch.queued", { ahead: j.queueAhead ?? 0 });
    if (j.status === "running") {
      const copies = j.progress?.copies ?? 0;
      return copies > 1
        ? `${t("adminQueue.fixMatch.tray.running")} · ${t("adminQueue.fixMatch.copyOf", { copy: j.progress?.copy ?? 1, copies })}`
        : t("adminQueue.fixMatch.tray.running");
    }
    if (j.status === "failed") return j.error || t("adminQueue.fixMatch.tray.failed");
    return j.warning || t("adminQueue.fixMatch.tray.done");
  };
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
                  {mediaInstanceLabel(j.server === "jellyfin" ? "jellyfin" : "plex", "")}
                </span>
              </div>
              <div className="flex items-start justify-between gap-2">
                <span style={{ color: tone(j), lineHeight: 1.35 }}>{statusText(j)}</span>
                {(j.status === "done" || j.status === "failed") && (
                  <button
                    type="button"
                    className="shrink-0"
                    style={{ fontSize: 11, color: "var(--ds-fg-subtle)" }}
                    onClick={() => setDismissed((prev) => new Set(prev).add(j.id))}
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
