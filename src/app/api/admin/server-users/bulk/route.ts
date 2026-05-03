import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { setJellyfinDownloadPolicy } from "@/lib/jellyfin";
import { getPlexAccounts, setPlexDownloadPolicy } from "@/lib/plex";

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

  // Update DB first
  await prisma.mediaServerUser.updateMany({ where, data: { downloadsEnabled } });

  const targets = await prisma.mediaServerUser.findMany({
    where,
    select: { source: true, sourceUserId: true, username: true },
  });

  const [jellyfinUrlRow, jellyfinKeyRow, plexServerUrlRow, plexTokenRow] = await Promise.all([
    prisma.setting.findUnique({ where: { key: "jellyfinUrl" } }),
    prisma.setting.findUnique({ where: { key: "jellyfinApiKey" } }),
    prisma.setting.findUnique({ where: { key: "plexServerUrl" } }),
    prisma.setting.findUnique({ where: { key: "plexAdminToken" } }),
  ]);

  // For Plex, fetch one XML response to get sharing IDs for all users.
  // The Plex API requires the sharing-relationship ID (from <Server id="...">),
  // not the user's account ID, for PUT /api/v2/shared_servers/{id}.
  const plexSharingMap = new Map<string, string>(); // accountId → sharingId
  const needsPlex = targets.some((u) => u.source === "plex");
  if (needsPlex && plexServerUrlRow?.value && plexTokenRow?.value) {
    try {
      const accounts = await getPlexAccounts(plexServerUrlRow.value, plexTokenRow.value);
      for (const a of accounts) {
        if (a.sharingId) plexSharingMap.set(a.id, a.sharingId);
      }
    } catch (err) {
      console.warn("[server-users/bulk] Failed to fetch Plex sharing IDs:", err instanceof Error ? err.message : String(err));
    }
  }

  let pushed = 0;
  let errors = 0;

  await Promise.allSettled(
    targets.map(async (u) => {
      try {
        if (u.source === "jellyfin" && jellyfinUrlRow?.value && jellyfinKeyRow?.value) {
          await setJellyfinDownloadPolicy(jellyfinUrlRow.value, jellyfinKeyRow.value, u.sourceUserId, downloadsEnabled);
          pushed++;
        } else if (u.source === "plex" && plexTokenRow?.value) {
          const sharingId = plexSharingMap.get(u.sourceUserId);
          if (!sharingId) {
            console.warn(`[server-users/bulk] No sharingId for Plex user ${u.username} — skipping`);
            return;
          }
          await setPlexDownloadPolicy(plexTokenRow.value, sharingId, downloadsEnabled);
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
