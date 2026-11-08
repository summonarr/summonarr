"use client";

// The request queue's "Sync now" (Admin → Requests) and the Users page's "Sync
// Discord Roles". One shape each: run, then a result line beside the button —
// an alert for a failure, a status otherwise. What a run's answer says is
// sync-summary.ts.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { RefreshCw, Users } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import { useT } from "@/components/i18n/i18n-provider";
import { useAsyncAction } from "@/hooks/use-async-action";
import { fetchJson, LONG_RUN_TIMEOUT_MS, type FetchJsonFailure } from "@/lib/client/fetch-json";
import type { Translator } from "@/lib/i18n/translate";
import { RoleSyncAnswer, SyncRunAnswer, syncRunNote, type SyncNote } from "@/components/admin/sync-summary";

// A refusal is the route's own reason, else its status; no answer at all is
// the plain failure line.
function failureNote(res: FetchJsonFailure, t: Translator): SyncNote {
  const text = res.kind === "http"
    ? res.error || t("adminQueue.sync.failedStatus", { status: res.status })
    : t("adminQueue.sync.failed");
  return { text, isError: true };
}

export function SyncButton() {
  const router = useRouter();
  const t = useT();
  const action = useAsyncAction();
  const [note, setNote] = useState<SyncNote | null>(null);
  const loading = action.busy("sync");

  async function handleSync() {
    setNote(null);
    // ONE call. /api/sync already does a full Jellyfin sync of every server,
    // so a second call to /api/sync/jellyfin would only repeat work and race
    // this one (guardrail 36). A full library replace runs for minutes: no
    // client-side timeout, or a slow success would read as a failure.
    const res = await action.run(
      "sync",
      (signal) => fetchJson(withBasePath("/api/sync"), { init: { method: "POST" }, schema: SyncRunAnswer, signal, timeoutMs: LONG_RUN_TIMEOUT_MS }),
      { ifBusy: "skip" },
    );
    if (!res) return;
    if (!res.ok) {
      setNote(failureNote(res, t));
      return;
    }
    setNote(syncRunNote(res.data, t));
    // Even a degraded run refreshes: the rows that did update are the whole reason for the click.
    if (!res.data.skipped) router.refresh();
  }

  return (
    <div className="flex items-center gap-3">
      <Button
        variant="outline"
        size="sm"
        onClick={handleSync}
        disabled={loading}
        className="border-zinc-700 text-zinc-300 hover:text-zinc-100 gap-2"
      >
        <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
        {loading ? t("adminQueue.sync.syncing") : t("adminQueue.sync.syncNow")}
      </Button>
      <SyncResultNote note={note} />
    </div>
  );
}

export function SyncRolesButton() {
  const t = useT();
  const action = useAsyncAction();
  const [note, setNote] = useState<SyncNote | null>(null);
  const loading = action.busy("roles");

  async function handleSync() {
    setNote(null);
    const res = await action.run(
      "roles",
      (signal) => fetchJson(withBasePath("/api/discord/sync-roles"), { init: { method: "POST" }, schema: RoleSyncAnswer, signal, timeoutMs: LONG_RUN_TIMEOUT_MS }),
      { ifBusy: "skip" },
    );
    if (!res) return;
    if (!res.ok) {
      setNote(failureNote(res, t));
      return;
    }
    // A 200 can still carry `error`; it never reads "Synced 0 users".
    setNote(res.data.error
      ? { text: res.data.error, isError: true }
      : { text: t("adminQueue.sync.syncedUsers", { count: res.data.synced ?? 0 }), isError: false });
  }

  return (
    <div className="flex items-center gap-3">
      <Button
        variant="outline"
        size="sm"
        onClick={handleSync}
        disabled={loading}
        className="border-zinc-700 text-zinc-300 hover:text-zinc-100 gap-2"
      >
        <Users className={`w-4 h-4 ${loading ? "animate-pulse" : ""}`} />
        {loading ? t("adminQueue.sync.syncing") : t("adminQueue.sync.syncDiscordRoles")}
      </Button>
      <SyncResultNote note={note} />
    </div>
  );
}

// The outcome line beside both sync buttons: an alert for a failure, a status
// otherwise.
function SyncResultNote({ note }: { note: SyncNote | null }) {
  if (!note) return null;
  return (
    <span
      role={note.isError ? "alert" : "status"}
      aria-live={note.isError ? "assertive" : "polite"}
      className={`text-xs ${note.isError ? "text-red-400" : "text-zinc-400"}`}
    >
      {note.text}
    </span>
  );
}
