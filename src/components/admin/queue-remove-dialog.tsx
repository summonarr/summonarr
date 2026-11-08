"use client";

// Admin → Download Queue → Remove: both halves of the arr's own "Remove from
// queue" dialog — the blocklist choice and the removal method. It opens on the
// action the admin clicked; they can still change it here.

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBackdrop, DialogClose, DialogPopup, DialogPortal, DialogTitle } from "@/components/ui/dialog";
import { AlertTriangle, Ban, Loader2, RotateCcw, Trash2, X } from "@/components/icons";
import { episodeSummary } from "@/components/admin/queue-format";
import { fetchJson, jsonInit } from "@/lib/client/fetch-json";
import { withBasePath } from "@/lib/base-path";
import { useT } from "@/components/i18n/i18n-provider";
import type { Translator } from "@/lib/i18n/translate";
import {
  blocklistRedownload, removalIds,
  type QueueItem, type QueueRemoveAction, type QueueRemoveMethod,
} from "@/lib/arr-queue";

type Option<V extends string> = { value: V; label: string; help: string };

function removeOptions(removing: QueueItem | null, arrVersions: Record<string, string | null>, t: Translator): Array<Option<QueueRemoveAction>> {
  const redownload = removing ? blocklistRedownload(removing.service, arrVersions[`${removing.service}:${removing.instance}`]) : "skipped";
  return [
    ...(removing?.pending ? [] : [{ value: "blocklistSearch" as const, label: t("adminManage.queue.remove.blocklistSearch"), help: t("adminManage.queue.remove.blocklistSearchHelp") }]),
    {
      value: "blocklist",
      label: t("adminManage.queue.remove.blocklist"),
      help: redownload === "searches"
        ? t("adminManage.queue.remove.blocklistHelpSonarrV3")
        : redownload === "unknown"
          ? t("adminManage.queue.remove.blocklistHelpSonarrUnknown")
          : t("adminManage.queue.remove.blocklistHelp"),
    },
    { value: "remove", label: t("adminManage.queue.remove.remove"), help: t("adminManage.queue.remove.removeHelp") },
  ];
}

function methodOptions(removing: QueueItem | null, t: Translator): Array<Option<QueueRemoveMethod>> {
  return [
    { value: "removeFromClient", label: t("adminManage.queue.remove.method.removeFromClient"), help: t("adminManage.queue.remove.method.removeFromClientHelp") },
    ...(removing?.canChangeCategory
      ? [{ value: "changeCategory" as const, label: t("adminManage.queue.remove.method.changeCategory"), help: t("adminManage.queue.remove.method.changeCategoryHelp") }]
      : []),
    { value: "ignore", label: t("adminManage.queue.remove.method.ignore"), help: t("adminManage.queue.remove.method.ignoreHelp") },
  ];
}

const CONFIRM: Record<QueueRemoveAction, { icon: typeof Trash2; key: string }> = {
  blocklistSearch: { icon: RotateCcw, key: "adminManage.queue.remove.confirmBlocklistSearch" },
  blocklist: { icon: Ban, key: "adminManage.queue.remove.confirmBlocklist" },
  remove: { icon: Trash2, key: "adminManage.queue.remove.confirm" },
};

