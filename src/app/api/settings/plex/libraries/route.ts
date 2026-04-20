import { NextResponse } from "next/server";
import { auth, isTokenExpired } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getPlexLibrarySections } from "@/lib/plex";

export async function GET() {
  const session = await auth();
  if (!session || isTokenExpired(session) || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const [serverUrlRow, tokenRow] = await Promise.all([
    prisma.setting.findUnique({ where: { key: "plexServerUrl" } }),
    prisma.setting.findUnique({ where: { key: "plexAdminToken" } }),
  ]);

  if (!serverUrlRow?.value || !tokenRow?.value) {
    return NextResponse.json({ error: "Plex not configured" }, { status: 400 });
  }

  try {
    const sections = await getPlexLibrarySections(serverUrlRow.value.replace(/\/$/, ""), tokenRow.value);
    return NextResponse.json(sections);
  } catch (err) {
    console.error("[settings/plex/libraries] Failed to fetch Plex libraries:", err);
    return NextResponse.json({ error: "Could not connect to Plex server" }, { status: 502 });
  }
}
