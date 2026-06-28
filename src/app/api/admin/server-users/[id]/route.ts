import { NextResponse } from "next/server";
import { readJsonCapped } from "@/lib/body-size";
import { withAdmin } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { enforceUserDownloadPolicy } from "@/lib/download-policy";

export const PATCH = withAdmin(async (
  req,
  { params }: { params: Promise<{ id: string }> },
  _session,
) => {
  const { id } = await params;

  const parsed = await readJsonCapped<{ downloadsEnabled?: boolean }>(req, 16384);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed;

  if (typeof body.downloadsEnabled !== "boolean") {
    return NextResponse.json({ error: "downloadsEnabled must be a boolean" }, { status: 400 });
  }

  const record = await prisma.mediaServerUser.findUnique({
    where: { id },
    select: { isServerAdmin: true, source: true, active: true },
  });
  // Soft-deleted (active: false) rows are departed users hidden from every
  // management surface; treat them as absent so policy can't be pushed to them.
  if (!record || !record.active) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (record.isServerAdmin) {
    return NextResponse.json({ error: "Cannot change download policy for server admins" }, { status: 400 });
  }
  // Plex's sharing API does not expose a working remote toggle for allowSync,
  // so download policy is Jellyfin-only. The UI hides the toggle for Plex rows.
  if (record.source === "plex") {
    return NextResponse.json({ error: "Plex download policy is not managed by Summonarr" }, { status: 400 });
  }

  await prisma.mediaServerUser.update({
    where: { id },
    data: { downloadsEnabled: body.downloadsEnabled },
  });

  // Push the change to the media server immediately; log but don't fail the response
  try {
    await enforceUserDownloadPolicy(id);
  } catch (err) {
    console.warn(`[server-users] Failed to push policy for ${id}:`, err instanceof Error ? err.message : String(err));
  }

  return NextResponse.json({ ok: true });
});
