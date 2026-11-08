"use client";

// Jellyfin QuickConnect: the server issues a short-lived code the user enters
// in another Jellyfin client, then this polls until that client approves it.
// Owned by the Jellyfin panel, whose unmount (a provider switch, or any tab
// click — the panel is keyed) cancels the run.
import { useCallback, useEffect, useRef, useState } from "react";
import { withBasePath } from "@/lib/base-path";
import { fetchJson } from "@/lib/client/fetch-json";
import {
  QC_DEADLINE_MS,
  QC_FAILURE_BACKOFF_MS,
  QC_MAX_CONSECUTIVE_FAILURES,
  QuickConnectStartAnswer,
  readQuickConnectPoll,
  signInFailureMessage,
} from "@/lib/client/login-answers";
import { useT } from "@/components/i18n/i18n-provider";
import type { Translator } from "@/lib/i18n/translate";
import { signInWithFetch } from "./sign-in-request";

// A pause the run's abort cuts short, so a cancelled run never lingers asleep.
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

function instanceQuery(instance: string): string {
  return instance ? `instance=${encodeURIComponent(instance)}` : "";
}

type Ended = { ok: false; error: string };

// The initiate POST: the secret to poll with and the code to show, or the
// server's own (translated) reason it couldn't start (e.g. QuickConnect is
// disabled). null when the run was cancelled meanwhile.
async function startQuickConnect(
  instance: string,
  signal: AbortSignal,
  t: Translator,
): Promise<{ ok: true; secret: string; code: string } | Ended | null> {
  const qs = instanceQuery(instance);
  const res = await fetchJson(withBasePath(`/api/auth/jellyfin/quickconnect${qs ? `?${qs}` : ""}`), {
    init: { method: "POST" },
    signal,
    schema: QuickConnectStartAnswer,
    fallbackError: t("auth.login.error.quickConnectStart"),
  });
  if (res.ok) return { ok: true, secret: res.data.secret, code: res.data.code };
  // A cancel (provider switch, "Use password instead", unmount) already reset the UI.
  if (res.kind === "aborted" || signal.aborted) return null;
  return { ok: false, error: res.error };
}

// Long-polls until the code is approved, the server ends the flow, or the
// deadline passes. null when the run was cancelled (`isCurrent` false, or the
// abort fired): the caller then does nothing at all.
async function pollUntilAuthenticated(
  secret: string,
  instance: string,
  signal: AbortSignal,
  isCurrent: () => boolean,
  t: Translator,
): Promise<{ ok: true } | Ended | null> {
  const qs = instanceQuery(instance);
  const url = withBasePath(`/api/auth/jellyfin/quickconnect?secret=${encodeURIComponent(secret)}&wait=1${qs ? `&${qs}` : ""}`);
  const failed = t("auth.login.error.quickConnectFailed");
  const deadline = Date.now() + QC_DEADLINE_MS;
  let consecutiveFailures = 0;
  let rateLimited = false;
  while (Date.now() < deadline) {
    if (!isCurrent()) return null;
    let poll: Response;
    try {
      poll = await fetch(url, { signal });
    } catch {
      // Cancelled: the run is over, no pause. (The server answers a poll the
      // browser abandoned with 499, which nobody reads.)
      if (signal.aborted) return null;
      // Fetch rejected immediately (network down) — pause so the loop can't hot-spin.
      await sleep(1000, signal);
      continue;
    }
    const body: unknown = await poll.json().catch(() => null);
    if (!isCurrent()) return null;
    const answer = readQuickConnectPoll(poll.status, body, poll.headers.get("Retry-After"));
    switch (answer.kind) {
      case "authenticated":
        return { ok: true };
      case "pending":
        // A good answer resets the count.
        consecutiveFailures = 0;
        rateLimited = false;
        break;
      case "expired":
        return { ok: false, error: answer.message ?? t("auth.login.error.quickConnectExpired") };
      case "terminal":
        return { ok: false, error: answer.message ?? failed };
      case "busy":
        await sleep(Math.min(answer.waitMs, deadline - Date.now()), signal);
        break;
      case "rateLimited":
        rateLimited = true;
        await sleep(Math.min(answer.waitMs, deadline - Date.now()), signal);
        break;
      case "retry":
        consecutiveFailures += 1;
        if (consecutiveFailures >= QC_MAX_CONSECUTIVE_FAILURES) return { ok: false, error: answer.message ?? failed };
        await sleep(QC_FAILURE_BACKOFF_MS, signal);
        break;
    }
  }
  if (!isCurrent()) return null;
  return { ok: false, error: rateLimited ? t("shared.rateLimited.generic") : t("auth.login.error.quickConnectTimeout") };
}

