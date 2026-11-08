"use client";

import { useState } from "react";
import { Loader2, Check } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { withBasePath } from "@/lib/base-path";
import { useT } from "@/components/i18n/i18n-provider";
import { MIN_PASSWORD_LENGTH } from "@/lib/password-policy";
import { useSecondFactorStepUp, type KnownSecondFactor } from "./use-second-factor-step-up";
import { SecondFactorCodeField } from "./second-factor-code-field";

// What the page knows about the account's two-factor setup when it rendered.
export type ChangePasswordSecondFactor = KnownSecondFactor;

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
  const [saving, setSaving]   = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError]     = useState<string | null>(null);
  const stepUp = useSecondFactorStepUp({ known: secondFactor, failedMessage: t("profile.password.error.failed") });

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
      if (stepUp.needsSecondFactor) {
        const r = await stepUp.secondFactorProof();
        if (!("proof" in r)) {
          if (r.error) setError(r.error);
          return;
        }
        body.secondFactor = r.proof;
      }

      const res = await fetch(withBasePath("/api/profile/password"), {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(body),
      });
      const data: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        setError(stepUp.refusalMessage(res, data, !!body.secondFactor, t("profile.password.error.failed")));
        return;
      }
      if (data && typeof data === "object" && (data as { requiresRelogin?: unknown }).requiresRelogin === true) {
        window.location.href = withBasePath("/login");
        return;
      }
      setSuccess(true);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch {
      // A network error. A body that isn't JSON (a proxy's page) is read as
      // no body above. Without this catch the form would show nothing at all.
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
          placeholder={t("profile.password.minLength", { count: MIN_PASSWORD_LENGTH })}
          minLength={MIN_PASSWORD_LENGTH}
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
          minLength={MIN_PASSWORD_LENGTH}
          required
        />
      </div>

      {stepUp.needsSecondFactor && (
        <SecondFactorCodeField
          id="password-stepup-code"
          value={stepUp.stepUpCode}
          onChange={stepUp.setStepUpCode}
          passkeyPossible={stepUp.passkeyPossible}
        />
      )}

      {error && <p role="alert" className="text-sm text-red-400">{error}</p>}

      {success && (
        <p role="status" className="flex items-center gap-1.5 text-sm text-emerald-400">
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
