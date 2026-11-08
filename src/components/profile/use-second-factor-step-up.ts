"use client";

import { useState } from "react";
import { buildSecondFactor, type SecondFactorProof } from "@/lib/client/step-up";
import { useT } from "@/components/i18n/i18n-provider";
import { readSecondFactorRefusal } from "./second-factor-refusal";

// What the page knew about the account's two-factor setup when it rendered.
export interface KnownSecondFactor {
  enabled: boolean;
  hasPasskeys: boolean;
  webauthnAvailable: boolean;
}

// The second-factor half of a profile change the server confirms with a fresh
// second factor (guardrail 6i): the code field's value, whether the field
// shows, and the reading of a refusal. The field shows from the start when the
// page knew 2FA was on, and otherwise once the server answers
// `secondFactorRequired` (2FA turned on in another tab, say). ONE copy for the
// password change and closing the account, so the two can't drift on a
// security flow.
export function useSecondFactorStepUp({
  known,
  applies = true,
  failedMessage,
}: {
  known?: KnownSecondFactor;
  // False when this change takes no second factor at all (an account with no
  // password to confirm).
  applies?: boolean;
  // Shown when the passkey challenge fails with no message of its own.
  failedMessage: string;
}) {
  const t = useT();
  const [stepUpCode, setStepUpCode] = useState("");
  // The methods the server listed when it asked for a second factor.
  const [serverMethods, setServerMethods] = useState<string[] | null>(null);

  const needsSecondFactor = applies && (!!known?.enabled || serverMethods !== null);
  const passkeyPossible =
    (!!known?.hasPasskeys && !!known.webauthnAvailable) || !!serverMethods?.includes("webauthn");

  // The `secondFactor` body field ({ proof }), or the text to show ({ error },
  // null when the user cancelled the passkey prompt). The one client builder
  // every profile step-up uses. The typed code is cleared once read: a code is
  // single-use (a recovery code is consumed), so it is never resent.
  async function secondFactorProof(): Promise<{ proof: SecondFactorProof } | { error: string | null }> {
    const r = await buildSecondFactor({
      code: stepUpCode,
      passkeyPossible,
      t,
      failedMessage: () => failedMessage,
    });
    setStepUpCode("");
    return r;
  }

  // The text for a refused change; also records the methods the server asked for.
  function refusalMessage(
    res: { status: number; headers: { get(name: string): string | null } },
    body: unknown,
    sentProof: boolean,
    fallback: string,
  ): string {
    const refusal = readSecondFactorRefusal(res, body, sentProof, t, fallback);
    if (refusal.methods === "unlisted") setServerMethods((m) => m ?? []);
    else if (refusal.methods) setServerMethods(refusal.methods);
    return refusal.message;
  }

  return { stepUpCode, setStepUpCode, needsSecondFactor, passkeyPossible, secondFactorProof, refusalMessage };
}
