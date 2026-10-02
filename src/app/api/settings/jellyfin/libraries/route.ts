import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { getJellyfinConfig } from "@/lib/jellyfin-config";
import { DEFAULT_MEDIA_INSTANCE, isValidMediaInstanceSlug } from "@/lib/media-instances";
import { getJellyfinMediaFolders } from "@/lib/jellyfin";
import { translatorForRequest } from "@/lib/i18n/server-locale";

export const GET = withAdmin(async (req, _ctx, _session) => {
  const t = translatorForRequest(req);
  // Which server to enumerate — see the Plex counterpart. Jellyfin ids are
  // GUIDs so they do not collide, but listing the wrong server still offers
  // libraries the target does not have.
  const raw = new URL(req.url).searchParams.get("instance") ?? DEFAULT_MEDIA_INSTANCE;
  if (raw !== DEFAULT_MEDIA_INSTANCE && !isValidMediaInstanceSlug(raw)) {
    return NextResponse.json({ error: t("apiAdmin.common.invalidInstance") }, { status: 400 });
  }
  const { url, apiKey } = await getJellyfinConfig(raw);

  if (!url || !apiKey) {
    return NextResponse.json({ error: t("apiAdmin.common.jellyfinNotConfiguredShort") }, { status: 400 });
  }

  try {
    const folders = await getJellyfinMediaFolders(url, apiKey);
    return NextResponse.json(folders);
  } catch (err) {
    console.error("[settings/jellyfin/libraries] Failed to fetch Jellyfin libraries:", err);
    return NextResponse.json({ error: t("apiAdmin.settings.jellyfinConnectFailed") }, { status: 502 });
  }
});
