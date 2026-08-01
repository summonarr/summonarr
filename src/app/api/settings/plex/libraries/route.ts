import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { getPlexConfig } from "@/lib/plex-config";
import { DEFAULT_MEDIA_INSTANCE, isValidMediaInstanceSlug } from "@/lib/media-instances";
import { getPlexLibrarySections } from "@/lib/plex";

export const GET = withAdmin(async (req, _ctx, _session) => {
  // Which server to enumerate. Section keys are per-server, so the picker MUST
  // list the sections of the instance it is choosing for — listing the default
  // server would offer keys that mean something else on the target.
  const raw = new URL(req.url).searchParams.get("instance") ?? DEFAULT_MEDIA_INSTANCE;
  if (raw !== DEFAULT_MEDIA_INSTANCE && !isValidMediaInstanceSlug(raw)) {
    return NextResponse.json({ error: "Invalid instance" }, { status: 400 });
  }
  const { url, token } = await getPlexConfig(raw);

  if (!url || !token) {
    return NextResponse.json({ error: "Plex not configured" }, { status: 400 });
  }

  try {
    const sections = await getPlexLibrarySections(url.replace(/\/$/, ""), token);
    return NextResponse.json(sections);
  } catch (err) {
    console.error("[settings/plex/libraries] Failed to fetch Plex libraries:", err);
    return NextResponse.json({ error: "Could not connect to Plex server" }, { status: 502 });
  }
});
