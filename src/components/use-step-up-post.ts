"use client";

import { useState } from "react";
import { withBasePath } from "@/lib/base-path";
import { fetchJson, jsonInit } from "@/lib/client/fetch-json";
import { stepUpNeedOf, withStepUpPassword } from "@/lib/client/step-up";
import type { Infer, Schema } from "@/lib/validate";
import { useAsyncAction } from "@/hooks/use-async-action";
import { useT } from "@/components/i18n/i18n-provider";

// A POST behind the step-up gate (guardrail 6g), as the profile's link flows
// send it: the route answers 401 "password-required" (ask for the password
// inline) or "invalid-password" (keep asking, say so); the password then rides
// the same request (withStepUpPassword). One copy for every such flow, so a
// change to the step-up protocol is made once.
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
  },
) {
  const t = useT();
  const action = useAsyncAction();
  const [error, setError] = useState<string | null>(null);
  const [stepUp, setStepUp] = useState(false);
  const [stepUpError, setStepUpError] = useState<string | null>(null);

  async function run(body: object, confirmPassword?: string): Promise<Infer<S> | null> {
    setError(null);
    const res = await action.run(
      "post",
      (signal) => fetchJson(withBasePath(url), {
        init: jsonInit("POST", withStepUpPassword(body, confirmPassword)),
        schema,
        signal,
        fallbackError: messages.failed,
      }),
      { ifBusy: "skip" },
    );
    if (!res) return null;
    if (!res.ok) {
      if (res.kind === "aborted") return null;
      const need = res.kind === "http" ? stepUpNeedOf(res.status, res.body) : null;
      if (need) {
        setStepUp(true);
        setStepUpError(need === "retry" ? t("profile.sessions.error.incorrectPassword") : null);
        return null;
      }
      // The route's `message`, else its `error` (a sign-in that is too old
      // says so here); a proxy page or no answer gets `failed`.
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
  };
}
