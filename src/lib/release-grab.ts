// What Radarr/Sonarr meant when they refused a release grab
// (POST /api/v3/release), read from their ReleaseController:
//   404 — the release is no longer in the arr's search cache (results live 30
//         minutes, and a restart drops them): search again;
//   409 — the indexer fetch failed, or the download client refused it — the
//         arr's own reason is in the body (masked before it is relayed).
// Anything else is an ordinary failure for the caller's own mapping.
import { NextResponse } from "next/server";
import { ArrResponseError } from "./arr";
import { validationMessagesFromBody } from "./arr-system";
import type { Translator } from "./i18n/translate";

export type GrabRefusal = { kind: "expired" } | { kind: "refused"; reason: string | null };

export function grabRefusal(err: unknown): GrabRefusal | null {
  if (!(err instanceof ArrResponseError)) return null;
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
