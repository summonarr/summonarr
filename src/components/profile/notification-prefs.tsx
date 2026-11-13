"use client";

import { useState, useRef, useEffect, useId } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2, MessageCircle, Mail, AlertTriangle, Bell, Smartphone } from "@/components/icons";
import { IOS_APP_STORE_URL } from "@/lib/ios-app";
import { withBasePath } from "@/lib/base-path";
import { rateLimitMessage } from "@/lib/client/rate-limit";
import { readApiError } from "@/lib/client/api-error";
import { jsonInit, timedFetch } from "@/lib/client/fetch-json";
import { useT } from "@/components/i18n/i18n-provider";
import type { Translator } from "@/lib/i18n/translate";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Chip } from "@/components/ui/design";
import { StepUpPasswordForm } from "@/components/profile/step-up-password-form";
import { stepUpNeedOf, withStepUpPassword } from "@/lib/client/step-up";
import { PLAUSIBLE_EMAIL_RE } from "@/lib/email-normalize";
import { applyDelta, revertFailed, type PrefDelta } from "./notification-prefs-delta";

// The stored on/off preference per channel × event (User columns, and the body
// PATCH /api/profile/notifications takes).
export interface NotificationPrefValues {
  notifyOnApproved: boolean;
  notifyOnAvailable: boolean;
  notifyOnDeclined: boolean;
  notifyOnComment: boolean;
  emailOnApproved: boolean;
  emailOnAvailable: boolean;
  emailOnDeclined: boolean;
  emailOnComment: boolean;
  pushOnApproved: boolean;
  pushOnAvailable: boolean;
  pushOnDeclined: boolean;
  pushOnComment: boolean;
  notifyOnIssue: boolean;
}
type PrefKey = keyof NotificationPrefValues;

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
  prefs: NotificationPrefValues;
}

interface PrefRow {
  key: PrefKey;
  label: string;
  hint: string;
}

function ToggleRow({
  label,
  description,
  checked,
  onChange,
  busy,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: () => void;
  busy: boolean;
}) {
  // The switch has no text of its own; name it from the row label.
  const labelId = useId();
  // Never natively disabled while a save runs: the switch a keyboard user just
  // flipped would lose focus to the page. A flip during a save is queued.
  return (
    <div className="flex items-start justify-between gap-4 py-3 border-b border-zinc-800 last:border-0">
      <div>
        <p id={labelId} className="text-sm font-medium text-zinc-200">{label}</p>
        <p className="text-xs text-zinc-500 mt-0.5">{description}</p>
      </div>
      <Switch aria-labelledby={labelId} aria-busy={busy || undefined} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

// A string field of a parsed error body, if it is one.
function textField(body: unknown, key: "message" | "error"): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "string" && value ? value : undefined;
}

// The switches' state and its autosave. Each flip shows immediately and is
// saved 400ms later (so quick flips are sent together), and is undone if the
// save fails. A save sends only the switches flipped since the last one
// (notification-prefs-delta.ts): the route writes every boolean it receives,
// so the whole set from this tab would undo a change made meanwhile in another
// tab or the iOS app.
function usePrefsAutosave(initialPrefs: NotificationPrefValues, t: Translator) {
  const [prefs, setPrefs] = useState<NotificationPrefValues>(initialPrefs);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Flips not yet sent.
  const pendingRef = useRef<PrefDelta<NotificationPrefValues> | null>(null);
  // Last state the server confirmed — a failed save's switches revert here.
  const savedPrefsRef = useRef<NotificationPrefValues>(initialPrefs);
  // One save at a time: a flip made while a save is in flight waits for it, so
  // an older answer can never land after a newer one and move savedPrefsRef back.
  const inFlightRef = useRef(false);

  useEffect(() => {
    // Copy the ref objects themselves (not their .current values) so the
    // cleanup reads whatever is pending at the moment the component unmounts.
    const timer = saveTimerRef;
    const pendingDelta = pendingRef;
    return () => {
      if (timer.current) clearTimeout(timer.current);
      const pending = pendingDelta.current;
      if (!pending) return;
      // There is no Save button: flipping a switch IS the save, and the switch
      // has already moved on screen. A toggle made less than 400ms before
      // leaving the page is still waiting on the timer, so send it now instead
      // of dropping it. `keepalive` lets the request finish after the page is
      // gone. Same as the unmount save in settings/features-form.tsx.
      void timedFetch(withBasePath("/api/profile/notifications"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pending),
        keepalive: true,
      }).catch(() => {});
    };
  }, []);

  async function flush() {
    // The save in flight sends this one when it settles (see finally).
    if (inFlightRef.current) return;
    const delta = pendingRef.current;
    if (!delta) return;
    pendingRef.current = null;
    inFlightRef.current = true;
    setSaving(true);
    setSaved(false);
    setSaveError(null);
    // Put the failed switches back to the last state the server confirmed, so
    // the UI never shows a position the server rejected.
    const rollBack = () => setPrefs((cur) => revertFailed(cur, savedPrefsRef.current, delta, pendingRef.current));
    try {
      const res = await timedFetch(withBasePath("/api/profile/notifications"), jsonInit("PATCH", delta));
      if (!res.ok) {
        rollBack();
        setSaveError(rateLimitMessage(res, t) ?? (await readApiError(res, t("profile.error.saveFailed"))));
        return;
      }
      savedPrefsRef.current = applyDelta(savedPrefsRef.current, delta);
      // No page refresh: these switches are the only copy on the page, so
      // re-rendering the whole profile server-side per flip bought nothing.
      setSaved(true);
    } catch {
      rollBack();
      setSaveError(t("profile.error.network"));
    } finally {
      inFlightRef.current = false;
      setSaving(false);
      // Flips made during this save whose debounce already ran: send them now.
      // One still debouncing flushes on its own.
      if (pendingRef.current && !saveTimerRef.current) void flush();
    }
  }

  function toggle(key: PrefKey) {
    // The value on screen: a flip still pending in this tick wins over the
    // render's `prefs`, so two quick flips of one switch cancel out.
    const shown = pendingRef.current && key in pendingRef.current ? pendingRef.current[key]! : prefs[key];
    const next = !shown;
    setPrefs((cur) => ({ ...cur, [key]: next }));
    setSaveError(null);
    pendingRef.current = { ...pendingRef.current, [key]: next };
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      void flush();
    }, 400);
  }

  return { prefs, toggle, saving, saved, saveError };
}

