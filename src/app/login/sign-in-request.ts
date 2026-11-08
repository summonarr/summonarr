// The POST to /api/auth/sign-in/<provider> the login page makes. Browser
// only (imported by the login form's client components).
import { withBasePath } from "@/lib/base-path";
import { signInFailureFrom, type SignInResult } from "@/lib/client/login-answers";

export type SignInProvider = "credentials" | "plex" | "jellyfin" | "jellyfin-quickconnect";

export async function signInWithFetch(provider: SignInProvider, payload: Record<string, unknown>): Promise<SignInResult> {
  let res: Response;
  try {
    res = await fetch(withBasePath(`/api/auth/sign-in/${provider}`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(payload),
    });
  } catch {
    // Transport failure — offline, DNS, aborted. Reported as its own outcome
    // rather than folded into `ok: false`, because callers answer a plain
    // failure with "Invalid email or password." Telling someone their password
    // is wrong when their WiFi dropped sends them to retype it forever.
    return { ok: false, offline: true };
  }
  if (res.status === 429) return { ok: false, status: 429, rateLimited: res };
  if (res.ok) return { ok: true, status: res.status };
  // No default text here: callers substitute their own (translated) message.
  return signInFailureFrom(res.status, await res.json().catch(() => null));
}
