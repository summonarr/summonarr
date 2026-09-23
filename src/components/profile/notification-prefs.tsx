"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2, MessageCircle, Mail, AlertTriangle, Bell } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import { Switch } from "@/components/ui/switch";

interface NotificationPrefsProps {
  // Worked out on the server: true only when the email feature is on, the
  // "Send notification emails" switch is on, and a mail sender is configured.
  // When false the whole Email section is hidden, since no email would be sent.
  emailEnabled: boolean;
  discordLinked: boolean;
  isAdminRole: boolean;
  isJellyfin: boolean;
  notificationEmail: string | null;
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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type AllPrefs = Omit<NotificationPrefsProps, "emailEnabled" | "discordLinked" | "isAdminRole" | "isJellyfin" | "notificationEmail">;

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
      <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </div>
  );
}

// Notification on/off switches per channel (Discord, email, push). Each flip
// shows immediately and is saved 400ms later (so quick flips are sent together),
// and is undone if the save fails. Also holds the Jellyfin-only field for
// setting a notification email address.
export function NotificationPrefs({
  emailEnabled,
  discordLinked,
  isAdminRole,
  isJellyfin,
  notificationEmail,
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
  const [saveError, setSaveError] = useState<string | null>(null);

  // Jellyfin-only local state for the self-service notification-email flow. The
  // input holds a NEW address to verify; the current verified address is shown
  // separately from the `notificationEmail` prop.
  const [emailInput, setEmailInput] = useState("");
  const [emailSavingState, setEmailSavingState] = useState<"idle" | "saving" | "sent" | "error">("idle");
  const [emailError, setEmailError] = useState<string | null>(null);

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPrefsRef = useRef<AllPrefs | null>(null);
  // Last state the server confirmed — the toggles revert here if a save fails.
  const savedPrefsRef = useRef<AllPrefs>(prefs);

  useEffect(() => {
    // Copy the ref objects themselves (not their .current values) so the
    // cleanup reads whatever is pending at the moment the component unmounts.
    const timer = saveTimerRef;
    const pendingRef = pendingPrefsRef;
    return () => {
      if (timer.current) clearTimeout(timer.current);
      const pending = pendingRef.current;
      if (!pending) return;
      // There is no Save button: flipping a switch IS the save, and the switch
      // has already moved on screen. A toggle made less than 400ms before
      // leaving the page is still waiting on the timer, so send it now instead
      // of dropping it. `keepalive` lets the request finish after the page is
      // gone. Same as the unmount save in settings/features-form.tsx.
      void fetch(withBasePath("/api/profile/notifications"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pending),
        keepalive: true,
      }).catch(() => {});
    };
  }, []);

  // Put the toggles back to the last state the server confirmed, so the UI never
  // shows a position the server rejected. Skipped while a newer toggle is still
  // waiting to be saved: that save sends the full set of toggles (including this
  // one), so it will retry this change — and rolling back here would make the
  // switches disagree with what that save then stores.
  function rollBack() {
    if (pendingPrefsRef.current) return;
    setPrefs(savedPrefsRef.current);
  }

  async function flush() {
    const updated = pendingPrefsRef.current;
    if (!updated) return;
    pendingPrefsRef.current = null;
    setSaving(true);
    setSaved(false);
    setSaveError(null);
    try {
      const res = await fetch(withBasePath("/api/profile/notifications"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updated),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        rollBack();
        setSaveError(data?.error ?? "Failed to save — please try again");
        return;
      }
      savedPrefsRef.current = updated;
      setSaved(true);
      router.refresh();
    } catch {
      rollBack();
      setSaveError("Network error — please try again");
    } finally {
      setSaving(false);
    }
  }

  function toggle(key: keyof AllPrefs) {
    const updated = { ...(pendingPrefsRef.current ?? prefs), [key]: !(pendingPrefsRef.current ?? prefs)[key] };
    setPrefs(updated);
    setSaveError(null);
    pendingPrefsRef.current = updated;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(flush, 400);
  }

  // Jellyfin: email a one-time verification link to the entered address. The
  // server only saves the address once that link is clicked, so nobody can point
  // notifications at an address they don't control.
  async function sendVerification() {
    const trimmed = emailInput.trim();
    if (trimmed === "" || !EMAIL_RE.test(trimmed)) {
      setEmailError("Please enter a valid email address");
      setEmailSavingState("error");
      return;
    }
    setEmailError(null);
    setEmailSavingState("saving");
    try {
      const res = await fetch(withBasePath("/api/profile/notification-email"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: trimmed }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setEmailError(data?.error ?? "Couldn't send verification email");
        setEmailSavingState("error");
        return;
      }
      setEmailSavingState("sent");
    } catch {
      setEmailError("Network error");
      setEmailSavingState("error");
    }
  }

  async function clearNotificationEmail() {
    setEmailError(null);
    setEmailSavingState("saving");
    try {
      const res = await fetch(withBasePath("/api/profile/notifications"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notificationEmail: null }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setEmailError(data?.error ?? "Failed to remove email");
        setEmailSavingState("error");
        return;
      }
      setEmailInput("");
      setEmailSavingState("idle");
      router.refresh();
    } catch {
      setEmailError("Network error");
      setEmailSavingState("error");
    }
  }

  return (
    <div className="space-y-6">
      {!discordLinked && !emailEnabled && (
        <div className="rounded-md border border-zinc-800 bg-zinc-900/50 p-3 text-xs text-zinc-400 flex items-start gap-2">
          <Bell className="w-4 h-4 shrink-0 text-zinc-500 mt-0.5" />
          <span>
            Browser/device push is the only notification channel available to you right now —
            enable it from the bell in the top bar. Link your Discord account to add another
            channel, or ask an admin to configure email delivery.
          </span>
        </div>
      )}

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

      {emailEnabled && (
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Mail className="w-4 h-4 text-zinc-400" />
            <p className="text-sm font-semibold text-zinc-400">Email</p>
          </div>

          {isJellyfin ? (
            <div className="py-3 border-b border-zinc-800">
              <label htmlFor="notificationEmail" className="text-sm font-medium text-zinc-200 block">
                Notification email address
              </label>
              <p className="text-xs text-zinc-500 mt-0.5 mb-2">
                Jellyfin accounts don&apos;t expose a verified email. Enter an address and we&apos;ll
                send a verification link — notifications start once you click it.
              </p>
              {notificationEmail && (
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-sm text-zinc-300 font-mono">{notificationEmail}</span>
                  <span className="text-[10px] uppercase tracking-wide text-green-400 border border-green-400/40 rounded px-1 py-0.5">verified</span>
                  <button
                    type="button"
                    onClick={clearNotificationEmail}
                    disabled={emailSavingState === "saving"}
                    className="text-[11px] text-zinc-500 hover:text-zinc-300 underline disabled:opacity-50"
                  >
                    Remove
                  </button>
                </div>
              )}
              <div className="flex gap-2">
                <input
                  id="notificationEmail"
                  type="email"
                  value={emailInput}
                  onChange={(e) => {
                    setEmailInput(e.target.value);
                    if (emailSavingState !== "idle") setEmailSavingState("idle");
                    if (emailError) setEmailError(null);
                  }}
                  placeholder={notificationEmail ? "change to a different address…" : "you@example.com"}
                  className="flex-1 rounded-md bg-zinc-950 border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                  autoComplete="email"
                  spellCheck={false}
                />
                <button
                  type="button"
                  onClick={sendVerification}
                  disabled={emailSavingState === "saving" || emailInput.trim() === ""}
                  className="rounded-md bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-800 disabled:text-zinc-500 disabled:cursor-not-allowed px-3 py-1.5 text-sm font-medium text-[var(--ds-accent-fg)] transition-colors whitespace-nowrap"
                >
                  {emailSavingState === "saving" ? <Loader2 className="w-4 h-4 animate-spin" /> : "Send verification"}
                </button>
              </div>
              {emailError && <p className="text-xs text-red-400 mt-1.5">{emailError}</p>}
              {emailSavingState === "sent" && !emailError && (
                <p className="text-xs text-green-400 mt-1.5 flex items-center gap-1">
                  <Check className="w-3 h-3" /> Verification email sent — check your inbox and click the link.
                </p>
              )}
            </div>
          ) : (
            <div className="py-3 border-b border-zinc-800">
              <p className="text-sm font-medium text-zinc-200">Notification email address</p>
              <p className="text-xs text-zinc-500 mt-0.5">
                Synced from your sign-in provider. Update it there to change where notifications are delivered.
              </p>
              <p className="text-sm text-zinc-300 mt-2 font-mono">
                {notificationEmail ?? <span className="text-zinc-500 italic font-sans">Not set</span>}
              </p>
            </div>
          )}

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
      )}

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

      {saveError ? (
        <p className="text-xs text-red-400 flex items-center gap-1">
          <AlertTriangle className="w-3 h-3" />
          {saveError}
        </p>
      ) : (saving || saved) && (
        <p className="text-xs text-zinc-500 flex items-center gap-1">
          {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3 text-green-400" />}
          {saving ? "Saving…" : "Saved"}
        </p>
      )}
    </div>
  );
}
