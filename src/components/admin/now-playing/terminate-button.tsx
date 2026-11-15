"use client";

// A live session's Terminate button and its confirm dialog. A successful
// request closes the dialog and marks the card "Stop requested" until the
// session leaves the grid (the next activity:sessions push after the server
// tears the stream down). That removal is not guaranteed — Plex ignores
// termination for some direct-play clients, and the shared SSE connection can
// be parked on its re-probe — so the card says what happened instead of the
// dialog waiting on it, and Terminate stays available to try again.

import { useState, type FormEvent } from "react";
import { withBasePath } from "@/lib/base-path";
import { fetchJson, jsonInit } from "@/lib/client/fetch-json";
import { useAsyncAction } from "@/hooks/use-async-action";
import type { ActiveSessionLive } from "@/hooks/use-live-events";
import { Loader2, X } from "@/components/icons";
import { useT } from "@/components/i18n/i18n-provider";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBackdrop,
  DialogClose,
  DialogPopup,
  DialogPortal,
  DialogTitle,
} from "@/components/ui/dialog";
import { terminateOutcome, type TerminateTarget } from "./rules";

export function TerminateButton({ session, target }: { session: ActiveSessionLive; target: TerminateTarget }) {
  const t = useT();
  // Pre-filled reason shown on the viewer's client; editable before sending.
  const defaultReason = t("adminActivity.terminate.defaultReason");
  const action = useAsyncAction();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState(defaultReason);
  const [error, setError] = useState<string | null>(null);
  const [requested, setRequested] = useState(false);
  // Only while the request is out (fetchJson bounds it); every dismissal route
  // waits on it, so a failure always has a dialog to show up in.
  const busy = action.busy("terminate");
  const serverLabel = session.source === "jellyfin" ? "Jellyfin" : "Plex";

  function openDialog() {
    setReason(defaultReason);
    setError(null);
    setRequested(false);
    setOpen(true);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const res = await action.run(
      "terminate",
      (signal) =>
        fetchJson(withBasePath(target.endpoint), {
          init: jsonInit("POST", {
            sessionKey: target.sessionKey,
            serverInstance: target.serverInstance,
            reason: reason.trim() || defaultReason,
          }),
          signal,
          fallbackError: t("adminActivity.terminate.failed"),
        }),
      // A second submit while one is out would ask the server twice.
      { ifBusy: "skip" },
    );
    if (!res) return;
    const outcome = terminateOutcome(res, t);
    if (outcome.kind === "requested") {
      setOpen(false);
      setRequested(true);
    } else if (outcome.kind === "error") {
      // No answer came (network, timeout): the browser's own message is
      // English, so it goes to the console and the dialog shows translated copy.
      if (outcome.log) console.error(`[activity-now-playing] terminate failed (${outcome.log})`);
      setError(outcome.message);
    }
  }

  return (
    <>
      <span
        role="status"
        className="ds-mono"
        title={requested ? t("adminActivity.terminate.requestedTitle") : undefined}
        style={{ fontSize: 10.5, color: "var(--ds-fg-subtle)", marginRight: requested ? 8 : 0 }}
      >
        {requested ? t("adminActivity.terminate.requested") : null}
      </span>
      <button
        type="button"
        onClick={openDialog}
        style={{
          fontSize: 10.5,
          padding: "3px 8px",
          background: "transparent",
          border: "1px solid var(--ds-border)",
          borderRadius: 6,
          color: "var(--ds-fg-muted)",
        }}
        title={t("adminActivity.terminate.buttonTitle", { server: serverLabel })}
      >
        {t("adminActivity.terminate.button")}
      </button>

      {open && (
        <TerminateDialog
          serverLabel={serverLabel}
          title={session.title}
          reason={reason}
          setReason={setReason}
          busy={busy}
          error={error}
          onSubmit={onSubmit}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

// The confirm dialog: the reason the viewer is shown, and the request's error.
// Every dismissal route waits while the request is out (`busy`), so its answer
// always has somewhere to land.
function TerminateDialog({
  serverLabel,
  title,
  reason,
  setReason,
  busy,
  error,
  onSubmit,
  onClose,
}: {
  serverLabel: string;
  title: string;
  reason: string;
  setReason: (reason: string) => void;
  busy: boolean;
  error: string | null;
  onSubmit: (e: FormEvent) => void;
  onClose: () => void;
}) {
  const t = useT();
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        // Not mid-request: the answer has to land somewhere.
        if (!next && !busy) onClose();
      }}
    >
      <DialogPortal>
        <DialogBackdrop />
        <DialogPopup
          className="max-w-md"
          style={{
            background: "var(--ds-bg-1)",
            border: "1px solid var(--ds-border)",
            borderRadius: 12,
            boxShadow: "var(--ds-shadow-lg)",
          }}
        >
          <div
            className="flex items-center justify-between"
            style={{ padding: "14px 20px", borderBottom: "1px solid var(--ds-border)" }}
          >
            <div>
              <DialogTitle
                className="font-semibold"
                style={{ fontSize: 15, color: "var(--ds-fg)", margin: 0 }}
              >
                {t("adminActivity.terminate.dialogTitle", { server: serverLabel })}
              </DialogTitle>
              <p
                className="ds-mono truncate max-w-72"
                style={{ fontSize: 11, color: "var(--ds-fg-subtle)", margin: "2px 0 0" }}
              >
                {title}
              </p>
            </div>
            <DialogClose
              aria-label={t("adminActivity.common.close")}
              disabled={busy}
              className="inline-flex items-center justify-center rounded-full transition-colors disabled:opacity-40"
              style={{
                width: 28,
                height: 28,
                background: "transparent",
                border: 0,
                color: "var(--ds-fg-muted)",
              }}
            >
              <X style={{ width: 14, height: 14 }} />
            </DialogClose>
          </div>

          <form onSubmit={onSubmit} className="px-5 py-4 space-y-4">
            <div className="space-y-1.5">
              <label
                htmlFor="terminate-reason"
                className="text-xs font-medium text-zinc-400 uppercase tracking-wide"
              >
                {t("adminActivity.terminate.reasonLabel")}
              </label>
              <textarea
                id="terminate-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={500}
                rows={3}
                autoFocus
                disabled={busy}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-500 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 resize-none"
              />
            </div>

            {error && <p role="alert" className="text-xs text-red-400">{error}</p>}

            <div className="flex justify-end gap-2 pt-1">
              {/* The shared Button primitive, like every other dialog's
                  actions — same radius, height, focus ring and hover
                  (the hand-rolled danger fill had none). */}
              <Button
                variant="outline"
                size="sm"
                onClick={onClose}
                disabled={busy}
              >
                {t("adminActivity.common.cancel")}
              </Button>
              <Button type="submit" variant="destructive" size="sm" disabled={busy}>
                {busy && <Loader2 className="animate-spin" />}
                {busy ? t("adminActivity.terminate.terminating") : t("adminActivity.terminate.button")}
              </Button>
            </div>
          </form>
        </DialogPopup>
      </DialogPortal>
    </Dialog>
  );
}
