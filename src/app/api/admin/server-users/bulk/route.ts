import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { setJellyfinDownloadPolicy } from "@/lib/jellyfin";
import { setPlexDownloadPolicy } from "@/lib/plex";

export async function POST(req: NextRequest) {
  const session = await requireAuth({ role: "ADMIN" });
  if (session instanceof NextResponse) return session;

  let body: { source?: string; downloadsEnabled?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { source, downloadsEnabled = false } = body;

  if (source !== undefined && source !== "plex" && source !== "jellyfin") {
    return NextResponse.json({ error: "source must be 'plex', 'jellyfin', or omitted for both" }, { status: 400 });
  }

  const where = {
    isServerAdmin: false,
    ...(source ? { source } : {}),
  };

  await prisma.mediaServerUser.updateMany({ where, data: { downloadsEnabled } });

  const targets = await prisma.mediaServerUser.findMany({
    where,
    select: { source: true, sourceUserId: true, username: true },
  });

  const [jellyfinUrlRow, jellyfinKeyRow, plexTokenRow] = await Promise.all([
    prisma.setting.findUnique({ where: { key: "jellyfinUrl" } }),
    prisma.setting.findUnique({ where: { key: "jellyfinApiKey" } }),
    prisma.setting.findUnique({ where: { key: "plexAdminToken" } }),
  ]);

  let pushed = 0;
  let errors = 0;

  await Promise.allSettled(
    targets.map(async (u) => {
      try {
        if (u.source === "jellyfin" && jellyfinUrlRow?.value && jellyfinKeyRow?.value) {
          await setJellyfinDownloadPolicy(jellyfinUrlRow.value, jellyfinKeyRow.value, u.sourceUserId, downloadsEnabled);
          pushed++;
        } else if (u.source === "plex" && plexTokenRow?.value) {
          await setPlexDownloadPolicy(plexTokenRow.value, u.sourceUserId, downloadsEnabled);
          pushed++;
        }
      } catch (err) {
        console.warn(`[server-users/bulk] Failed to push policy for ${u.source}/${u.username}:`, err instanceof Error ? err.message : String(err));
        errors++;
      }
    }),
  );

  return NextResponse.json({ ok: true, pushed, errors });
}
