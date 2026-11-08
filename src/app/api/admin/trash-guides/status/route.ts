import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { listSpecs, describeSchemaError } from "@/lib/trash";
import { parseTrashVariant } from "@/lib/trash-variant";
import type { TrashService } from "@/generated/prisma";
import { translatorForRequest } from "@/lib/i18n/server-locale";

export const GET = withAdmin(async (req, _ctx, _session) => {
  const t = translatorForRequest(req);
  const serviceRaw = req.nextUrl.searchParams.get("service");
  const service: TrashService | null =
    serviceRaw === "radarr" ? "RADARR" : serviceRaw === "sonarr" ? "SONARR" : null;
  if (!service) {
    return NextResponse.json({ error: t("apiAdmin.common.serviceRadarrOrSonarr") }, { status: 400 });
  }
  const variant = parseTrashVariant(req.nextUrl.searchParams.get("variant"));
  if (variant === null) {
    return NextResponse.json({ error: t("apiAdmin.common.invalidInstance") }, { status: 400 });
  }

  try {
    const specs = await listSpecs(service, variant);
    return NextResponse.json({ service, variant, specs });
  } catch (err) {
    const schemaDiagnostic = describeSchemaError(err);
    if (schemaDiagnostic) {
      return NextResponse.json({ service, variant, specs: [], schemaDiagnostic });
    }
    // A non-schema failure's text can name the database host or a query: it
    // goes to the log, and the browser gets a generic message.
    console.error("[trash] catalog status read failed:", err);
    return NextResponse.json(
      { service, variant, specs: [], error: t("apiAdmin.trash.internalError") },
      { status: 500 },
    );
  }
});
