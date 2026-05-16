import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { getJellyfinMediaFolders } from "@/lib/jellyfin";

export const GET = withAdmin(async (_req, _ctx, _session) => {
  const [urlRow, keyRow] = await Promise.all([
    prisma.setting.findUnique({ where: { key: "jellyfinUrl" } }),
    prisma.setting.findUnique({ where: { key: "jellyfinApiKey" } }),
  ]);

  if (!urlRow?.value || !keyRow?.value) {
    return NextResponse.json({ error: "Jellyfin not configured" }, { status: 400 });
  }

  try {
    const folders = await getJellyfinMediaFolders(urlRow.value, keyRow.value);
    return NextResponse.json(folders);
  } catch (err) {
    console.error("[settings/jellyfin/libraries] Failed to fetch Jellyfin libraries:", err);
    return NextResponse.json({ error: "Could not connect to Jellyfin server" }, { status: 502 });
  }
});
