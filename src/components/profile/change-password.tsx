"use client";

import { useState } from "react";
import { Loader2, Check } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { withBasePath } from "@/lib/base-path";
import { rateLimitMessage } from "@/lib/client/rate-limit";
import { getPasskeyAssertion, isWebAuthnCancel, isWebAuthnSupported, type RequestOptionsJSON } from "@/lib/client/webauthn";
import { useT } from "@/components/i18n/i18n-provider";

// What the page knows about the account's two-factor setup when it rendered.
export interface ChangePasswordSecondFactor {
  enabled: boolean;
  hasPasskeys: boolean;
  webauthnAvailable: boolean;
}

interface ChangePasswordProps {
  hasPassword: boolean;
  secondFactor?: ChangePasswordSecondFactor;
}

// Form to set or change the password. If the account already has one
// (hasPassword), the current password is required too. When the server answers
// `requiresRelogin`, we send the user to /login.
//
// An account with two-factor also confirms the change with a fresh second factor
// (the server enforces it — src/app/api/profile/password/route.ts): a code typed
// here, or a passkey when the field is left empty. The field shows from the
// start when the page knew 2FA was on, and otherwise as soon as the server
// answers `secondFactorRequired` (2FA turned on in another tab, say).
export function ChangePassword({ hasPassword, secondFactor }: ChangePasswordProps) {
  const t = useT();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword]         = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [stepUpCode, setStepUpCode]           = useState("");
  // The methods the server listed when it asked for a second factor.
  const [serverMethods, setServerMethods]     = useState<string[] | null>(null);
  const [saving, setSaving]   = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError]     = useState<string | null>(null);

  const needsSecondFactor = !!secondFactor?.enabled || serverMethods !== null;
  const passkeyPossible =
    (!!secondFactor?.hasPasskeys && !!secondFactor.webauthnAvailable) || !!serverMethods?.includes("webauthn");

  // The `secondFactor` body field, or null when the user must act first (an
  // error is already shown).
  async function secondFactorProof(): Promise<Record<string, unknown> | null> {
    const code = stepUpCode.trim();
    if (code.length > 0) {
      const digits = code.replace(/\s/g, "");
      return { method: /^\d{6}$/.test(digits) ? "totp" : "recovery", code };
    }
    if (passkeyPossible && isWebAuthnSupported()) {
      let res: Response;
      let data: { error?: string; publicKey?: unknown; challengeToken?: unknown };
      try {
        res = await fetch(withBasePath("/api/profile/mfa/challenge"), {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    "{}",
        });
        data = await res.json().catch(() => ({}));
      } catch {
        // Nothing was sent yet, so unlike the change itself there is no sign-out to warn about.
        setError(t("auth.login.error.network"));
        return null;
      }
      if (!res.ok) {
        setError(rateLimitMessage(res, t) ?? data.error ?? t("profile.password.error.failed"));
        return null;
      }
      try {
        const credential = await getPasskeyAssertion(data.publicKey as RequestOptionsJSON);
        return { method: "webauthn", credential, challengeToken: data.challengeToken };
      } catch (err) {
        if (!isWebAuthnCancel(err)) setError(t("profile.mfa.stepUp.passkeyFailed"));
        return null;
      }
    }
    setError(t("profile.mfa.stepUp.codeRequired"));
    return null;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(false);

    if (newPassword !== confirmPassword) {
      setError(t("profile.password.error.mismatch"));
      return;
    }

    setSaving(true);
    try {
      const body: Record<string, unknown> = { newPassword };
      if (hasPassword) body.currentPassword = currentPassword;
      if (needsSecondFactor) {
        const proof = await secondFactorProof();
        if (!proof) return;
        body.secondFactor = proof;
      }
      // A code is single-use (a recovery code is consumed), so never resend one.
      setStepUpCode("");

      const res = await fetch(withBasePath("/api/profile/password"), {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (data.secondFactorRequired) {
          if (Array.isArray(data.methods)) setServerMethods(data.methods as string[]);
          else setServerMethods((m) => m ?? []);
          // With no proof sent, the server's text is written for clients that
          // can't ask for a code; this form can, so say what to do here.
          if (!body.secondFactor) {
            setError(t("profile.mfa.stepUp.codeRequired"));
            return;
          }
        }
        // A two-factor lockout is a 429 with its own explanation and no Retry-After.
        const lockedOut = res.status === 429 && !!body.secondFactor && typeof data.error === "string";
        setError(lockedOut ? data.error : rateLimitMessage(res, t) ?? data.error ?? t("profile.password.error.failed"));
        return;
      }
      const data = await res.json().catch(() => ({}));
      if (data.requiresRelogin) {
        window.location.href = withBasePath("/login");
        return;
      }
      setSuccess(true);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch {
      // The fetch can fail on a network error, and res.json() can fail if a
      // proxy returns a non-JSON body. Without this catch the form would show
      // nothing at all.
      //
      // The message mentions sign-out because the server signs out every
      // session when the password changes. If the change saved but only the
      // response was lost, the user is already signed out everywhere.
      setError(t("profile.password.error.network"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      {hasPassword && (
        <div>
          <label className="block text-sm text-zinc-400 mb-1" htmlFor="current-password">
            {t("profile.password.current")}
          </label>
          <Input
            id="current-password"
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            required
          />
        </div>
      )}

      <div>
        <label className="block text-sm text-zinc-400 mb-1" htmlFor="new-password">
          {t("profile.password.new")}
        </label>
        <Input
          id="new-password"
          type="password"
          autoComplete="new-password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          placeholder={t("profile.password.minLength", { count: 12 })}
          minLength={12}
          required
        />
      </div>

      <div>
        <label className="block text-sm text-zinc-400 mb-1" htmlFor="confirm-password">
          {t("profile.password.confirm")}
        </label>
        <Input
          id="confirm-password"
          type="password"
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          minLength={12}
          required
        />
      </div>

      {needsSecondFactor && (
        <div>
          <label className="block text-sm text-zinc-400 mb-1" htmlFor="password-stepup-code">
            {t("profile.mfa.stepUp.label")}{" "}
            <span className="text-zinc-500">
              {passkeyPossible ? t("profile.mfa.stepUp.hintWithPasskey") : t("profile.mfa.stepUp.hint")}
            </span>
          </label>
          <Input
            id="password-stepup-code"
            autoComplete="one-time-code"
            maxLength={24}
            value={stepUpCode}
            onChange={(e) => setStepUpCode(e.target.value)}
            className="w-56"
          />
        </div>
      )}

      {error && <p className="text-sm text-red-400">{error}</p>}

      {success && (
        <p className="flex items-center gap-1.5 text-sm text-emerald-400">
          <Check className="w-4 h-4" /> {hasPassword ? t("profile.password.updated") : t("profile.password.setDone")}
        </p>
      )}

      <Button
        type="submit"
        disabled={saving}
        className="w-full sm:w-auto"
      >
        {saving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
        {saving ? t("profile.common.saving") : hasPassword ? t("profile.password.update") : t("profile.password.set")}
      </Button>
    </form>
  );
}
