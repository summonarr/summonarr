"use client";

import { useState } from "react";
import { Loader2 } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { withBasePath } from "@/lib/base-path";
import { useT } from "@/components/i18n/i18n-provider";
import { useSecondFactorStepUp, type KnownSecondFactor } from "./use-second-factor-step-up";
import { SecondFactorCodeField } from "./second-factor-code-field";
import { timedFetch } from "@/lib/client/fetch-json";
import { useAsyncAction } from "@/hooks/use-async-action";

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
  secondFactor?: KnownSecondFactor;
}) {
  const t = useT();
  const action = useAsyncAction();
  const [confirming, setConfirming] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [password, setPassword] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // An account with no password (SSO) has nothing to confirm a factor against.
  const stepUp = useSecondFactorStepUp({
    known: secondFactor,
    applies: requiresPassword,
    failedMessage: t("profile.close.error.failed"),
  });

  // The word the user types is translated (a French user is not asked to type
  // DELETE), and the compare ignores case and surrounding whitespace.
  const confirmWord = t("profile.close.confirmWord");
  const confirmed = confirmText.trim().toUpperCase() === confirmWord.trim().toUpperCase();

  async function handleDelete() {
    if (action.busy("delete")) return;
    setError(null);
    setDeleting(true);
    type Outcome = { kind: "error"; message: string } | { kind: "stopped" } | { kind: "deleted" };
    const out = await action.run(
      "delete",
      async (signal): Promise<Outcome> => {
        try {
          const body: Record<string, unknown> = { password };
          if (stepUp.needsSecondFactor) {
            const r = await stepUp.secondFactorProof();
            if (!("proof" in r)) return r.error ? { kind: "error", message: r.error } : { kind: "stopped" };
            body.secondFactor = r.proof;
          }
          const res = await timedFetch(withBasePath("/api/profile"), {
            method: "DELETE",
            signal,
            ...(requiresPassword
              ? {
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(body),
                }
              : {}),
          });
          if (!res.ok) {
            // A passwordless web session whose sign-in is too old answers 401
            // { error: "session-too-old", message }: the sentence is what shows.
            const data: unknown = await res.json().catch(() => null);
            return { kind: "error", message: stepUp.refusalMessage(res, data, !!body.secondFactor, t("profile.close.error.failed")) };
          }
          return { kind: "deleted" };
        } catch {
          return { kind: "error", message: t("profile.close.error.retry") };
        }
      },
      { ifBusy: "skip" },
    );
    // The success path leaves the page; every other exit re-enables the button.
    if (out?.kind === "deleted") {
      window.location.href = withBasePath("/login");
      return;
    }
    setDeleting(false);
    if (out?.kind === "error") setError(out.message);
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
      {stepUp.needsSecondFactor && (
        <SecondFactorCodeField
          id="delete-stepup-code"
          value={stepUp.stepUpCode}
          onChange={stepUp.setStepUpCode}
          passkeyPossible={stepUp.passkeyPossible}
        />
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
            stepUp.setStepUpCode("");
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
