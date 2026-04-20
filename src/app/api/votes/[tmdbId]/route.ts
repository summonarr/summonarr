import { NextRequest, NextResponse } from "next/server";
import { auth, isTokenExpired } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ tmdbId: string }> },
) {
  const session = await auth();
  if (!session || isTokenExpired(session)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

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
  const session = await auth();
  if (!session || isTokenExpired(session) || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

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
