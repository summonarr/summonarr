"use client";

import { useState } from "react";
import { withBasePath } from "@/lib/base-path";
import { fetchJson, jsonInit } from "@/lib/client/fetch-json";
import { asksSecondFactor, stepUpNeedOf, withSecondFactor, withStepUpPassword, type SecondFactorProof } from "@/lib/client/step-up";
import type { Infer, Schema } from "@/lib/validate";
import { useAsyncAction } from "@/hooks/use-async-action";
import { useT } from "@/components/i18n/i18n-provider";
import { useSecondFactorStepUp, type KnownSecondFactor } from "@/components/profile/use-second-factor-step-up";

// fetchJson exposes no headers, and a second-factor refusal needs none: its
// lockout 429 carries its own text and no Retry-After.
const NO_HEADERS = { get: () => null };

// A POST behind the step-up gate (guardrail 6g), as the profile's link flows
// send it: the route answers 401 "password-required" (ask for the password
// inline) or "invalid-password" (keep asking, say so); the password then rides
// the same request (withStepUpPassword). One copy for every such flow, so a
// change to the step-up protocol is made once.
//
// An account with an active second factor confirms with a fresh one too
// (guardrail 6g): the route answers 400 `secondFactorRequired` once the
// password passed. The code field (`secondFactor`, rendered inside the password
// prompt) shows with the prompt when the page knew two-factor was on
// (`knownSecondFactor`), otherwise as soon as the route asks; the proof is
// built by the one shared hook the password change uses and rides the same
// request. It is sent only together with the password, never on the first,
// password-less click.
//
// `run` resolves the checked answer, or null when it failed (the reason is in
// `error`), asked for the password, or was dropped (a second click while one
// is out, an unmount).
export function useStepUpPost<S extends Schema<unknown>>(
  url: string,
  schema: S,
  messages: {
    /** Shown when the route gave no reason of its own, or no answer came. */
    failed: string;
    /** Shown for a 2xx whose body isn't the expected answer. */
    malformed?: string;
    /** Shown when the step-up password was refused; default is the profile's wording. */
    incorrectPassword?: string;
  },
  // What the page knew about the account's two-factor setup when it rendered.
  knownSecondFactor?: KnownSecondFactor,
) {
  const t = useT();
  const action = useAsyncAction();
  const [error, setError] = useState<string | null>(null);
  const [stepUp, setStepUp] = useState(false);
  const [stepUpError, setStepUpError] = useState<string | null>(null);
  const factor = useSecondFactorStepUp({ known: knownSecondFactor, failedMessage: messages.failed });

  async function run(body: object, confirmPassword?: string): Promise<Infer<S> | null> {
    setError(null);
    const out = await action.run(
      "post",
      async (signal) => {
        let proof: SecondFactorProof | undefined;
        if (confirmPassword && factor.needsSecondFactor) {
          const r = await factor.secondFactorProof();
          // No code typed and no passkey to use, or the passkey prompt failed
          // or was cancelled (null): nothing is sent.
          if (!("proof" in r)) return { sent: false as const, error: r.error };
          proof = r.proof;
        }
        const answer = await fetchJson(withBasePath(url), {
          init: jsonInit("POST", withSecondFactor(withStepUpPassword(body, confirmPassword), proof)),
          schema,
          signal,
          fallbackError: messages.failed,
        });
        return { sent: true as const, answer, sentProof: proof !== undefined };
      },
      { ifBusy: "skip" },
    );
    if (!out) return null;
    if (!out.sent) {
      setStepUpError(out.error);
      return null;
    }
    const res = out.answer;
    if (!res.ok) {
      if (res.kind === "aborted") return null;
      const need = res.kind === "http" ? stepUpNeedOf(res.status, res.body) : null;
      if (need) {
        setStepUp(true);
        setStepUpError(need === "retry" ? messages.incorrectPassword ?? t("profile.sessions.error.incorrectPassword") : null);
        return null;
      }
      // The password passed and the account has two-factor: keep the prompt
      // open, now with the code field, and say what to enter (or that the code
      // was refused).
      if (res.kind === "http" && asksSecondFactor(res.status, res.body)) {
        setStepUp(true);
        setStepUpError(factor.refusalMessage({ status: res.status, headers: NO_HEADERS }, res.body, out.sentProof, messages.failed));
        return null;
      }
      // The route's `message`, else its `error` (a sign-in that is too old
      // says so here); a proxy page or no answer gets `failed`. Not a password
      // refusal, so an earlier "Incorrect password." is cleared from the prompt.
      setStepUpError(null);
      setError(res.kind === "invalid" ? messages.malformed ?? messages.failed : res.error);
      return null;
    }
    setStepUp(false);
    setStepUpError(null);
    return res.data;
  }

  function cancelStepUp() {
    setStepUp(false);
    setStepUpError(null);
  }

  return {
    run,
    loading: action.busy("post"),
    error,
    clearError: () => setError(null),
    stepUp,
    stepUpError,
    cancelStepUp,
    // The code field to render inside the password prompt, when `show`.
    secondFactor: {
      show: factor.needsSecondFactor,
      code: factor.stepUpCode,
      setCode: factor.setStepUpCode,
      passkeyPossible: factor.passkeyPossible,
    },
  };
}
