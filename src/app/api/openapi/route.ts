import { NextResponse } from "next/server";
import { withPermission } from "@/lib/api-auth";
import { SPEC_JSON } from "@/lib/openapi/spec";
import { Permission } from "@/lib/permissions";

// The document lives in src/lib/openapi/ (one module per area); this route only
// serves the JSON it built once at load.
export const GET = withPermission(Permission.ADMIN)(async (_req, _ctx, _session) => {
  return new NextResponse(SPEC_JSON, {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
});
