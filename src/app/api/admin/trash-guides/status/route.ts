import { NextRequest, NextResponse } from "next/server";
import { auth, isTokenExpired } from "@/lib/auth";
import { listSpecs, describeSchemaError } from "@/lib/trash";
import type { TrashService } from "@/generated/prisma";

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session || isTokenExpired(session) || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

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
