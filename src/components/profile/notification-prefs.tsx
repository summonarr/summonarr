"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2, MessageCircle, Mail, AlertTriangle, Bell } from "lucide-react";

interface NotificationPrefsProps {
  discordLinked: boolean;
  isAdminRole: boolean;
  notifyOnApproved: boolean;
  notifyOnAvailable: boolean;
  notifyOnDeclined: boolean;
  emailOnApproved: boolean;
  emailOnAvailable: boolean;
  emailOnDeclined: boolean;
  pushOnApproved: boolean;
  pushOnAvailable: boolean;
  pushOnDeclined: boolean;
  notifyOnIssue: boolean;
}

type AllPrefs = Omit<NotificationPrefsProps, "discordLinked" | "isAdminRole">;

function ToggleRow({
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: () => void;
  disabled: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-3 border-b border-zinc-800 last:border-0">
      <div>
        <p className="text-sm font-medium text-zinc-200">{label}</p>
        <p className="text-xs text-zinc-500 mt-0.5">{description}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={onChange}
        className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 focus:ring-offset-zinc-900 disabled:opacity-50 ${checked ? "bg-indigo-600" : "bg-zinc-700"}`}
      >
        <span
          className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${checked ? "translate-x-4" : "translate-x-0.5"}`}
        />
      </button>
    </div>
  );
}

export function NotificationPrefs({
  discordLinked,
  isAdminRole,
  notifyOnApproved,
  notifyOnAvailable,
  notifyOnDeclined,
  emailOnApproved,
  emailOnAvailable,
  emailOnDeclined,
  pushOnApproved,
  pushOnAvailable,
  pushOnDeclined,
  notifyOnIssue,
}: NotificationPrefsProps) {
  const router = useRouter();
  const [prefs, setPrefs] = useState<AllPrefs>({
    notifyOnApproved,
    notifyOnAvailable,
    notifyOnDeclined,
    emailOnApproved,
    emailOnAvailable,
    emailOnDeclined,
    pushOnApproved,
    pushOnAvailable,
    pushOnDeclined,
    notifyOnIssue,
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPrefsRef = useRef<AllPrefs | null>(null);

  useEffect(() => () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
  }, []);

  async function flush() {
    const updated = pendingPrefsRef.current;
    if (!updated) return;
    pendingPrefsRef.current = null;
    setSaving(true);
    setSaved(false);
    try {
      const res = await fetch("/api/profile/notifications", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updated),
      });
      if (!res.ok) {
        return;
      }
      setSaved(true);
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  function toggle(key: keyof AllPrefs) {
    const updated = { ...(pendingPrefsRef.current ?? prefs), [key]: !(pendingPrefsRef.current ?? prefs)[key] };
    setPrefs(updated);
    pendingPrefsRef.current = updated;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(flush, 400);
  }

  return (
    <div className="space-y-6">
      {discordLinked && (
        <div>
          <div className="flex items-center gap-2 mb-1">
            <MessageCircle className="w-4 h-4 text-indigo-400" />
            <p className="text-sm font-semibold text-indigo-400">Discord</p>
          </div>
          <ToggleRow
            label="Request Approved"
            description="Notify me on Discord when my request is approved"
            checked={prefs.notifyOnApproved}
            onChange={() => toggle("notifyOnApproved")}
            disabled={saving}
          />
          <ToggleRow
            label="Now Available"
            description="Notify me on Discord when my content is ready to watch"
            checked={prefs.notifyOnAvailable}
            onChange={() => toggle("notifyOnAvailable")}
            disabled={saving}
          />
          <ToggleRow
            label="Request Declined"
            description="Notify me on Discord when my request is declined"
            checked={prefs.notifyOnDeclined}
            onChange={() => toggle("notifyOnDeclined")}
            disabled={saving}
          />
        </div>
      )}

      <div>
        <div className="flex items-center gap-2 mb-1">
          <Mail className="w-4 h-4 text-zinc-400" />
          <p className="text-sm font-semibold text-zinc-400">Email</p>
        </div>
        <ToggleRow
          label="Request Approved"
          description="Email me when my request is approved"
          checked={prefs.emailOnApproved}
          onChange={() => toggle("emailOnApproved")}
          disabled={saving}
        />
        <ToggleRow
          label="Now Available"
          description="Email me when my content is ready to watch"
          checked={prefs.emailOnAvailable}
          onChange={() => toggle("emailOnAvailable")}
          disabled={saving}
        />
        <ToggleRow
          label="Request Declined"
          description="Email me when my request is declined"
          checked={prefs.emailOnDeclined}
          onChange={() => toggle("emailOnDeclined")}
          disabled={saving}
        />
      </div>

      <div>
        <div className="flex items-center gap-2 mb-1">
          <Bell className="w-4 h-4 text-zinc-400" />
          <p className="text-sm font-semibold text-zinc-400">Push</p>
        </div>
        <ToggleRow
          label="Request Approved"
          description="Push notification when my request is approved"
          checked={prefs.pushOnApproved}
          onChange={() => toggle("pushOnApproved")}
          disabled={saving}
        />
        <ToggleRow
          label="Now Available"
          description="Push notification when my content is ready to watch"
          checked={prefs.pushOnAvailable}
          onChange={() => toggle("pushOnAvailable")}
          disabled={saving}
        />
        <ToggleRow
          label="Request Declined"
          description="Push notification when my request is declined"
          checked={prefs.pushOnDeclined}
          onChange={() => toggle("pushOnDeclined")}
          disabled={saving}
        />
      </div>

      {isAdminRole && (
        <div>
          <div className="flex items-center gap-2 mb-1">
            <AlertTriangle className="w-4 h-4 text-yellow-400" />
            <p className="text-sm font-semibold text-yellow-400">Issues</p>
          </div>
          <ToggleRow
            label="New Issues & Replies"
            description="Notify me when a user reports an issue or replies to an existing one"
            checked={prefs.notifyOnIssue}
            onChange={() => toggle("notifyOnIssue")}
            disabled={saving}
          />
        </div>
      )}

      {(saving || saved) && (
        <p className="text-xs text-zinc-500 flex items-center gap-1">
          {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3 text-green-400" />}
          {saving ? "Saving…" : "Saved"}
        </p>
      )}
    </div>
  );
}
