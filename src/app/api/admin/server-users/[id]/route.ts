import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { enforceUserDownloadPolicy } from "@/lib/download-policy";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireAuth({ role: "ADMIN" });
  if (session instanceof NextResponse) return session;

  const { id } = await params;

  let body: { downloadsEnabled?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (typeof body.downloadsEnabled !== "boolean") {
    return NextResponse.json({ error: "downloadsEnabled must be a boolean" }, { status: 400 });
  }

  const record = await prisma.mediaServerUser.findUnique({
    where: { id },
    select: { isServerAdmin: true },
  });
  if (!record) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (record.isServerAdmin) {
    return NextResponse.json({ error: "Cannot change download policy for server admins" }, { status: 400 });
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
}