// Jellyfin only: the self-service notification address. A Jellyfin account has
// no provider-verified email, so a new address is bound only through a
// one-time verification link; the current verified one can be removed.
function JellyfinEmailField({
  notificationEmail,
  pendingEmail,
  t,
}: {
  notificationEmail: string | null;
  pendingEmail: string | null;
  t: Translator;
}) {
  const router = useRouter();
  // The input holds a NEW address to verify; the current verified address is
  // shown separately from the `notificationEmail` prop.
  const [emailInput, setEmailInput] = useState("");
  const [emailSavingState, setEmailSavingState] = useState<"idle" | "saving" | "sent" | "error">("idle");
  const [emailError, setEmailError] = useState<string | null>(null);
  // Sending a verification link needs a step-up (guardrail 6g): the server
  // answers "password-required" and the password is asked for inline. Holds the
  // address being verified while the prompt is open (the input, or the pending
  // address on "Resend"), so the confirmed retry sends the same one.
  const [stepUpAddress, setStepUpAddress] = useState<string | null>(null);
  const [stepUpError, setStepUpError] = useState<string | null>(null);

  // Email a one-time verification link to the entered address. The server only
  // saves the address once that link is clicked, so nobody can point
  // notifications at an address they don't control. `address` is set by
  // "Resend" for the pending address; otherwise the input.
  async function sendVerification(address?: string, confirmPassword?: string) {
    const trimmed = (address ?? emailInput).trim();
    if (trimmed === "" || !PLAUSIBLE_EMAIL_RE.test(trimmed)) {
      setEmailError(t("profile.notifications.error.invalidEmail"));
      setEmailSavingState("error");
      return;
    }
    setEmailError(null);
    setEmailSavingState("saving");
    try {
      const res = await timedFetch(
        withBasePath("/api/profile/notification-email"),
        jsonInit("POST", withStepUpPassword({ email: trimmed }, confirmPassword)),
      );
      const data: unknown = await res.json().catch(() => null);
      const need = stepUpNeedOf(res.status, data);
      if (need) {
        setStepUpAddress(trimmed);
        setStepUpError(need === "retry" ? t("profile.sessions.error.incorrectPassword") : null);
        setEmailSavingState("idle");
        return;
      }
      if (!res.ok) {
        // Not a password refusal: an earlier "Incorrect password." must not
        // stay in the prompt beside this error.
        setStepUpError(null);
        // `message` first: a step-up refusal ("session-too-old", "rate_limit")
        // carries its sentence there and a machine code in `error`.
        setEmailError(
          textField(data, "message") ??
            rateLimitMessage(res, t) ??
            textField(data, "error") ??
            t("profile.notifications.error.sendVerification"),
        );
        setEmailSavingState("error");
        return;
      }
      setStepUpAddress(null);
      setStepUpError(null);
      setEmailSavingState("sent");
      // The page re-reads the pending address so the "pending" line follows it.
      router.refresh();
    } catch {
      setStepUpError(null);
      setEmailError(t("profile.notifications.error.network"));
      setEmailSavingState("error");
    }
  }

  async function clearNotificationEmail() {
    setEmailError(null);
    setEmailSavingState("saving");
    try {
      const res = await timedFetch(withBasePath("/api/profile/notifications"), jsonInit("PATCH", { notificationEmail: null }));
      if (!res.ok) {
        setEmailError(rateLimitMessage(res, t) ?? (await readApiError(res, t("profile.notifications.error.removeEmail"))));
        setEmailSavingState("error");
        return;
      }
      setEmailInput("");
      setEmailSavingState("idle");
      // The verified address is a server-rendered prop.
      router.refresh();
    } catch {
      setEmailError(t("profile.notifications.error.network"));
      setEmailSavingState("error");
    }
  }

  return (
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
      {stepUpAddress !== null ? (
        <StepUpPasswordForm
          busy={emailSavingState === "saving"}
          error={stepUpError}
          onSubmit={(password) => void sendVerification(stepUpAddress, password)}
          onCancel={() => { setStepUpAddress(null); setStepUpError(null); }}
        />
      ) : (
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
      )}
      {emailError && <p role="alert" className="text-xs text-red-400 mt-1.5">{emailError}</p>}
      {emailSavingState === "sent" && !emailError && (
        <p className="text-xs text-green-400 mt-1.5 flex items-center gap-1">
          <Check className="w-3 h-3" /> {t("profile.notifications.verificationSent")}
        </p>
      )}
    </div>
  );
}