export function useQuickConnect({
  jellyfinInstance,
  rememberMe,
  setLoading,
  setError,
  onSignedIn,
}: {
  jellyfinInstance: string;
  rememberMe: boolean;
  setLoading: (loading: boolean) => void;
  setError: (message: string) => void;
  onSignedIn: () => Promise<void>;
}) {
  const t = useT();
  const [qcCode, setQcCode] = useState<string | null>(null);
  // Cancels an in-flight QuickConnect poll loop (provider switch, "Use password
  // instead", unmount) so an abandoned code can't later complete a sign-in.
  //
  // A per-run generation, NOT a shared boolean: with one flag, starting a SECOND
  // QuickConnect reset it to false and thereby un-cancelled the first loop, which
  // then resumed polling its abandoned secret — both runs could reach
  // signInWithFetch. Each run captures its own id and bails the moment it is no
  // longer the current one; cancelling just bumps the counter.
  const qcRunRef = useRef(0);
  // The current run's requests. Aborting frees the server's long-poll slot at
  // once (it holds one of three per IP for up to 25s); bumping the generation
  // alone left the abandoned request running, so a few cancel-and-retry rounds
  // hit "too many polls".
  const qcAbortRef = useRef<AbortController | null>(null);
  const cancelQuickConnect = useCallback(() => {
    qcRunRef.current += 1;
    qcAbortRef.current?.abort();
    qcAbortRef.current = null;
  }, []);

  useEffect(() => cancelQuickConnect, [cancelQuickConnect]);

  // Cancels the run and clears everything it showed ("Use password instead").
  const resetQuickConnect = useCallback(() => {
    cancelQuickConnect();
    setError("");
    setQcCode(null);
    setLoading(false);
  }, [cancelQuickConnect, setError, setLoading]);

  async function handleQuickConnect() {
    cancelQuickConnect();
    const myRun = qcRunRef.current;
    const abort = new AbortController();
    qcAbortRef.current = abort;
    const isCurrent = () => qcRunRef.current === myRun;
    // Every way a run ends without signing in.
    const fail = (message: string) => {
      setError(message);
      setLoading(false);
      setQcCode(null);
    };
    setLoading(true);
    setError("");
    setQcCode(null);

    const started = await startQuickConnect(jellyfinInstance, abort.signal, t);
    if (started === null || !isCurrent()) return;
    if (!started.ok) return fail(started.error);
    setQcCode(started.code);

    const polled = await pollUntilAuthenticated(started.secret, jellyfinInstance, abort.signal, isCurrent, t);
    if (polled === null || !isCurrent()) return;
    if (!polled.ok) return fail(polled.error);

    const result = await signInWithFetch("jellyfin-quickconnect", { secret: started.secret, rememberMe: String(rememberMe) });
    // Re-check AFTER the await, not just before it: the QuickConnect card (with
    // its "Use password instead" button) and the provider tabs are all still on
    // screen for the whole request. Without this, backing out still navigated
    // the user into the app. It cannot un-issue the request — the server may
    // already have minted the session — but the navigation is the half the user
    // actually sees.
    if (!isCurrent()) return;
    if (!result.ok) return fail(signInFailureMessage(result, t("auth.login.error.quickConnectFailed"), t));
    await onSignedIn();
  }

  return { qcCode, handleQuickConnect, resetQuickConnect };
}
