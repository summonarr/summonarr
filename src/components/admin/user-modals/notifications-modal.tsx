"use client";

import { useState, useEffect, useRef } from "react";
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
import { AdminToggleRow, type User } from "./shared";

type NotifKey = "notifyOnApproved" | "notifyOnAvailable" | "notifyOnDeclined" | "emailOnApproved" | "emailOnAvailable" | "emailOnDeclined" | "pushOnApproved" | "pushOnAvailable" | "pushOnDeclined" | "notifyOnIssue";

export function NotificationsModal({ u, onClose }: { u: User; onClose: () => void }) {
  const router = useRouter();
  const [prefs, setPrefs] = useState<Record<NotifKey, boolean>>({
    notifyOnApproved: u.notifyOnApproved,
    notifyOnAvailable: u.notifyOnAvailable,
    notifyOnDeclined: u.notifyOnDeclined,
    emailOnApproved: u.emailOnApproved,
    emailOnAvailable: u.emailOnAvailable,
    emailOnDeclined: u.emailOnDeclined,
    pushOnApproved: u.pushOnApproved,
    pushOnAvailable: u.pushOnAvailable,
    pushOnDeclined: u.pushOnDeclined,
    notifyOnIssue: u.notifyOnIssue,
  });
  const [saving, setSaving] = useState(false);
  const titleId = `notif-modal-title-${u.id}`;
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  // Focus the close button on mount, return focus to the opener on unmount,
  // and close on ESC. Minimal a11y trap (no Tab cycling — small panel, low
  // risk of focus escape; can revisit if we adopt @base-ui/react Dialog).
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeBtnRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      opener?.focus?.();
    };
  }, [onClose]);

  async function toggle(key: NotifKey) {
    const newVal = !prefs[key];
    const prevPrefs = { ...prefs };
    setPrefs((p) => ({ ...p, [key]: newVal }));
    setSaving(true);
    try {
      const res = await fetch(withBasePath(`/api/admin/users/${u.id}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: newVal }),
      });
      if (!res.ok) {
        setPrefs(prevPrefs);
        return;
      }
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  const displayName = u.name ?? u.email;

  return (
    <div
      role="presentation"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 w-80 lg:w-96 xl:w-[440px] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-1">
          <h3
            id={titleId}
            className="text-sm font-semibold text-white flex items-center gap-2"
          >
            <Bell className="w-4 h-4 text-zinc-400" />
            Notification Settings
          </h3>
          <button
            ref={closeBtnRef}
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="text-zinc-500 hover:text-white transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <p className="text-xs text-zinc-500 mb-4 truncate">{displayName}</p>

        {u.discordId ? (
          <div className="mb-3">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-indigo-400 mb-1 flex items-center gap-1.5">
              <MessageCircle className="w-3 h-3" /> Discord
            </p>
            <AdminToggleRow label="Request Approved" checked={prefs.notifyOnApproved} onChange={() => toggle("notifyOnApproved")} disabled={saving} />
            <AdminToggleRow label="Now Available" checked={prefs.notifyOnAvailable} onChange={() => toggle("notifyOnAvailable")} disabled={saving} />
            <AdminToggleRow label="Request Declined" checked={prefs.notifyOnDeclined} onChange={() => toggle("notifyOnDeclined")} disabled={saving} />
          </div>
        ) : (
          <p className="text-xs text-zinc-600 mb-3 italic">Discord not linked — no Discord notifications</p>
        )}

        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 mb-1 flex items-center gap-1.5">
            <Mail className="w-3 h-3" /> Email
          </p>
          <AdminToggleRow label="Request Approved" checked={prefs.emailOnApproved} onChange={() => toggle("emailOnApproved")} disabled={saving} />
          <AdminToggleRow label="Now Available" checked={prefs.emailOnAvailable} onChange={() => toggle("emailOnAvailable")} disabled={saving} />
          <AdminToggleRow label="Request Declined" checked={prefs.emailOnDeclined} onChange={() => toggle("emailOnDeclined")} disabled={saving} />
        </div>

        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 mb-1 flex items-center gap-1.5">
            <Smartphone className="w-3 h-3" /> Push
          </p>
          <AdminToggleRow label="Request Approved" checked={prefs.pushOnApproved} onChange={() => toggle("pushOnApproved")} disabled={saving} />
          <AdminToggleRow label="Now Available" checked={prefs.pushOnAvailable} onChange={() => toggle("pushOnAvailable")} disabled={saving} />
          <AdminToggleRow label="Request Declined" checked={prefs.pushOnDeclined} onChange={() => toggle("pushOnDeclined")} disabled={saving} />
        </div>

        <div className="mt-3">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-yellow-400 mb-1 flex items-center gap-1.5">
            <AlertTriangle className="w-3 h-3" /> Issues
          </p>
          <AdminToggleRow label="New Issues & Replies" checked={prefs.notifyOnIssue} onChange={() => toggle("notifyOnIssue")} disabled={saving} />
        </div>

        {saving && (
          <p className="text-xs text-zinc-500 flex items-center gap-1 mt-3">
            <Loader2 className="w-3 h-3 animate-spin" /> Saving…
          </p>
        )}
      </div>
    </div>
  );
}
