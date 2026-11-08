"use client";

// Second step of a password sign-in for an account with two-factor enabled.
// Everything decisive happens server-side at POST /api/auth/sign-in/mfa: the
// password step only ever handed back a challenge, never a session (guardrail 6d).
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2 } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import { apiErrorText } from "@/lib/client/api-error";
import { fetchJson, jsonInit } from "@/lib/client/fetch-json";
import {
  initialMfaMethod,
  MFA_HINT_KEYS,
  MFA_SWITCH_KEYS,
  type MfaChallenge,
  type MfaMethod,
} from "@/lib/client/login-answers";
import { getPasskeyAssertion, isWebAuthnCancel, isWebAuthnSupported } from "@/lib/client/webauthn";
import { useT } from "@/components/i18n/i18n-provider";
import { ErrorText, Field, SecondaryAction } from "./login-parts";

export function MfaStep({
  challenge,
  onSuccess,
  onRestart,
}: {
  challenge: MfaChallenge;
  onSuccess: () => Promise<void>;
  onRestart: (message?: string) => void;
}) {
  const t = useT();
  const [method, setMethod] = useState<MfaMethod>(() => initialMfaMethod(challenge.methods));
  const [code, setCode] = useState("");
  // Covers the whole attempt, the passkey ceremony included: a second click
  // during navigator.credentials.get started another ceremony, which the browser
  // refuses with NotAllowedError — read as a cancel, so nothing was shown.
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Sends one second factor. Resolves after the answer is applied; on success
  // busy stays set while onSuccess navigates away.
  async function submit(body: Record<string, unknown>) {
    const res = await fetchJson(withBasePath("/api/auth/sign-in/mfa"), {
      init: { ...jsonInit("POST", { mfaToken: challenge.mfaToken, ...body }), credentials: "include" },
      fallbackError: t("auth.mfa.error.failed"),
    });
    if (res.ok) {
      await onSuccess();
      return;
    }
    if (res.kind === "network" || res.kind === "timeout") {
      setError(t("auth.login.error.network"));
      setBusy(false);
      return;
    }
    const answer = res.body && typeof res.body === "object" ? (res.body as { mfaExpired?: unknown }) : null;
    if (answer?.mfaExpired === true) {
      onRestart(apiErrorText(res.body, t("auth.mfa.error.expired")));
      return;
    }
    setError(res.error);
    setCode("");
    setBusy(false);
  }

  async function submitCode() {
    if (busy) return;
    setBusy(true);
    setError("");
    await submit({ method, code });
  }

  async function handlePasskey() {
    if (busy) return;
    if (!challenge.webauthn) {
      // The challenge listed passkeys but carried no options to use one with.
      setError(t("auth.mfa.error.passkeyFailed"));
      return;
    }
    if (!isWebAuthnSupported()) {
      setError(t("auth.mfa.error.passkeyUnsupported"));
      return;
    }
    setBusy(true);
    setError("");
    let credential: Record<string, unknown>;
    try {
      credential = await getPasskeyAssertion(challenge.webauthn);
    } catch (err) {
      if (!isWebAuthnCancel(err)) setError(t("auth.mfa.error.passkeyFailed"));
      setBusy(false);
      return;
    }
    await submit({ method: "webauthn", credential });
  }

  const noMethods = challenge.methods.length === 0;
  const codeMethod = method === "totp" || method === "recovery";

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <p className="text-sm font-medium m-0" style={{ color: "var(--ds-fg)" }}>{t("auth.mfa.title")}</p>
        <p className="text-sm m-0" style={{ color: "var(--ds-fg-muted)" }}>
          {t(noMethods ? "auth.mfa.noMethods" : MFA_HINT_KEYS[method])}
        </p>
      </div>

      {method === "webauthn" && challenge.methods.includes("webauthn") && (
        <Button type="button" onClick={handlePasskey} disabled={busy} className="w-full min-h-11">
          {busy ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />{t("auth.mfa.verifying")}</> : t("auth.mfa.usePasskeyButton")}
        </Button>
      )}

      {codeMethod && challenge.methods.includes(method) && (
        <MfaCodeForm method={method} code={code} setCode={setCode} busy={busy} onSubmit={submitCode} />
      )}

      <ErrorText error={error} />

      <div className="flex flex-col gap-1">
        {challenge.methods.filter((m) => m !== method).map((m) => (
          <SecondaryAction key={m} onClick={() => { setMethod(m); setError(""); setCode(""); }}>
            {t(MFA_SWITCH_KEYS[m])}
          </SecondaryAction>
        ))}
        <SecondaryAction onClick={() => onRestart()}>
          {t("auth.mfa.backToSignIn")}
        </SecondaryAction>
      </div>
    </div>
  );
}

// The authenticator-code or recovery-code form.
function MfaCodeForm({
  method,
  code,
  setCode,
  busy,
  onSubmit,
}: {
  method: "totp" | "recovery";
  code: string;
  setCode: (code: string) => void;
  busy: boolean;
  onSubmit: () => Promise<void>;
}) {
  const t = useT();
  const totp = method === "totp";
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        void onSubmit();
      }}
    >
      <Field label={totp ? t("auth.mfa.verificationCode") : t("auth.mfa.recoveryCode")} htmlFor="mfa-code">
        <Input
          id="mfa-code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          autoComplete="one-time-code"
          inputMode={totp ? "numeric" : "text"}
          placeholder={totp ? "123456" : "XXXX-XXXX-XXXX-XXXX"}
          maxLength={totp ? 7 : 24}
          autoFocus
          required
        />
      </Field>
      <Button type="submit" disabled={busy || code.trim().length === 0} className="w-full min-h-11">
        {busy ? t("auth.mfa.verifying") : t("auth.mfa.verify")}
      </Button>
    </form>
  );
}
