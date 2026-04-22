import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ tmdbId: string }> },
) {
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;

  const { tmdbId: rawId } = await params;
  const tmdbId = parseInt(rawId, 10);
  if (isNaN(tmdbId)) return NextResponse.json({ error: "Invalid tmdbId" }, { status: 400 });

  const mediaType = req.nextUrl.searchParams.get("mediaType");
  if (mediaType !== "MOVIE" && mediaType !== "TV") {
    return NextResponse.json({ error: "mediaType query param must be MOVIE or TV" }, { status: 400 });
  }

  const deleted = await prisma.deletionVote.deleteMany({
    where: { tmdbId, mediaType, userId: session.user.id },
  });

  if (deleted.count === 0) {
    return NextResponse.json({ error: "Vote not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ tmdbId: string }> },
) {
  const session = await requireAuth({ role: "ADMIN" });
  if (session instanceof NextResponse) return session;

  const { tmdbId: rawId } = await params;
  const tmdbId = parseInt(rawId, 10);
  if (isNaN(tmdbId)) return NextResponse.json({ error: "Invalid tmdbId" }, { status: 400 });

  const mediaType = req.nextUrl.searchParams.get("mediaType");
  if (mediaType !== "MOVIE" && mediaType !== "TV") {
    return NextResponse.json({ error: "mediaType query param must be MOVIE or TV" }, { status: 400 });
  }

  const deleted = await prisma.deletionVote.deleteMany({
    where: { tmdbId, mediaType },
  });

  return NextResponse.json({ ok: true, dismissed: deleted.count });
}
