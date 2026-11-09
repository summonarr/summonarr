// How a profile change behind the second-factor step-up (a password change,
// closing the account) reads a refusal. Pure and React-free so the unit suite
// runs it directly (tests/second-factor-refusal.test.mts); the state that goes
// with it is use-second-factor-step-up.ts.
import { apiErrorText } from "@/lib/client/api-error";
import { rateLimitMessage } from "@/lib/client/rate-limit";
import type { Translator } from "@/lib/i18n/translate";

export interface SecondFactorRefusal {
  // The methods the server listed when it asked for a second factor;
  // "unlisted" when it asked without a list; null when it didn't ask.
  methods: string[] | "unlisted" | null;
  // The text to show.
  message: string;
}

export function readSecondFactorRefusal(
  res: { status: number; headers: { get(name: string): string | null } },
  body: unknown,
  sentProof: boolean,
  t: Translator,
  fallback: string,
): SecondFactorRefusal {
  const data = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  let methods: SecondFactorRefusal["methods"] = null;
  if (data.secondFactorRequired) {
    methods = Array.isArray(data.methods)
      ? data.methods.filter((m): m is string => typeof m === "string")
      : "unlisted";
    // With no proof sent, the server's text is written for clients that can't
    // ask for a code; these forms can, so say what to do here.
    if (!sentProof) return { methods, message: t("profile.mfa.stepUp.codeRequired") };
  }
  // A two-factor lockout is a 429 with its own explanation and no Retry-After.
  if (res.status === 429 && sentProof && typeof data.error === "string") {
    return { methods, message: data.error };
  }
  // A step-up refusal answers { error: "<slug>", message: "<sentence>" } (an
  // SSO account whose sign-in is too old): the sentence wins.
  return { methods, message: rateLimitMessage(res, t) ?? apiErrorText(data, fallback) };
}
