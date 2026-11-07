"use client";

import { useState } from "react";
import { Loader2 } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { withBasePath } from "@/lib/base-path";
import { rateLimitMessage } from "@/lib/client/rate-limit";
import { getPasskeyAssertion, isWebAuthnCancel, isWebAuthnSupported, type RequestOptionsJSON } from "@/lib/client/webauthn";
import { useT } from "@/components/i18n/i18n-provider";
import type { ChangePasswordSecondFactor } from "@/components/profile/change-password";

// Self-service "close account" (required by App Store Guideline 5.1.1(v)).
// It calls DELETE /api/profile, which DISABLES the account: every session is
// signed out and sign-in is refused from then on, but no data is erased, so an
// admin can restore it. The text below must not promise erasure — permanently
// erasing data is a separate admin action (see src/lib/account-lifecycle.ts,
// guardrail 33). The server has already ended our session, so we just go to /login.
//
// A password account with two-factor also confirms with a fresh second factor
// (src/app/api/profile/route.ts), like a password change: a code typed here, or a
// passkey when the field is left empty. The field shows from the start when the
// page knew 2FA was on, and otherwise once the server answers `secondFactorRequired`.
export function DeleteAccount({
  requiresPassword = false,
  secondFactor,
}: {
  requiresPassword?: boolean;
  secondFactor?: ChangePasswordSecondFactor;
}) {
  const t = useT();
  const [confirming, setConfirming] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [password, setPassword] = useState("");
  const [stepUpCode, setStepUpCode] = useState("");
  // The methods the server listed when it asked for a second factor.
  const [serverMethods, setServerMethods] = useState<string[] | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const needsSecondFactor = requiresPassword && (!!secondFactor?.enabled || serverMethods !== null);
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
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        data = await res.json().catch(() => ({}));
      } catch {
        setError(t("auth.login.error.network"));
        return null;
      }
      if (!res.ok) {
        setError(rateLimitMessage(res, t) ?? data.error ?? t("profile.close.error.failed"));
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
  // The word the user types is translated (a French user is not asked to type
  // DELETE), and the compare ignores case and surrounding whitespace.
  const confirmWord = t("profile.close.confirmWord");
  const confirmed = confirmText.trim().toUpperCase() === confirmWord.trim().toUpperCase();

  async function handleDelete() {
    setError(null);
    setDeleting(true);
    try {
      const body: Record<string, unknown> = { password };
      if (needsSecondFactor) {
        const proof = await secondFactorProof();
        if (!proof) {
          setDeleting(false);
          return;
        }
        body.secondFactor = proof;
      }
      // A code is single-use (a recovery code is consumed), so never resend one.
      setStepUpCode("");
      const res = await fetch(withBasePath("/api/profile"), {
        method: "DELETE",
        ...(requiresPassword
          ? {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            }
          : {}),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (data.secondFactorRequired) {
          if (Array.isArray(data.methods)) setServerMethods(data.methods as string[]);
          else setServerMethods((m) => m ?? []);
          // With no proof sent, ask for one here rather than show the generic text.
          if (!body.secondFactor) {
            setError(t("profile.mfa.stepUp.codeRequired"));
            setDeleting(false);
            return;
          }
        }
        // A two-factor lockout is a 429 with its own explanation and no Retry-After.
        const lockedOut = res.status === 429 && !!body.secondFactor && typeof data.error === "string";
        setError(lockedOut ? data.error : rateLimitMessage(res, t) ?? data.error ?? t("profile.close.error.failed"));
        setDeleting(false);
        return;
      }
      window.location.href = withBasePath("/login");
    } catch {
      setError(t("profile.close.error.retry"));
      setDeleting(false);
    }
  }

  if (!confirming) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-zinc-400">
          {t("profile.close.intro")}
        </p>
        <Button
          type="button"
          variant="destructive"
          onClick={() => setConfirming(true)}
          className="w-full sm:w-auto"
        >
          {t("profile.close.button")}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-zinc-400">
        {t("profile.close.confirmPrompt").split("{word}").map((part, i) => (
          <span key={i}>{i > 0 && <span className="font-semibold text-zinc-200">{confirmWord}</span>}{part}</span>
        ))}
      </p>
      <Input
        value={confirmText}
        onChange={(e) => setConfirmText(e.target.value)}
        placeholder={confirmWord}
        autoComplete="off"
        autoCapitalize="characters"
        aria-label={t("profile.close.confirmLabel", { word: confirmWord })}
      />
      {requiresPassword && (
        <Input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={t("profile.password.current")}
          autoComplete="current-password"
          aria-label={t("profile.password.current")}
        />
      )}
      {needsSecondFactor && (
        <div>
          <label className="block text-sm text-zinc-400 mb-1" htmlFor="delete-stepup-code">
            {t("profile.mfa.stepUp.label")}{" "}
            <span className="text-zinc-500">
              {passkeyPossible ? t("profile.mfa.stepUp.hintWithPasskey") : t("profile.mfa.stepUp.hint")}
            </span>
          </label>
          <Input
            id="delete-stepup-code"
            autoComplete="one-time-code"
            maxLength={24}
            value={stepUpCode}
            onChange={(e) => setStepUpCode(e.target.value)}
            className="w-56"
          />
        </div>
      )}
      {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="destructive"
          disabled={!confirmed || (requiresPassword && password.length === 0) || deleting}
          onClick={handleDelete}
          className="w-full sm:w-auto"
        >
          {deleting ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
          {deleting ? t("profile.close.closing") : t("profile.close.confirmButton")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={deleting}
          onClick={() => {
            setConfirming(false);
            setConfirmText("");
            setPassword("");
            setStepUpCode("");
            setError(null);
          }}
          className="w-full sm:w-auto"
        >
          {t("profile.common.cancel")}
        </Button>
      </div>
    </div>
  );
}
