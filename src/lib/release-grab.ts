// What Radarr/Sonarr meant when they refused a release grab
// (POST /api/v3/release), read from their ReleaseController:
//   404 — the release is no longer in the arr's search cache (results live 30
//         minutes, and a restart drops them): search again;
//   409 — the indexer fetch failed, or the download client refused it — the
//         arr's own reason is in the body (masked before it is relayed).
// Only a refusal of the POST itself counts (ArrReleaseGrabError, thrown by
// postReleaseGrab): a 404 from a lookup made before it is not an expired cache.
// Anything else is an ordinary failure for the caller's own mapping.
import { NextResponse } from "next/server";
import { ArrItemNotFoundError, ArrReleaseGrabError, ArrResponseError } from "./arr";
import { validationMessagesFromBody } from "./arr-system";
import type { Translator } from "./i18n/translate";

export type GrabRefusal = { kind: "expired" } | { kind: "refused"; reason: string | null };

/**
 * Did the arr DEFINITELY not take the grab? Decides whether a claimed release
 * handle is handed back (true — the release may be tried again) or spent
 * (false — the grab may have gone through, so it must never be sent twice).
 *
 * A 4xx is the arr answering and refusing; so is the title missing from it.
 * A 408 or any 5xx is NOT: a reverse proxy in front of the arr answers
 * 502/504 when it gives up on a POST /api/v3/release the arr is still
 * processing — and that POST sends the release to the download client — and a
 * 502/503 is also what an arr restarting mid-request looks like
 * (arrErrorKind reads them as timeout/unreachable for the same reason). A
 * timeout or network failure (no ArrResponseError at all) is unknown too.
 */
export function grabDefinitelyRefused(err: unknown): boolean {
  if (err instanceof ArrItemNotFoundError) return true;
  return err instanceof ArrResponseError && err.status >= 400 && err.status < 500 && err.status !== 408;
}

export function grabRefusal(err: unknown): GrabRefusal | null {
  if (!(err instanceof ArrReleaseGrabError)) return null;
  if (err.status === 404) return { kind: "expired" };
  if (err.status === 409) {
    const reason = validationMessagesFromBody(err.body).join(" ");
    return { kind: "refused", reason: reason || null };
  }
  return null;
}

/** The response for a refused grab, or null when the error is something else. */
export function grabRefusalResponse(err: unknown, service: string, t: Translator): NextResponse | null {
  const refusal = grabRefusal(err);
  if (!refusal) return null;
  if (refusal.kind === "expired") {
    return NextResponse.json({ error: t("apiUser.requests.releases.cacheExpired", { service }) }, { status: 410 });
  }
  const reason = refusal.reason ?? t("apiAdmin.arr.noReason");
  return NextResponse.json({ error: t("apiUser.requests.releases.grabRefused", { service, reason }) }, { status: 409 });
}
