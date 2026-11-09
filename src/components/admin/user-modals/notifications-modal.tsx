"use client";

import { useCallback, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  Loader2,
  Bell,
  X,
  MessageCircle,
  Mail,
  Smartphone,
  AlertTriangle,
} from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import { fetchJson, jsonInit } from "@/lib/client/fetch-json";
import { requestFailureText } from "@/components/admin/request-failure-text";
import { useModalA11y } from "@/hooks/use-modal-a11y";
import { AdminToggleRow, type User } from "./shared";
import { useT } from "@/components/i18n/i18n-provider";

const NOTIF_KEYS = [
  "notifyOnApproved", "notifyOnAvailable", "notifyOnDeclined", "notifyOnComment",
  "emailOnApproved", "emailOnAvailable", "emailOnDeclined", "emailOnComment",
  "pushOnApproved", "pushOnAvailable", "pushOnDeclined", "pushOnComment",
  "notifyOnIssue",
] as const;
type NotifKey = (typeof NOTIF_KEYS)[number];

// One switch per channel × request event. Literal label keys, so the i18n
// dead-string check can see them.
const EVENT_LABELS = {
  approved: "adminManage.notif.approved",
  available: "adminManage.notif.available",
  declined: "adminManage.notif.declined",
  comments: "adminManage.notif.comments",
} as const;
type NotifEvent = keyof typeof EVENT_LABELS;
const NOTIF_EVENTS = Object.keys(EVENT_LABELS) as NotifEvent[];
const DISCORD_KEYS: Record<NotifEvent, NotifKey> = { approved: "notifyOnApproved", available: "notifyOnAvailable", declined: "notifyOnDeclined", comments: "notifyOnComment" };
const EMAIL_KEYS: Record<NotifEvent, NotifKey> = { approved: "emailOnApproved", available: "emailOnAvailable", declined: "emailOnDeclined", comments: "emailOnComment" };
const PUSH_KEYS: Record<NotifEvent, NotifKey> = { approved: "pushOnApproved", available: "pushOnAvailable", declined: "pushOnDeclined", comments: "pushOnComment" };

function prefsOf(u: User): Record<NotifKey, boolean> {
  const out = {} as Record<NotifKey, boolean>;
  for (const k of NOTIF_KEYS) out[k] = u[k];
  return out;
}

export function NotificationsModal({ u, onClose }: { u: User; onClose: () => void }) {
  const t = useT();
  const router = useRouter();
  const [prefs, setPrefs] = useState<Record<NotifKey, boolean>>(() => prefsOf(u));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = `notif-modal-title-${u.id}`;
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  // Set once a toggle has saved. The users table shows no notification prefs,
  // so the page (every user, their counts, sessions and grades) is re-read ONCE
  // on close — for `u` to be fresh at the next open — not after every switch.
  const dirty = useRef(false);
  // Saves still out. Closing mid-save used to skip the re-read (nothing had
  // saved YET), so the next open showed the change reverted: the close now
  // re-reads once they land.
  const inFlight = useRef(new Set<Promise<unknown>>());

  const handleClose = useCallback(() => {
    const pending = [...inFlight.current];
    if (pending.length > 0) {
      void Promise.allSettled(pending).then(() => router.refresh());
    } else if (dirty.current) {
      router.refresh();
    }
    dirty.current = false;
    onClose();
  }, [onClose, router]);

  // Focus-in + Tab-trap + Escape + focus-restore for this hand-rolled overlay.
  useModalA11y(dialogRef, handleClose, closeBtnRef);

  async function toggle(key: NotifKey) {
    const newVal = !prefs[key];
    const prevPrefs = { ...prefs };
    setPrefs((p) => ({ ...p, [key]: newVal }));
    setSaving(true);
    setError(null);
    const save = fetchJson(withBasePath(`/api/admin/users/${u.id}`), { init: jsonInit("PATCH", { [key]: newVal }) });
    inFlight.current.add(save);
    try {
      const res = await save;
      if (res.ok) {
        dirty.current = true;
        return;
      }
      // Refused, or no answer: undo the optimistic flip, or the switch would
      // show a preference the server never stored.
      setPrefs(prevPrefs);
      setError(requestFailureText(res, t, { status: "adminManage.notif.failed", network: "adminManage.users.error.network" }));
    } finally {
      inFlight.current.delete(save);
      setSaving(false);
    }
  }

  const displayName = u.name ?? u.email;

  const channelRows = (keys: Record<NotifEvent, NotifKey>) =>
    NOTIF_EVENTS.map((ev) => (
      <AdminToggleRow key={keys[ev]} label={t(EVENT_LABELS[ev])} checked={prefs[keys[ev]]} onChange={() => toggle(keys[ev])} busy={saving} />
    ));

  return (
    <div
      role="presentation"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={handleClose}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 w-80 lg:w-96 xl:w-[440px] shadow-2xl max-h-[85vh] overflow-y-auto outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-1">
          <h3
            id={titleId}
            className="text-sm font-semibold text-zinc-100 flex items-center gap-2"
          >
            <Bell className="w-4 h-4 text-zinc-400" />
            {t("adminManage.notif.title")}
          </h3>
          <button
            ref={closeBtnRef}
            type="button"
            aria-label={t("adminManage.common.close")}
            onClick={handleClose}
            className="-m-2 inline-flex h-8 w-8 items-center justify-center rounded-md text-zinc-500 hover:text-zinc-100 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <p className="text-xs text-zinc-500 mb-4 truncate">{displayName}</p>

        {u.discordId ? (
          <div className="mb-3">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 mb-1 flex items-center gap-1.5">
              <MessageCircle className="w-3 h-3" /> Discord
            </p>
            {channelRows(DISCORD_KEYS)}
          </div>
        ) : (
          <p className="text-xs text-zinc-500 mb-3 italic">{t("adminManage.notif.discordNotLinked")}</p>
        )}

        <div className="mt-3">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 mb-1 flex items-center gap-1.5">
            <Mail className="w-3 h-3" /> {t("adminManage.notif.email")}
          </p>
          {channelRows(EMAIL_KEYS)}
        </div>

        <div className="mt-3">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 mb-1 flex items-center gap-1.5">
            <Smartphone className="w-3 h-3" /> {t("adminManage.notif.push")}
          </p>
          {channelRows(PUSH_KEYS)}
        </div>

        <div className="mt-3">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 mb-1 flex items-center gap-1.5">
            <AlertTriangle className="w-3 h-3" /> {t("adminManage.notif.issues")}
          </p>
          <AdminToggleRow label={t("adminManage.notif.issueReplies")} checked={prefs.notifyOnIssue} onChange={() => toggle("notifyOnIssue")} busy={saving} />
        </div>

        {saving && (
          <p className="text-xs text-zinc-500 flex items-center gap-1 mt-3">
            <Loader2 className="w-3 h-3 animate-spin" /> {t("adminManage.common.saving")}
          </p>
        )}

        {error && (
          <p role="alert" aria-live="assertive" className="text-xs text-red-400 mt-3">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
