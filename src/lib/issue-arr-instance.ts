// The Radarr/Sonarr instance an issue action targets — Refetch, Replace
// release (search and grab) — resolved and validated ONE way. Issue has no
// arrInstance column (the same title can sit on several instances), so the
// caller names it; absent means the default "". Route files may only export
// handlers, so it lives here.
import { NextResponse } from "next/server";
import { isValidInstanceSlug } from "./arr-instances";
import { getSyncableArrInstances } from "./arr-instance-registry";
import { arrNotConfiguredResponse } from "./arr-not-configured";
import { isFeatureEnabled } from "./features";
import type { Translator } from "./i18n/translate";

export type IssueArrService = "radarr" | "sonarr";

export const issueArrService = (mediaType: string): IssueArrService => (mediaType === "MOVIE" ? "radarr" : "sonarr");

const SERVICE_LABEL: Record<IssueArrService, string> = { radarr: "Radarr", sonarr: "Sonarr" };

/**
 * The instance slug, or the response refusing it:
 *   400 — not a valid slug (validated, never coerced: a bad slug must not
 *         silently retarget the default);
 *   404 — the service's integration switch is off (as arrGate answers the
 *         Replace file route): stored URLs and keys must not be driven while
 *         the admin has the integration disabled;
 *   422 — not a CONFIGURED instance the registry lists, the default "" included.
 *         The registry decides which slugs exist (guardrail 32): a de-registered
 *         instance's Url/ApiKey rows can outlive it, and a bare configured-keys
 *         check would turn any slug a MANAGE_ISSUES delegate guesses into
 *         searches and grabs on a server the admin removed.
 */
export async function resolveIssueArrInstance(
  raw: unknown,
  service: IssueArrService,
  t: Translator,
): Promise<string | NextResponse> {
  const instance = typeof raw === "string" ? raw.trim() : "";
  if (!isValidInstanceSlug(instance)) {
    return NextResponse.json({ error: t("apiUser.common.invalidInstance") }, { status: 400 });
  }
  if (!(await isFeatureEnabled(`feature.integration.${service}`))) {
    return NextResponse.json({ error: t("apiAdmin.missing.integrationDisabled", { service: SERVICE_LABEL[service] }) }, { status: 404 });
  }
  const configured = await getSyncableArrInstances(service);
  // The same 422 the request queue's arr actions answer.
  if (!configured.some((i) => i.slug === instance)) return arrNotConfiguredResponse(t, service, instance);
  return instance;
}
