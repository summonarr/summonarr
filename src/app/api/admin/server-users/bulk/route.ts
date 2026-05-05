import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { setJellyfinDownloadPolicy } from "@/lib/jellyfin";

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

  // Plex is intentionally not supported — its sharing API has no working remote toggle.
  if (source !== "jellyfin") {
    return NextResponse.json({ error: "source must be 'jellyfin'" }, { status: 400 });
  }

  const where = { isServerAdmin: false, source: "jellyfin" };

  await prisma.mediaServerUser.updateMany({ where, data: { downloadsEnabled } });

  const targets = await prisma.mediaServerUser.findMany({
    where,
    select: { sourceUserId: true, username: true },
  });

  const [jellyfinUrlRow, jellyfinKeyRow] = await Promise.all([
    prisma.setting.findUnique({ where: { key: "jellyfinUrl" } }),
    prisma.setting.findUnique({ where: { key: "jellyfinApiKey" } }),
  ]);

  let pushed = 0;
  let errors = 0;

  if (jellyfinUrlRow?.value && jellyfinKeyRow?.value) {
    await Promise.allSettled(
      targets.map(async (u) => {
        try {
          await setJellyfinDownloadPolicy(jellyfinUrlRow.value, jellyfinKeyRow.value, u.sourceUserId, downloadsEnabled);
          pushed++;
        } catch (err) {
          console.warn(`[server-users/bulk] Failed to push policy for jellyfin/${u.username}:`, err instanceof Error ? err.message : String(err));
          errors++;
        }
      }),
    );
  }

  return NextResponse.json({ ok: true, pushed, errors });
}
