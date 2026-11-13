"use client";

import { useState } from "react";
import { Loader2 } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { withBasePath } from "@/lib/base-path";
import { useT } from "@/components/i18n/i18n-provider";
import { MIN_PASSWORD_LENGTH } from "@/lib/password-policy";
import { useSecondFactorStepUp, type KnownSecondFactor } from "./use-second-factor-step-up";
import { SecondFactorCodeField } from "./second-factor-code-field";
import { timedFetch } from "@/lib/client/fetch-json";
import { useAsyncAction } from "@/hooks/use-async-action";

// What the page knows about the account's two-factor setup when it rendered.
export type ChangePasswordSecondFactor = KnownSecondFactor;

interface ChangePasswordProps {
  // Accepted for the profile page, which still passes it; nothing here reads
  // it. The route refuses (403) any account with no local password, so there
  // is no "set a password" form to show: the current password is always asked.
  hasPassword?: boolean;
  secondFactor?: ChangePasswordSecondFactor;
}

// Form to change the password. A successful change signs every session out
// (the route always answers `requiresRelogin`), so it ends on /login and there
// is no "saved" state to show here.
//
// An account with two-factor also confirms the change with a fresh second factor
// (the server enforces it — src/app/api/profile/password/route.ts): a code typed
// here, or a passkey when the field is left empty. The field shows from the
// start when the page knew 2FA was on, and otherwise as soon as the server
// answers `secondFactorRequired` (2FA turned on in another tab, say).
export function ChangePassword({ secondFactor }: ChangePasswordProps) {
  const t = useT();
  const action = useAsyncAction();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword]         = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [saving, setSaving]   = useState(false);
  const [error, setError]     = useState<string | null>(null);
  const stepUp = useSecondFactorStepUp({ known: secondFactor, failedMessage: t("profile.password.error.failed") });

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (newPassword !== confirmPassword) {
      setError(t("profile.password.error.mismatch"));
      return;
    }

    if (action.busy("save")) return;
    setSaving(true);
    type Outcome =
      | { kind: "error"; message: string }
      | { kind: "stopped" }
      | { kind: "relogin" };
    const out = await action.run(
      "save",
      async (signal): Promise<Outcome> => {
        try {
          const body: Record<string, unknown> = { currentPassword, newPassword };
          if (stepUp.needsSecondFactor) {
            const r = await stepUp.secondFactorProof();
            if (!("proof" in r)) return r.error ? { kind: "error", message: r.error } : { kind: "stopped" };
            body.secondFactor = r.proof;
          }

          const res = await timedFetch(withBasePath("/api/profile/password"), {
            method:  "PATCH",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify(body),
            signal,
          });
          const data: unknown = await res.json().catch(() => null);
          if (!res.ok) {
            return { kind: "error", message: stepUp.refusalMessage(res, data, !!body.secondFactor, t("profile.password.error.failed")) };
          }
          // Every 2xx carries `requiresRelogin`: the change revoked this session too.
          return { kind: "relogin" };
        } catch {
          // A network error. A body that isn't JSON (a proxy's page) is read as
          // no body above. Without this catch the form would show nothing at all.
          //
          // The message mentions sign-out because the server signs out every
          // session when the password changes. If the change saved but only the
          // response was lost, the user is already signed out everywhere.
          return { kind: "error", message: t("profile.password.error.network") };
        }
      },
      { ifBusy: "skip" },
    );
    setSaving(false);
    if (!out) return;
    if (out.kind === "error") setError(out.message);
    else if (out.kind === "relogin") window.location.href = withBasePath("/login");
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
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

      <Button
        type="submit"
        disabled={saving}
        className="w-full sm:w-auto"
      >
        {saving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
        {saving ? t("profile.common.saving") : t("profile.password.update")}
      </Button>
    </form>
  );
}
