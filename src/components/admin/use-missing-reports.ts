"use client";

// Admin → Missing: the four lists' reads (missing-report.tsx). Each (service,
// mode) list loads live on first view and keeps its answer until Refresh; only
// the newest load of a list may commit. "Instant, then live"
// (use-arr-snapshot.ts): until a list holds a live answer, the snapshot the
// server kept for exactly that read is painted, then the live answer replaces
// it (guardrail 5h).
//
// The page hands in two things about its rows:
// - `listIdle(k)`: false while the admin has something going on list k (a bulk
//   search, its confirmation, a row's own search in flight). No snapshot paints
//   over that.
// - `onLiveReplaced(k)`: list k's reset when a fresh live answer replaces an
//   earlier LIVE one (a Refresh). It must be stable, since `load` depends on it.

import { useCallback, useEffect, useRef, useState } from "react";
import { withBasePath } from "@/lib/base-path";
import { useT } from "@/components/i18n/i18n-provider";
import { useArrSnapshot } from "@/components/admin/use-arr-snapshot";
import { readApiError } from "@/lib/client/api-error";
import type { CutoffMovie, CutoffSeries, MissingMovie, MissingSeries } from "@/lib/arr-missing";
import type { ArrErrorKind } from "@/lib/arr-error-kind";

export type Service = "sonarr" | "radarr";
export type Mode = "missing" | "cutoff";
export type ReportKey = `${Service}:${Mode}`;

export type Report<T> = {
  service: Service;
  enabled: boolean;
  instances: Array<{ slug: string; name: string }>;
  // `kind` is what the page shows (translated); `error` is the raw upstream detail.
  errors: Array<{ instance: string; error: string; kind?: ArrErrorKind }>;
  items: T[];
  // Cutoff only: instances whose listing ran past the server's page ceiling.
  truncated?: Array<{ instance: string; read: number; total: number }>;
};
export type Reports = {
  "sonarr:missing"?: Report<MissingSeries>;
  "radarr:missing"?: Report<MissingMovie>;
  "sonarr:cutoff"?: Report<CutoffSeries>;
  "radarr:cutoff"?: Report<CutoffMovie>;
};

// A list's live read. ONE builder for the live load and the snapshot read, so
// the server keys the snapshot on exactly the read the live load makes.
const missingListUrl = (svc: Service, m: Mode) => withBasePath(`/api/admin/missing?service=${svc}&mode=${m}`);

export function useMissingReports({
  service,
  mode,
  configured,
  listIdle,
  onLiveReplaced,
}: {
  service: Service;
  mode: Mode;
  configured: Record<Service, boolean>;
  listIdle: (k: ReportKey) => boolean;
  onLiveReplaced: (k: ReportKey) => void;
}) {
  const t = useT();
  const [reports, setReports] = useState<Reports>({});
  // Every list with a load in flight — per key, so a load of one list can't
  // hide another's: a single slot let a tab switch overwrite it, and the
  // "not while this list is reloading" guards then read false mid-load.
  const [loadingKeys, setLoadingKeys] = useState<ReadonlySet<ReportKey>>(new Set());
  // The newest load of each list: only that one may commit (an older listing
  // landing late never overwrites a newer one, nor clears its loading mark).
  const loadSeq = useRef<Partial<Record<ReportKey, number>>>({});
  const [errors, setErrors] = useState<Partial<Record<ReportKey, string>>>({});

  const current: ReportKey = `${service}:${mode}`;
  // The lists holding a LIVE answer (not a snapshot): the ref for the
  // synchronous checks in `load` and the snapshot painter, the state for the
  // render (the snapshot url). Never shrinks — a Refresh is always live.
  const liveRef = useRef<Set<ReportKey>>(new Set());
  const [liveKeys, setLiveKeys] = useState<ReadonlySet<ReportKey>>(new Set());
  // The view on screen and its snapshot's markLive, as of the last commit — a
  // live answer for another list must not mark this one live.
  const viewRef = useRef<ReportKey>(current);
  const markLiveRef = useRef<() => void>(() => {});

  const load = useCallback(async (svc: Service, m: Mode) => {
    const k: ReportKey = `${svc}:${m}`;
    const seq = (loadSeq.current[k] ?? 0) + 1;
    loadSeq.current[k] = seq;
    // A newer load of this list owns its state from here on.
    const superseded = () => loadSeq.current[k] !== seq;
    setLoadingKeys((prev) => new Set(prev).add(k));
    setErrors((e) => ({ ...e, [k]: "" }));
    try {
      const res = await fetch(missingListUrl(svc, m));
      if (!res.ok) {
        const message = await readApiError(res, t("adminManage.missing.error.load"));
        if (superseded()) return;
        setErrors((e) => ({ ...e, [k]: message }));
        return;
      }
      const data = await res.json();
      if (superseded()) return;
      // This list now holds a live answer: no snapshot paints over it from here
      // on (the ref is what a snapshot landing in the same tick reads), its
      // snapshot read stops and the stale note goes.
      const replacesLive = liveRef.current.has(k);
      liveRef.current.add(k);
      setLiveKeys(new Set(liveRef.current));
      if (viewRef.current === k) markLiveRef.current();
      setReports((r) => ({ ...r, [k]: data }));
      // A fresh listing after an earlier LIVE one (Refresh) is a fresh start
      // for the list's rows. The FIRST live answer replaces at most a
      // snapshot, whose rows are the same rows (instance + id): what the admin
      // ticked or searched on it stands — re-arming a row searched a moment
      // ago would let it be searched twice.
      if (replacesLive) onLiveReplaced(k);
    } catch {
      if (superseded()) return;
      setErrors((e) => ({ ...e, [k]: t("adminManage.missing.error.loadNetwork") }));
    } finally {
      if (!superseded()) {
        setLoadingKeys((prev) => {
          const next = new Set(prev);
          next.delete(k);
          return next;
        });
      }
    }
  }, [t, onLiveReplaced]);

  const loadingHere = loadingKeys.has(current);
  // Not while a load of this list is already out: switching away and back
  // mid-load used to start a second live listing of the same report.
  const needsLoad = configured[service] && !reports[current] && !errors[current] && !loadingHere;
  useEffect(() => {
    if (needsLoad) void load(service, mode);
  }, [needsLoad, service, mode, load]);

  // A snapshot only ever fills a list with no live answer yet, and never while
  // the admin has something going on that list (`listIdle`). It sets the
  // report alone — never an error, a selection, a dialog or a row's search
  // state.
  const snapshotMayPaint = (k: ReportKey) => !liveRef.current.has(k) && listIdle(k);

  // The snapshot of this view's read, painted while it has no live answer —
  // on open and on each tab/mode switch. Null once a live answer landed (a
  // Refresh is live, never a snapshot) and while nothing is configured.
  const snapshotUrl = configured[service] && !liveKeys.has(current) ? missingListUrl(service, mode) : null;
  const snap = useArrSnapshot<Reports[ReportKey]>(snapshotUrl, (data) => {
    if (!snapshotMayPaint(current)) return false;
    setReports((r) => ({ ...r, [current]: data }));
  });
  useEffect(() => {
    viewRef.current = current;
    markLiveRef.current = snap.markLive;
  });

  return { current, reports, errors, loadingKeys, loadingHere, load, staleAt: snap.staleAt };
}
