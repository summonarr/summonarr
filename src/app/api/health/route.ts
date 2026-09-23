import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// Health check used by the Docker HEALTHCHECK (see Dockerfile). A running Node
// process with an unreachable database is NOT healthy, so we ping Postgres with
// `SELECT 1` and answer 503 if it fails, letting Docker mark the container
// unhealthy.
//
// force-dynamic stops Next from caching this response; a cached 200 would
// defeat the point.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({ ok: true, db: "up" });
  } catch (err) {
    console.error("[health] DB readiness check failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ ok: false, db: "down" }, { status: 503 });
  }
}
