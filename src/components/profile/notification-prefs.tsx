"use client";

import { useState, useRef, useEffect, useId } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2, MessageCircle, Mail, AlertTriangle, Bell, Smartphone } from "@/components/icons";
import { IOS_APP_STORE_URL } from "@/lib/ios-app";
import { withBasePath } from "@/lib/base-path";
import { useT } from "@/components/i18n/i18n-provider";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Chip } from "@/components/ui/design";

interface NotificationPrefsProps {
  // Worked out on the server: true only when the email feature is on, the
  // "Send notification emails" switch is on, and a mail sender is configured.
  // When false the whole Email section is hidden, since no email would be sent.
  emailEnabled: boolean;
  discordLinked: boolean;
  isAdminRole: boolean;
  isJellyfin: boolean;
  notificationEmail: string | null;
  // Jellyfin only: an address with a verification link outstanding (the page
  // reads it from the pending VerificationToken), so a reload still shows it.
  pendingEmail?: string | null;
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

type AllPrefs = Omit<NotificationPrefsProps, "emailEnabled" | "discordLinked" | "isAdminRole" | "isJellyfin" | "notificationEmail" | "pendingEmail">;

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
  // The switch has no text of its own; name it from the row label.
  const labelId = useId();
  return (
    <div className="flex items-start justify-between gap-4 py-3 border-b border-zinc-800 last:border-0">
      <div>
        <p id={labelId} className="text-sm font-medium text-zinc-200">{label}</p>
        <p className="text-xs text-zinc-500 mt-0.5">{description}</p>
      </div>
      <Switch aria-labelledby={labelId} checked={checked} disabled={disabled} onCheckedChange={onChange} />
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
  pendingEmail = null,
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
  const t = useT();
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
        setSaveError(data?.error ?? t("profile.error.saveFailed"));
        return;
      }
      savedPrefsRef.current = updated;
      setSaved(true);
      router.refresh();
    } catch {
      rollBack();
      setSaveError(t("profile.error.network"));
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
  // `address` is set by "Resend" for the pending address; otherwise the input.
  async function sendVerification(address?: string) {
    const trimmed = (address ?? emailInput).trim();
    if (trimmed === "" || !EMAIL_RE.test(trimmed)) {
      setEmailError(t("profile.notifications.error.invalidEmail"));
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
        setEmailError(data?.error ?? t("profile.notifications.error.sendVerification"));
        setEmailSavingState("error");
        return;
      }
      setEmailSavingState("sent");
      // The page re-reads the pending address so the "pending" line follows it.
      router.refresh();
    } catch {
      setEmailError(t("profile.notifications.error.network"));
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
        setEmailError(data?.error ?? t("profile.notifications.error.removeEmail"));
        setEmailSavingState("error");
        return;
      }
      setEmailInput("");
      setEmailSavingState("idle");
      router.refresh();
    } catch {
      setEmailError(t("profile.notifications.error.network"));
      setEmailSavingState("error");
    }
  }

  return (
    <div className="space-y-6">
      {!discordLinked && !emailEnabled && (
        <div className="rounded-md border border-zinc-800 bg-zinc-900/50 p-3 text-xs text-zinc-400 flex items-start gap-2">
          <Bell className="w-4 h-4 shrink-0 text-zinc-500 mt-0.5" />
          <span>
            {t("profile.notifications.pushOnly")}
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
            label={t("profile.notifications.approved")}
            description={t("profile.notifications.discord.approved")}
            checked={prefs.notifyOnApproved}
            onChange={() => toggle("notifyOnApproved")}
            disabled={saving}
          />
          <ToggleRow
            label={t("profile.notifications.available")}
            description={t("profile.notifications.discord.available")}
            checked={prefs.notifyOnAvailable}
            onChange={() => toggle("notifyOnAvailable")}
            disabled={saving}
          />
          <ToggleRow
            label={t("profile.notifications.declined")}
            description={t("profile.notifications.discord.declined")}
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
            <p className="text-sm font-semibold text-zinc-400">{t("profile.notifications.channel.email")}</p>
          </div>

          {isJellyfin ? (
            <div className="py-3 border-b border-zinc-800">
              <label htmlFor="notificationEmail" className="text-sm font-medium text-zinc-200 block">
                {t("profile.notifications.emailAddress")}
              </label>
              <p className="text-xs text-zinc-500 mt-0.5 mb-2">
                {t("profile.notifications.jellyfinEmailHint")}
              </p>
              {notificationEmail && (
                <div className="flex flex-wrap items-center gap-2 mb-2">
                  <span className="ds-mono text-sm text-zinc-300 break-all">{notificationEmail}</span>
                  <Chip tone="approved">{t("profile.notifications.verified")}</Chip>
                  <Button
                    type="button"
                    variant="link"
                    size="xs"
                    onClick={clearNotificationEmail}
                    disabled={emailSavingState === "saving"}
                    className="px-0 text-zinc-500 hover:text-zinc-300"
                  >
                    {t("profile.common.remove")}
                  </Button>
                </div>
              )}
              {pendingEmail && emailSavingState !== "sent" && (
                <div className="flex flex-wrap items-center gap-2 mb-2">
                  <span className="text-xs text-zinc-400">
                    {t("profile.notifications.verificationPending", { email: pendingEmail })}
                  </span>
                  <Button
                    type="button"
                    variant="link"
                    size="xs"
                    onClick={() => sendVerification(pendingEmail)}
                    disabled={emailSavingState === "saving"}
                    className="px-0"
                  >
                    {emailSavingState === "saving" ? <Loader2 className="w-3 h-3 animate-spin" /> : t("profile.notifications.resendVerification")}
                  </Button>
                </div>
              )}
              <div className="flex gap-2">
                <Input
                  id="notificationEmail"
                  type="email"
                  value={emailInput}
                  onChange={(e) => {
                    setEmailInput(e.target.value);
                    if (emailSavingState !== "idle") setEmailSavingState("idle");
                    if (emailError) setEmailError(null);
                  }}
                  placeholder={notificationEmail ? t("profile.notifications.changeAddress") : t("auth.field.emailPlaceholder")}
                  aria-invalid={emailError ? true : undefined}
                  className="flex-1"
                  autoComplete="email"
                  spellCheck={false}
                />
                <Button
                  type="button"
                  onClick={() => sendVerification()}
                  disabled={emailSavingState === "saving" || emailInput.trim() === ""}
                  className="shrink-0"
                >
                  {emailSavingState === "saving" ? <Loader2 className="w-4 h-4 animate-spin" /> : t("profile.notifications.sendVerification")}
                </Button>
              </div>
              {emailError && <p role="alert" className="text-xs text-red-400 mt-1.5">{emailError}</p>}
              {emailSavingState === "sent" && !emailError && (
                <p className="text-xs text-green-400 mt-1.5 flex items-center gap-1">
                  <Check className="w-3 h-3" /> {t("profile.notifications.verificationSent")}
                </p>
              )}
            </div>
          ) : (
            <div className="py-3 border-b border-zinc-800">
              <p className="text-sm font-medium text-zinc-200">{t("profile.notifications.emailAddress")}</p>
              <p className="text-xs text-zinc-500 mt-0.5">
                {t("profile.notifications.syncedHint")}
              </p>
              <p className="ds-mono text-sm text-zinc-300 mt-2 break-all">
                {notificationEmail ?? <span className="text-zinc-500 italic font-sans">{t("profile.notifications.notSet")}</span>}
              </p>
            </div>
          )}

          <ToggleRow
            label={t("profile.notifications.approved")}
            description={t("profile.notifications.email.approved")}
            checked={prefs.emailOnApproved}
            onChange={() => toggle("emailOnApproved")}
            disabled={saving}
          />
          <ToggleRow
            label={t("profile.notifications.available")}
            description={t("profile.notifications.email.available")}
            checked={prefs.emailOnAvailable}
            onChange={() => toggle("emailOnAvailable")}
            disabled={saving}
          />
          <ToggleRow
            label={t("profile.notifications.declined")}
            description={t("profile.notifications.email.declined")}
            checked={prefs.emailOnDeclined}
            onChange={() => toggle("emailOnDeclined")}
            disabled={saving}
          />
        </div>
      )}

      <div>
        <div className="flex items-center gap-2 mb-1">
          <Bell className="w-4 h-4 text-zinc-400" />
          <p className="text-sm font-semibold text-zinc-400">{t("profile.notifications.channel.push")}</p>
        </div>
        <ToggleRow
          label={t("profile.notifications.approved")}
          description={t("profile.notifications.push.approved")}
          checked={prefs.pushOnApproved}
          onChange={() => toggle("pushOnApproved")}
          disabled={saving}
        />
        <ToggleRow
          label={t("profile.notifications.available")}
          description={t("profile.notifications.push.available")}
          checked={prefs.pushOnAvailable}
          onChange={() => toggle("pushOnAvailable")}
          disabled={saving}
        />
        <ToggleRow
          label={t("profile.notifications.declined")}
          description={t("profile.notifications.push.declined")}
          checked={prefs.pushOnDeclined}
          onChange={() => toggle("pushOnDeclined")}
          disabled={saving}
        />
        <p className="mt-2 flex items-start gap-2 text-xs text-zinc-500">
          <Smartphone className="mt-0.5 w-3.5 h-3.5 shrink-0" />
          <span>
            {t("profile.notifications.iosApp.prompt")}{" "}
            <a href={IOS_APP_STORE_URL} target="_blank" rel="noopener noreferrer" className="text-indigo-400 hover:underline">
              {t("profile.notifications.iosApp.link")}
            </a>
          </span>
        </p>
      </div>

      {isAdminRole && (
        <div>
          <div className="flex items-center gap-2 mb-1">
            <AlertTriangle className="w-4 h-4 text-yellow-400" />
            <p className="text-sm font-semibold text-yellow-400">{t("profile.notifications.channel.issues")}</p>
          </div>
          <ToggleRow
            label={t("profile.notifications.issues")}
            description={t("profile.notifications.issuesHint")}
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
          {saving ? t("profile.common.saving") : t("profile.common.saved")}
        </p>
      )}
    </div>
  );
}
