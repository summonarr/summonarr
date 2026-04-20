import { NextRequest, NextResponse } from "next/server";
import { auth, isTokenExpired } from "@/lib/auth";
import { getPlayHistoryStats } from "@/lib/play-history";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN" || isTokenExpired(session)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const params = request.nextUrl.searchParams;
  const days = parseInt(params.get("days") ?? "30", 10) || 30;
  const source = params.get("source") ?? undefined;
  const mediaType = params.get("mediaType") ?? undefined;

  const stats = await getPlayHistoryStats({ days, source, mediaType });
  return NextResponse.json(stats);
}
