import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { getPlexConfig } from "@/lib/plex-config";
import { DEFAULT_MEDIA_INSTANCE, isValidMediaInstanceSlug } from "@/lib/media-instances";
import { getPlexLibrarySections } from "@/lib/plex";
import { translatorForRequest } from "@/lib/i18n/server-locale";

export const GET = withAdmin(async (req, _ctx, _session) => {
  const t = translatorForRequest(req);
  // Which server to enumerate. Section keys are per-server, so the picker MUST
  // list the sections of the instance it is choosing for — listing the default
  // server would offer keys that mean something else on the target.
  const raw = new URL(req.url).searchParams.get("instance") ?? DEFAULT_MEDIA_INSTANCE;
  if (raw !== DEFAULT_MEDIA_INSTANCE && !isValidMediaInstanceSlug(raw)) {
    return NextResponse.json({ error: t("apiAdmin.common.invalidInstance") }, { status: 400 });
  }
  const { url, token } = await getPlexConfig(raw);

  if (!url || !token) {
    // 422, not 400: "not configured yet" is server state, not a bad request —
    // the same status arr-options uses, so the three pickers agree.
    return NextResponse.json({ error: t("apiAdmin.common.plexNotConfiguredShort") }, { status: 422 });
  }

  try {
    const sections = await getPlexLibrarySections(url.replace(/\/$/, ""), token);
    return NextResponse.json(sections);
  } catch (err) {
    console.error("[settings/plex/libraries] Failed to fetch Plex libraries:", err);
    return NextResponse.json({ error: t("apiAdmin.settings.plexConnectFailed") }, { status: 502 });
  }
});
