import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { getPlexLibrarySections } from "@/lib/plex";

export async function GET() {
  const session = await requireAuth({ role: "ADMIN" });
  if (session instanceof NextResponse) return session;

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
