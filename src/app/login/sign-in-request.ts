// The POST to /api/auth/sign-in/<provider> the login page makes. Browser
// only (imported by the login form's client components).
import { withBasePath } from "@/lib/base-path";
import { timedFetch } from "@/lib/client/fetch-json";
import { signInFailureFrom, type SignInResult } from "@/lib/client/login-answers";

// A sign-in can wait behind other password hashes, so the bound is generous; it
// only exists so a stalled backend ends in the retry state, not a lasting spinner.
const SIGN_IN_TIMEOUT_MS = 60_000;

export type SignInProvider = "credentials" | "plex" | "jellyfin" | "jellyfin-quickconnect";

export async function signInWithFetch(provider: SignInProvider, payload: Record<string, unknown>): Promise<SignInResult> {
  let res: Response;
  try {
    res = await timedFetch(withBasePath(`/api/auth/sign-in/${provider}`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(payload),
    }, SIGN_IN_TIMEOUT_MS);
  } catch {
    // Transport failure — offline, DNS, aborted. Reported as its own outcome
    // (a timeout included) rather than folded into `ok: false`, because callers
    // answer a plain failure with "Invalid email or password." Telling someone their password
    // is wrong when their WiFi dropped sends them to retype it forever.
    return { ok: false, offline: true };
  }
  if (res.status === 429) return { ok: false, status: 429, rateLimited: res };
  if (res.ok) {
    // The answer is not read: release its body so the timeout timer stops.
    void res.body?.cancel().catch(() => {});
    return { ok: true, status: res.status };
  }
  // No default text here: callers substitute their own (translated) message.
  return signInFailureFrom(res.status, await res.json().catch(() => null));
}
