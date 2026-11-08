import { NextResponse } from "next/server";
import type { Translator } from "./i18n/translate";

// The 422 a request-queue arr action answers when the request's own Radarr/Sonarr
// instance isn't configured — or its keys are left over from an instance the
// registry no longer lists (guardrail 32). One wording for the "Why?" status and
// "Pick release", which act on the same request row.
export function arrNotConfiguredResponse(t: Translator, service: "radarr" | "sonarr", instance: string): NextResponse {
  const error = instance === ""
    ? t("apiUser.common.notConfigured", { name: service === "radarr" ? "Radarr" : "Sonarr" })
    : t("apiUser.issues.instanceNotConfigured", { service, instance });
  return NextResponse.json({ error }, { status: 422 });
}
