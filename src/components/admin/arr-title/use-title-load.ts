"use client";

// The title manager's read of its title (title-manager.tsx renders it):
// GET /api/admin/arr/title for the target, on open and again after a refresh,
// a file delete or a write whose re-read failed.
//
// - The OPEN-time read replaces the state and remounts the Settings form
//   (`version`); every later read REBASES — merged over the title shown, the
//   admin's edits left alone. So does the open-time read when a snapshot was
//   painted first (liveTitleLanding): the admin may already be editing over it.
// - Every read runs under one key ("load"): a newer one aborts the one before,
//   and closing aborts it, so an older answer can never land over a newer one.
// - A write's answer (a Settings save, a season or episode flip) carries the
//   title as the arr holds it AFTER the write (`applyWrite`). A read still out
//   may have been answered before it, so it is dropped rather than merged over
//   the write; it may also have carried what the write's answer can't (a
//   refresh's re-read, the choice lists), so the title is read once more.
// - "Instant, then live": the open-time read's snapshot (the same URL — one
//   builder) is painted while the live read is out, and only ever fills an
//   EMPTY dialog — never over a live answer or a write's. markLive() runs only
//   for an accepted live answer.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useArrSnapshot } from "@/components/admin/use-arr-snapshot";
import type { ArrTitle } from "@/lib/arr-title";
import { withBasePath } from "@/lib/base-path";
import { TITLE_STATE, type TitleState } from "@/lib/client/arr-answers";
import { check } from "@/lib/validate";
import { useAsyncAction } from "@/hooks/use-async-action";
import { arrApi, useTRef, type ArrServiceName } from "./shared";
import { liveTitleLanding, snapshotMayPaint, titleReadPath, type TitleReadTarget } from "./snapshot-rules";

/**
 * A re-read title that lost its root folder (an arr version that omits
 * rootFolderPath, read without the root-folder list to infer it from) keeps
 * the one the manager already knew.
 */
export function mergeTitle(prev: ArrTitle, next: ArrTitle): ArrTitle {
  return next.rootFolderPath === null && prev.rootFolderPath !== null ? { ...next, rootFolderPath: prev.rootFolderPath } : next;
}

/** The target by its value: a parent re-render hands a new object, and the reads key on it. */
export function useStableTarget(target: TitleReadTarget): TitleReadTarget {
  const kind = "tmdbId" in target ? "tmdb" : "arr";
  const id = "tmdbId" in target ? target.tmdbId : target.arrId;
  return useMemo(() => (kind === "tmdb" ? { tmdbId: id } : { arrId: id }), [kind, id]);
}

export function useTitleLoad({ open, service, instance, target }: {
  open: boolean;
  service: ArrServiceName;
  instance: string;
  /** Stable (useStableTarget). */
  target: TitleReadTarget;
}) {
  const tRef = useTRef();
  const [state, setState] = useState<TitleState | null>(null);
  const [loadError, setLoadError] = useState("");
  // Bumped by the open-time read only: a background re-read (after a refresh or
  // a file delete) must not reset settings the admin is still editing.
  const [version, setVersion] = useState(0);
  const action = useAsyncAction();
  // This open's title came from the snapshot: the open-time live answer
  // rebases the form instead of replacing it.
  const snapshotPainted = useRef(false);

  const openPath = open ? titleReadPath(service, instance, target) : null;
  // A checked snapshot only fills an EMPTY dialog; declined, nothing stale is on screen.
  const applyTitleSnapshot = (data: unknown) => {
    const parsed = check(TITLE_STATE, data);
    if (!parsed.ok || !snapshotMayPaint(state !== null, false)) return false;
    snapshotPainted.current = true;
    setState(parsed.value);
    return true;
  };
  const snap = useArrSnapshot<unknown>(openPath === null ? null : withBasePath(openPath), applyTitleSnapshot);
  const { markLive } = snap;

  // `initial` is the open-time read: it replaces the state and remounts the
  // Settings form — unless a snapshot was painted first.
  const load = useCallback(async (by: TitleReadTarget, initial = false) => {
    const res = await action.run("load", (signal) =>
      arrApi(titleReadPath(service, instance, by), { schema: TITLE_STATE, signal }, tRef.current("adminArr.manage.loadFailed")),
    );
    // Superseded — by a newer read, a write's answer, the dialog closing.
    if (!res) return;
    if (res.ok) {
      const landing = liveTitleLanding(initial, snapshotPainted.current);
      setState((prev) => (prev && landing === "rebase" ? { ...res.data, title: mergeTitle(prev.title, res.data.title) } : res.data));
      if (landing === "replace") setVersion((v) => v + 1);
      setLoadError("");
      markLive();
    } else {
      setLoadError(res.error);
    }
  }, [action, service, instance, tRef, markLive]);

  // Every open starts empty, with nothing painted, and reads the title.
  // Closing drops a read still out — no re-read lands after close.
  useEffect(() => {
    if (!open) return;
    setState(null);
    setLoadError("");
    snapshotPainted.current = false;
    void load(target, true);
    return () => action.abort("load");
  }, [open, target, load, action]);

  // Stable per title: the tabs key their reads on it.
  const arrId = state?.title.arrId ?? null;
  const reload = useCallback(() => {
    if (arrId !== null) void load({ arrId });
  }, [arrId, load]);

  /** Drops the reads still out; true when one was (the caller reads again once its own title is in). */
  const supersedeReads = useCallback((): boolean => {
    const overlapped = action.busy("load");
    action.abort("load");
    return overlapped;
  }, [action]);

  /** A write's answer: its title goes in over any read still out; null = the write landed but its re-read failed. */
  const applyWrite = useCallback((next: ArrTitle | null) => {
    if (!next) return reload();
    const reread = supersedeReads();
    setState((s) => (s ? { ...s, title: mergeTitle(s.title, next) } : s));
    if (reread) reload();
  }, [reload, supersedeReads]);

  return {
    state,
    loadError,
    version,
    /** When the title shown was read, while it is the painted snapshot. */
    staleAt: snap.staleAt,
    arrId,
    /**
     * The failed read again. With nothing shown it is the open-time read (the
     * spinner comes back); with a title shown — a painted snapshot, or a title
     * whose re-read failed — it REBASES on the live answer, edits kept.
     */
    retry: () => {
      setLoadError("");
      if (arrId !== null) void load({ arrId });
      else void load(target, true);
    },
    reload,
    applyWrite,
  };
}