// One of the dialog's two radio groups.
function RadioFieldset<V extends string>({ name, legend, options, value, onChange }: {
  name: string;
  legend: string;
  options: Array<Option<V>>;
  value: V;
  onChange: (value: V) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-2 m-0 p-0 border-0">
      <legend className="text-xs font-medium text-zinc-400 mb-1">{legend}</legend>
      {options.map((o) => (
        <label
          key={o.value}
          className="flex items-start gap-2.5 rounded-md"
          style={{
            padding: "8px 10px",
            border: `1px solid ${value === o.value ? "var(--ds-border-strong)" : "var(--ds-border)"}`,
            background: value === o.value ? "var(--ds-bg-2)" : "transparent",
          }}
        >
          <input
            type="radio"
            name={name}
            value={o.value}
            checked={value === o.value}
            onChange={() => onChange(o.value)}
            style={{ marginTop: 3 }}
          />
          <span className="flex flex-col">
            <span className="text-sm text-zinc-100">{o.label}</span>
            <span className="text-xs text-zinc-500">{o.help}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

export function RemoveQueueDialog({
  target,
  arrVersions,
  onClose,
  onRemoved,
}: {
  target: { row: QueueItem; action: QueueRemoveAction } | null;
  /** Each instance's version (`service:slug`), from the health report. */
  arrVersions: Record<string, string | null>;
  onClose: () => void;
  onRemoved: (row: QueueItem, action: QueueRemoveAction) => void;
}) {
  const t = useT();
  const [removeAction, setRemoveAction] = useState<QueueRemoveAction>(target?.action ?? "blocklistSearch");
  const [removeMethod, setRemoveMethod] = useState<QueueRemoveMethod>("removeFromClient");
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState("");
  // Each open starts on the action clicked, the default method and no error
  // (adjust-state-during-render; keying the Dialog would cut its close animation).
  // The last target opened is kept, so the body and title stay put while the
  // popup animates out after a close or a success.
  const [opened, setOpened] = useState(target);
  const [shown, setShown] = useState(target);
  if (opened !== target) {
    setOpened(target);
    if (target) {
      setShown(target);
      setRemoveAction(target.action);
      setRemoveMethod("removeFromClient");
      setRemoveError("");
    }
  }
  const removing = shown?.row ?? null;

  async function confirmRemove() {
    if (!removing || !target) return;
    setRemoveBusy(true);
    setRemoveError("");
    const res = await fetchJson(withBasePath("/api/admin/queue/remove"), {
      init: jsonInit("POST", {
        service: removing.service,
        instance: removing.instance,
        ids: removalIds(removing),
        action: removeAction,
        method: removing.pending ? "removeFromClient" : removeMethod,
      }),
      // The arr removes it from the download client before it answers.
      timeoutMs: 90_000,
      fallbackError: t("adminManage.queue.remove.failed"),
    });
    setRemoveBusy(false);
    // A 2xx whose body won't parse was still accepted.
    if (!res.ok && res.kind !== "invalid") {
      setRemoveError(res.kind === "http" ? res.error : t("adminManage.queue.remove.failed"));
      return;
    }
    onRemoved(removing, removeAction);
  }

  // Both halves of the arr's own "Remove from queue" dialog, built once per target.
  const actions = useMemo(() => removeOptions(removing, arrVersions, t), [removing, arrVersions, t]);
  const methods = useMemo(() => methodOptions(removing, t), [removing, t]);
  const confirm = CONFIRM[removeAction];
  const ConfirmIcon = confirm.icon;

  return (
    <Dialog open={target !== null} onOpenChange={(o) => { if (!o && !removeBusy) onClose(); }}>
      <DialogPortal>
        <DialogBackdrop />
        <DialogPopup className="max-w-lg">
          <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-700">
            <DialogTitle className="text-base font-semibold text-zinc-100">
              {removeAction === "remove" ? t("adminManage.queue.remove.title") : t("adminManage.queue.remove.titleBlocklist")}
            </DialogTitle>
            <DialogClose
              disabled={removeBusy}
              aria-label={t("adminQueue.common.close")}
              title={t("adminQueue.common.close")}
              className="text-zinc-500 hover:text-zinc-300 disabled:opacity-40 transition-colors"
            >
              <X className="w-5 h-5" />
            </DialogClose>
          </div>
          {removing && (
            <div className="flex flex-col gap-4 px-6 py-4">
              <div>
                <p className="m-0 text-sm font-medium text-zinc-100">
                  {removing.mediaTitle || removing.title}
                  {removing.episodes.length > 0 && <span className="ds-mono text-zinc-400"> · {episodeSummary(removing.episodes)}</span>}
                </p>
                <p className="m-0 ds-mono text-zinc-500" style={{ fontSize: 11, overflowWrap: "anywhere" }}>{removing.title}</p>
              </div>
              <RadioFieldset
                name="queue-remove-action"
                legend={t("adminManage.queue.remove.blocklistLegend")}
                options={actions}
                value={removeAction}
                onChange={setRemoveAction}
              />
              {/* A held release is in no download client — there is no removal method to pick. */}
              {!removing.pending && (
                <RadioFieldset
                  name="queue-remove-method"
                  legend={t("adminManage.queue.remove.methodLegend")}
                  options={methods}
                  value={removeMethod}
                  onChange={setRemoveMethod}
                />
              )}
              {removeError && (
                <p role="alert" className="m-0 text-xs flex items-center gap-1" style={{ color: "var(--ds-danger)" }}>
                  <AlertTriangle style={{ width: 12, height: 12 }} aria-hidden /> {removeError}
                </p>
              )}
            </div>
          )}
          <div className="flex items-center justify-between px-6 py-4 border-t border-zinc-700 bg-zinc-900">
            <button type="button" onClick={onClose} disabled={removeBusy} className="rounded px-2 py-1 text-sm text-zinc-500 hover:text-zinc-300">
              {t("shared.common.cancel")}
            </button>
            <Button
              size="sm"
              onClick={() => void confirmRemove()}
              disabled={removeBusy || target === null}
              className="bg-red-600 text-[var(--ds-on-status)] hover:bg-[var(--ds-danger-hover)]"
            >
              {removeBusy ? <Loader2 className="animate-spin" /> : <ConfirmIcon />}
              {t(confirm.key)}
            </Button>
          </div>
        </DialogPopup>
      </DialogPortal>
    </Dialog>
  );
}
