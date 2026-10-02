import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { getSpecDetail } from "@/lib/trash";
import { isValidInstanceSlug } from "@/lib/arr-instances";
import type { ArrVariant } from "@/lib/arr";
import { translatorForRequest } from "@/lib/i18n/server-locale";

export const GET = withAdmin(async (
  req,
  ctx: { params: Promise<{ id: string }> },
  _session
) => {
  const t = translatorForRequest(req);
  const { id } = await ctx.params;
  // ?variant= is an instance slug ("" default, "4k", named); "hd" is the legacy default spelling.
  const rawVariant = req.nextUrl.searchParams.get("variant") ?? "";
  const variant: ArrVariant = rawVariant === "hd" ? "" : rawVariant.trim();
  if (!isValidInstanceSlug(variant)) {
    return NextResponse.json({ error: t("apiAdmin.common.invalidInstance") }, { status: 400 });
  }
  const spec = await getSpecDetail(id, variant);
  if (!spec) return NextResponse.json({ error: t("apiAdmin.common.notFound") }, { status: 404 });

  return NextResponse.json(spec);
});
