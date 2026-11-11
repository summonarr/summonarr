import { NextResponse } from "next/server";
import { probeDatabase } from "@/lib/health-probe";

// Health check used by the Docker HEALTHCHECK (see Dockerfile). A running Node
// process with an unreachable database is NOT healthy, so we ping Postgres with
// `SELECT 1` and answer 503 if it fails, letting Docker mark the container
// unhealthy. The ping's answer is shared for a moment (health-probe.ts): the
// route is anonymous, and a request loop must not cost a pool connection each.
//
// force-dynamic stops Next from caching this response; a cached 200 would
// defeat the point.
export const dynamic = "force-dynamic";

export async function GET() {
  if (await probeDatabase()) return NextResponse.json({ ok: true, db: "up" });
  return NextResponse.json({ ok: false, db: "down" }, { status: 503 });
}