// Notification on/off switches per channel (Discord, email, push), saved as
// they flip (usePrefsAutosave). Also holds the Jellyfin-only field for setting
// a notification email address.
export function NotificationPrefs({
  emailEnabled,
  discordLinked,
  isAdminRole,
  isJellyfin,
  notificationEmail,
  pendingEmail = null,
  prefs: initialPrefs,
}: NotificationPrefsProps) {
  const t = useT();
  const { prefs, toggle, saving, saved, saveError } = usePrefsAutosave(initialPrefs, t);

  // Literal keys per row, so the i18n usage and dead-string checks see them.
  const discordRows: PrefRow[] = [
    { key: "notifyOnApproved", label: t("profile.notifications.approved"), hint: t("profile.notifications.discord.approved") },
    { key: "notifyOnAvailable", label: t("profile.notifications.available"), hint: t("profile.notifications.discord.available") },
    { key: "notifyOnDeclined", label: t("profile.notifications.declined"), hint: t("profile.notifications.discord.declined") },
    { key: "notifyOnComment", label: t("profile.notifications.comments"), hint: t("profile.notifications.discord.comments") },
  ];
  const emailRows: PrefRow[] = [
    { key: "emailOnApproved", label: t("profile.notifications.approved"), hint: t("profile.notifications.email.approved") },
    { key: "emailOnAvailable", label: t("profile.notifications.available"), hint: t("profile.notifications.email.available") },
    { key: "emailOnDeclined", label: t("profile.notifications.declined"), hint: t("profile.notifications.email.declined") },
    { key: "emailOnComment", label: t("profile.notifications.comments"), hint: t("profile.notifications.email.comments") },
  ];
  const pushRows: PrefRow[] = [
    { key: "pushOnApproved", label: t("profile.notifications.approved"), hint: t("profile.notifications.push.approved") },
    { key: "pushOnAvailable", label: t("profile.notifications.available"), hint: t("profile.notifications.push.available") },
    { key: "pushOnDeclined", label: t("profile.notifications.declined"), hint: t("profile.notifications.push.declined") },
    { key: "pushOnComment", label: t("profile.notifications.comments"), hint: t("profile.notifications.push.comments") },
  ];
  const issueRows: PrefRow[] = [
    { key: "notifyOnIssue", label: t("profile.notifications.issues"), hint: t("profile.notifications.issuesHint") },
  ];
  const toggleRows = (rows: PrefRow[]) =>
    rows.map((r) => (
      <ToggleRow key={r.key} label={r.label} description={r.hint} checked={prefs[r.key]} onChange={() => toggle(r.key)} busy={saving} />
    ));

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
          {toggleRows(discordRows)}
        </div>
      )}

      {emailEnabled && (
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Mail className="w-4 h-4 text-zinc-400" />
            <p className="text-sm font-semibold text-zinc-400">{t("profile.notifications.channel.email")}</p>
          </div>

          {isJellyfin ? (
            <JellyfinEmailField notificationEmail={notificationEmail} pendingEmail={pendingEmail} t={t} />
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

          {toggleRows(emailRows)}
        </div>
      )}

      <div>
        <div className="flex items-center gap-2 mb-1">
          <Bell className="w-4 h-4 text-zinc-400" />
          <p className="text-sm font-semibold text-zinc-400">{t("profile.notifications.channel.push")}</p>
        </div>
        {toggleRows(pushRows)}
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
          {toggleRows(issueRows)}
        </div>
      )}

      {saveError ? (
        <p role="alert" className="text-xs text-red-400 flex items-center gap-1">
          <AlertTriangle className="w-3 h-3" />
          {saveError}
        </p>
      ) : (saving || saved) && (
        <p role="status" className="text-xs text-zinc-500 flex items-center gap-1">
          {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3 text-green-400" />}
          {saving ? t("profile.common.saving") : t("profile.common.saved")}
        </p>
      )}
    </div>
  );
}
