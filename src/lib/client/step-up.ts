// Client half of the step-up gate (src/lib/step-up-auth.ts, guardrail 6g),
// and of the second-factor step-up (src/lib/mfa/step-up.ts, guardrail 6d).
// Client-only: no server imports, so client components can import it directly.
import { withBasePath } from "@/lib/base-path";
import { timedFetch } from "@/lib/client/fetch-json";
import { rateLimitMessage } from "@/lib/client/rate-limit";
import { getPasskeyAssertion, isWebAuthnCancel, isWebAuthnSupported, type RequestOptionsJSON } from "@/lib/client/webauthn";

// A route behind requireStepUp answers 401 with a machine-readable `error`:
//   "password-required" — this account must enter its password: show the prompt.
//   "invalid-password"  — the password was wrong: keep the prompt, say so.
//   "session-too-old"   — an SSO account must sign in again; `message` says so
//                         and is shown like any other error (no prompt).
export type StepUpNeed = "password" | "retry" | null;

export function stepUpNeedOf(status: number, body: unknown): StepUpNeed {
  if (status !== 401 || typeof body !== "object" || body === null) return null;
  const error = (body as { error?: unknown }).error;
  if (error === "password-required") return "password";
  if (error === "invalid-password") return "retry";
  return null;
}

// The request body to send: the caller's own fields plus the password, when the
// prompt supplied one.
export function withStepUpPassword<T extends object>(body: T, confirmPassword: string | undefined): T & { confirmPassword?: string } {
  return confirmPassword ? { ...body, confirmPassword } : body;
}

type Translate = (key: string, vars?: Record<string, string | number>) => string;

// The `secondFactor` body field a change behind the second-factor step-up sends.
export type SecondFactorProof =
  | { method: "totp" | "recovery"; code: string }
  | { method: "webauthn"; credential: Record<string, unknown>; challengeToken: unknown };

// `error` is the text to show, or null when the user cancelled the passkey
// prompt (nothing to say).
export type SecondFactorOutcome = { proof: SecondFactorProof } | { error: string | null };

/** A typed code as its proof: six digits (spaces aside) is an authenticator code, anything else a recovery code. */
export function codeProof(code: string): SecondFactorProof {
  const digits = code.replace(/\s/g, "");
  return /^\d{6}$/.test(digits) ? { method: "totp", code: digits } : { method: "recovery", code };
}

// The challenge route's options, checked before they reach the browser's
// WebAuthn call. Null when the answer doesn't carry them.
function requestOptionsOf(value: unknown): RequestOptionsJSON | null {
  if (!value || typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  if (typeof o.challenge !== "string" || typeof o.rpId !== "string" || !Array.isArray(o.allowCredentials)) return null;
  return value as RequestOptionsJSON;
}

type PasskeyChallenge = { publicKey: RequestOptionsJSON | null; challengeToken: unknown } | { error: string };

// POST /api/profile/mfa/challenge: the options for one passkey assertion, or
// the text to show when the route refused or never answered.
async function fetchPasskeyChallenge(t: Translate, failedMessage: (status: number) => string): Promise<PasskeyChallenge> {
  let res: Response;
  let data: Record<string, unknown>;
  try {
    res = await timedFetch(withBasePath("/api/profile/mfa/challenge"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const body: unknown = await res.json().catch(() => ({}));
    data = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    // Nothing was sent yet, so there is no half-applied change to warn about.
    return { error: t("auth.login.error.network") };
  }
  if (!res.ok) {
    return { error: rateLimitMessage(res, t) ?? (typeof data.error === "string" ? data.error : failedMessage(res.status)) };
  }
  return { publicKey: requestOptionsOf(data.publicKey), challengeToken: data.challengeToken };
}

// A typed code wins (six digits is an authenticator code, anything else a
// recovery code); with the field empty, a passkey when one can be used here;
// otherwise the user is asked for a code. The ONE copy every profile form uses,
// so the forms can't drift apart on a security flow. The caller clears its code
// field before sending: a code is single-use (a recovery code is consumed), so
// it is never resent.
export async function buildSecondFactor(opts: {
  code: string;
  passkeyPossible: boolean;
  t: Translate;
  // Shown when the challenge request fails with no message of its own.
  failedMessage: (status: number) => string;
}): Promise<SecondFactorOutcome> {
  const { t } = opts;
  const code = opts.code.trim();
  if (code.length > 0) return { proof: codeProof(code) };
  if (!opts.passkeyPossible || !isWebAuthnSupported()) return { error: t("profile.mfa.stepUp.codeRequired") };
  const challenge = await fetchPasskeyChallenge(t, opts.failedMessage);
  if ("error" in challenge) return challenge;
  if (!challenge.publicKey) return { error: t("profile.mfa.stepUp.passkeyFailed") };
  try {
    const credential = await getPasskeyAssertion(challenge.publicKey);
    return { proof: { method: "webauthn", credential, challengeToken: challenge.challengeToken } };
  } catch (err) {
    return { error: isWebAuthnCancel(err) ? null : t("profile.mfa.stepUp.passkeyFailed") };
  }
}
