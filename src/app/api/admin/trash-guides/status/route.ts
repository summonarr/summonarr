import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { listSpecs, describeSchemaError } from "@/lib/trash";
import { isValidInstanceSlug } from "@/lib/arr-instances";
import type { ArrVariant } from "@/lib/arr";
import type { TrashService } from "@/generated/prisma";

export const GET = withAdmin(async (req, _ctx, _session) => {
  const serviceRaw = req.nextUrl.searchParams.get("service");
  const service: TrashService | null =
    serviceRaw === "radarr" ? "RADARR" : serviceRaw === "sonarr" ? "SONARR" : null;
  if (!service) {
    return NextResponse.json({ error: "service must be radarr or sonarr" }, { status: 400 });
  }
  // ?variant= is an instance slug ("" default, "4k", named); "hd" is the legacy default spelling.
  const rawVariant = req.nextUrl.searchParams.get("variant") ?? "";
  const variant: ArrVariant = rawVariant === "hd" ? "" : rawVariant.trim();
  if (!isValidInstanceSlug(variant)) {
    return NextResponse.json({ error: "Invalid instance" }, { status: 400 });
  }

  try {
    const specs = await listSpecs(service, variant);
    return NextResponse.json({ service, variant, specs });
  } catch (err) {
    const schemaDiagnostic = describeSchemaError(err);
    if (schemaDiagnostic) {
      return NextResponse.json({ service, variant, specs: [], schemaDiagnostic });
    }
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ service, variant, specs: [], error: message }, { status: 500 });
  }
});
