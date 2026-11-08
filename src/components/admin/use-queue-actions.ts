"use client";

// Admin → Download Queue's page actions (download-queue.tsx): Grab now,
// Re-check, and what a finished Import or Remove leaves on screen — the one
// notice line, the action error line, the instances a Re-check failed on —
// plus the instance versions the Remove dialog's wording needs.

import { useState, useRef } from "react";
import { useT } from "@/components/i18n/i18n-provider";
import { withBasePath } from "@/lib/base-path";
import { fetchJson, jsonInit } from "@/lib/client/fetch-json";
import { check, v } from "@/lib/validate";
import { recheckOutcome, type QueueItem, type QueueRemoveAction, type RecheckError } from "@/lib/arr-queue";
import { rowKey } from "@/components/admin/queue-table";

// Each instance's version, by `service:slug`, from the health report; an entry
// that isn't one is skipped (its version stays unknown: the cautious wording).
const HealthEntry = v.object({ service: v.string(), slug: v.string(), version: v.optional(v.nullable(v.string())) });
const HealthReport = v.object({ instances: v.array(v.unknown()) });

// A grab asks one instance: room for a slow one. A re-check asks every
// instance, a few at a time, so it has no client deadline (as before).
const GRAB_TIMEOUT_MS = 90_000;

export function useQueueActions({ reloadSoon, dropRow }: {
  /** The data hook's one deferred re-read. */
  reloadSoon: (ms: number) => void;
  /** Takes a removed download off the table at once (the next poll agrees). */
  dropRow: (row: QueueItem) => void;
}) {
  const t = useT();
  // Grab now / Re-check in flight: each row's key, and "recheck". A Set, so
  // one finishing never re-enables another that is still running.
  const [acting, setActing] = useState<ReadonlySet<string>>(() => new Set());
  const startActing = (key: string) => setActing((s) => new Set(s).add(key));
  const stopActing = (key: string) => setActing((s) => {
    const next = new Set(s);
    next.delete(key);
    return next;
  });
  const [notice, setNotice] = useState("");
  // A Grab now / Re-check failure: its own line, which only the next action
  // clears — the next poll's successful load clears `error`, and took this with it.
  const [actionError, setActionError] = useState("");
  // Instances that refused the last Re-check (the route answers 202 even when
  // every one did), and whether that was all of them.
  const [recheckFailed, setRecheckFailed] = useState<{ all: boolean; failed: RecheckError[] } | null>(null);
  // Each instance's version, from the health report, read ONCE per page when
  // the first Sonarr row's Remove opens: Sonarr v3 ignores skipRedownload, so
  // its "Blocklist" can't promise "no new search". Until a Sonarr instance's
  // version is known (the read still running or failed) the dialog says so
  // instead of promising anything (`blocklistRedownload` → "unknown").
  const [arrVersions, setArrVersions] = useState<Record<string, string | null>>({});
  // The health report reads every configured instance (a dark one takes the
  // full timeout), so it is never re-read per dialog open — not even after a
  // failure, which leaves the cautious wording for the session.
  const versionsRequested = useRef(false);

  // A finished action's line replaces the last one's, success or failure alike.
  function succeeded(text: string) {
    setActionError("");
    setNotice(text);
  }

  async function loadVersions() {
    if (versionsRequested.current) return;
    versionsRequested.current = true;
    const res = await fetchJson(withBasePath("/api/admin/arr-health"), { schema: HealthReport });
    // Unknown versions keep the dialog's cautious wording.
    if (!res.ok) return;
    const next: Record<string, string | null> = {};
    for (const raw of res.data.instances) {
      const i = check(HealthEntry, raw);
      if (i.ok) next[`${i.value.service}:${i.value.slug}`] = i.value.version ?? null;
    }
    setArrVersions((v) => ({ ...v, ...next }));
  }

  async function grabNow(row: QueueItem) {
    const key = rowKey(row);
    startActing(key);
    setNotice("");
    setActionError("");
    try {
      const res = await fetchJson(withBasePath("/api/admin/queue/grab"), {
        init: jsonInit("POST", { service: row.service, instance: row.instance, ids: row.ids }),
        timeoutMs: GRAB_TIMEOUT_MS,
        fallbackError: t("adminManage.queue.grab.failed"),
      });
      // A 2xx whose body won't parse still grabbed.
      if (!res.ok && res.kind !== "invalid") {
        setActionError(res.kind === "http" ? res.error : t("adminManage.queue.grab.failed"));
        return;
      }
      succeeded(t("adminManage.queue.grab.done", { title: row.mediaTitle || row.title }));
      reloadSoon(2_000);
    } finally {
      stopActing(key);
    }
  }

  async function recheck() {
    startActing("recheck");
    setNotice("");
    setActionError("");
    setRecheckFailed(null);
    try {
      const res = await fetchJson(withBasePath("/api/admin/queue/recheck"), {
        init: { method: "POST" },
        timeoutMs: Infinity,
        fallbackError: t("adminManage.queue.recheck.failed"),
      });
      if (!res.ok && res.kind !== "invalid") {
        setActionError(res.kind === "http" ? res.error : t("adminManage.queue.recheck.failed"));
        return;
      }
      // An unreadable 202 says nothing about the instances: recheckOutcome reads
      // it as none asked, and checks each field of a readable one itself.
      const data = res.ok && typeof res.data === "object" && res.data !== null ? (res.data as { instances?: unknown; errors?: unknown }) : null;
      const outcome = recheckOutcome(data);
      if (outcome.failed.length > 0) setRecheckFailed({ all: outcome.allFailed, failed: outcome.failed });
      if (!outcome.allFailed) succeeded(t("adminManage.queue.recheck.done", { count: outcome.asked }));
      reloadSoon(5_000);
    } finally {
      stopActing("recheck");
    }
  }

  // The arr took the files; it imports in the background, so give it a moment
  // before re-reading.
  function imported(row: QueueItem, files: number) {
    succeeded(t("adminManage.queue.import.done", { title: row.mediaTitle || row.title, count: files }));
    reloadSoon(3_000);
  }

  // The arr accepted the removal: the row goes at once (the next poll agrees).
  function removed(row: QueueItem, action: QueueRemoveAction) {
    dropRow(row);
    succeeded(
      action === "blocklistSearch"
        ? t("adminManage.queue.remove.doneSearch", { title: row.mediaTitle || row.title })
        : t("adminManage.queue.remove.done", { title: row.mediaTitle || row.title }),
    );
  }

  return { acting, notice, actionError, recheckFailed, arrVersions, loadVersions, grabNow, recheck, imported, removed };
}
