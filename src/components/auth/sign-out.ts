import { withBasePath } from "@/lib/base-path";

// The one sign-out every account menu uses (desktop header, mobile drawer,
// maintenance wall). Best-effort by design: the user lands on the login page
// whatever happens. The route answers 200 even when its revoke fails (it still
// clears the cookie), so a non-2xx means the request never reached it (a proxy
// 403 or 426) and the session cookie may still be live — warned, not silent.
export async function signOutAndRedirect(callbackUrl = "/login"): Promise<void> {
  try {
    const res = await fetch(withBasePath("/api/auth/sign-out"), { method: "POST", credentials: "include" });
    if (!res.ok) console.warn(`[sign-out] sign-out answered ${res.status}; the session may still be active`);
  } catch (err) {
    console.warn("[sign-out] sign-out request failed", err);
  }
  window.location.href = withBasePath(callbackUrl);
}
