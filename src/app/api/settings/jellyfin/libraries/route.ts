import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { getJellyfinConfig } from "@/lib/jellyfin-config";
import { getJellyfinMediaFolders } from "@/lib/jellyfin";

export const GET = withAdmin(async (_req, _ctx, _session) => {
  const { url, apiKey } = await getJellyfinConfig();

  if (!url || !apiKey) {
    return NextResponse.json({ error: "Jellyfin not configured" }, { status: 400 });
  }

  try {
    const folders = await getJellyfinMediaFolders(url, apiKey);
    return NextResponse.json(folders);
  } catch (err) {
    console.error("[settings/jellyfin/libraries] Failed to fetch Jellyfin libraries:", err);
    return NextResponse.json({ error: "Could not connect to Jellyfin server" }, { status: 502 });
  }
});
