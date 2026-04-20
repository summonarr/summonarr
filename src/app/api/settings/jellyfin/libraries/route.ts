import { NextResponse } from "next/server";
import { auth, isTokenExpired } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getJellyfinMediaFolders } from "@/lib/jellyfin";

export async function GET() {
  const session = await auth();
  if (!session || isTokenExpired(session) || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

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
}
