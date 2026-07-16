import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { getPlexConfig } from "@/lib/plex-config";
import { getPlexLibrarySections } from "@/lib/plex";

export const GET = withAdmin(async (_req, _ctx, _session) => {
  const { url, token } = await getPlexConfig();

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
