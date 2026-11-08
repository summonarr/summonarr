import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { arrErrorMessage, arrFetch } from "@/lib/arr";
import { trimServerBase } from "@/lib/server-url";
import { arrSettingKey, isValidInstanceSlug } from "@/lib/arr-instances";
import { projectChoices, projectRootFolderChoices } from "@/lib/arr-title";
import { translatorForRequest } from "@/lib/i18n/server-locale";

// The instance's major version from /system/status, or null when it can't be
// read or parsed. Never throws: the options fetch must not fail on it.
async function readMajorVersion(cfg: { url: string; apiKey: string }): Promise<number | null> {
  try {
    const status = await arrFetch<{ version?: unknown }>(cfg, "/api/v3/system/status");
    const m = typeof status?.version === "string" ? /^\s*(\d+)\./.exec(status.version) : null;
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

// Sonarr v3 only: language profiles for the per-instance default picker.
// v4 removed them — the endpoint 404s, or (on some builds) returns a single
// placeholder named "Deprecated" — so a failure or an empty post-filter list
// means "this Sonarr has no language profiles" and the field is omitted
// entirely rather than failing the whole options fetch. The UI hides the
// picker when the field is absent.
// A Sonarr that reports v4+ is not asked at all: v4 still answers the endpoint
// but logs "API call made to deprecated endpoint" on every Settings visit —
// which is also why this read waits for the version instead of running beside
// it. An unknown version is still asked, because a v3 add needs a language
// profile.
async function readLanguageProfiles(
  cfg: { url: string; apiKey: string },
  sonarrMajor: number | null,
): Promise<{ id: number; name: string }[] | undefined> {
  if (sonarrMajor !== null && sonarrMajor >= 4) return undefined;
  try {
    const raw = await arrFetch<unknown>(cfg, "/api/v3/languageprofile");
    const usable = projectChoices(raw).filter((p) => p.name !== "Deprecated");
    return usable.length > 0 ? usable : undefined;
  } catch (err) {
    // A v4 whose version couldn't be read refuses here too, so this is no
    // error — but say so, or an unreachable endpoint looks like "no profiles".
    console.warn("[settings/arr-options] Sonarr language profiles unavailable:", arrErrorMessage(err));
    return undefined;
  }
}

export const GET = withAdmin(async (req, _ctx, _session) => {
  const t = translatorForRequest(req);
  const service = req.nextUrl.searchParams.get("service");
  if (service !== "radarr" && service !== "sonarr") {
    return NextResponse.json({ error: t("apiAdmin.common.serviceRadarrOrSonarr") }, { status: 400 });
  }
  // ?instance=<slug> selects a named instance's namespaced settings keys; the
  // legacy ?variant=4k spelling is still honored. "" = the default instance.
  const rawInstance = req.nextUrl.searchParams.get("instance");
  const instance = rawInstance != null
    ? rawInstance
    : req.nextUrl.searchParams.get("variant") === "4k" ? "4k" : "";
  if (!isValidInstanceSlug(instance)) {
    return NextResponse.json({ error: t("apiAdmin.common.invalidInstanceLower") }, { status: 400 });
  }

  const urlKey = arrSettingKey(service, instance, "Url");
  const keyKey = arrSettingKey(service, instance, "ApiKey");
  const rows = await prisma.setting.findMany({ where: { key: { in: [urlKey, keyKey] } } });
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));

  if (!map[urlKey] || !map[keyKey]) {
    return NextResponse.json({ error: t("apiAdmin.settings.arrNotConfigured", { service }) }, { status: 422 });
  }

  const cfg = { url: trimServerBase(map[urlKey]), apiKey: map[keyKey] };

  try {
    const [rawRootFolders, rawProfiles, sonarrMajor] = await Promise.all([
      arrFetch<unknown>(cfg, "/api/v3/rootfolder"),
      arrFetch<unknown>(cfg, "/api/v3/qualityprofile"),
      service === "sonarr" ? readMajorVersion(cfg) : Promise.resolve(null),
    ]);
    // Projected, never forwarded: a root folder carries every unmapped folder
    // beneath it and a profile its whole quality and format list, and the form
    // reads only these fields. The title manager's own bounded projections
    // (guardrail 5i: Set-deduped, capped, a bounded scan).
    const rootFolders = projectRootFolderChoices(rawRootFolders).map((f) => ({ path: f.path }));
    const qualityProfiles = projectChoices(rawProfiles);

    const languageProfiles = service === "sonarr" ? await readLanguageProfiles(cfg, sonarrMajor) : undefined;

    return NextResponse.json({ rootFolders, qualityProfiles, ...(languageProfiles ? { languageProfiles } : {}) });
  } catch (err) {
    // arrErrorMessage, never the error object: an upstream body can quote secrets (guardrail 5e).
    console.error(`[settings/arr-options] Failed to fetch ${service} options:`, arrErrorMessage(err));
    return NextResponse.json({ error: t("apiAdmin.settings.arrConnectFailed", { service }) }, { status: 502 });
  }
});
