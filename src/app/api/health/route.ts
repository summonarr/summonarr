import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// Health / readiness probe. This endpoint is the target of the Docker + compose
// HEALTHCHECK (see Dockerfile / docker-compose.yml), so it must reflect real
// serving readiness — a live Node process fronting a dead Postgres is NOT
// healthy and should be reported unhealthy so the orchestrator restarts it.
//
// A bare liveness reply ({ ok: true }) hid exactly that failure mode. We now
// ping Postgres with a trivial `SELECT 1`; on failure the route returns 503 so
// the container is marked unhealthy instead of silently serving 500s.
//
// force-dynamic so the probe is never statically cached / prerendered — a cached
// 200 would defeat the point.
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
