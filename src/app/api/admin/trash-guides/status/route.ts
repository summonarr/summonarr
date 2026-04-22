import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { listSpecs, describeSchemaError } from "@/lib/trash";
import type { TrashService } from "@/generated/prisma";

export async function GET(req: NextRequest) {
  const session = await requireAuth({ role: "ADMIN" });
  if (session instanceof NextResponse) return session;

  const serviceRaw = req.nextUrl.searchParams.get("service");
  const service: TrashService | null =
    serviceRaw === "radarr" ? "RADARR" : serviceRaw === "sonarr" ? "SONARR" : null;
  if (!service) {
    return NextResponse.json({ error: "service must be radarr or sonarr" }, { status: 400 });
  }

  try {
    const specs = await listSpecs(service);
    return NextResponse.json({ service, specs });
  } catch (err) {
    const schemaDiagnostic = describeSchemaError(err);
    if (schemaDiagnostic) {
      return NextResponse.json({ service, specs: [], schemaDiagnostic });
    }
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ service, specs: [], error: message }, { status: 500 });
  }
}
