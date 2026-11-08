import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { getSpecDetail } from "@/lib/trash";
import { parseTrashVariant } from "@/lib/trash-variant";
import { translatorForRequest } from "@/lib/i18n/server-locale";

export const GET = withAdmin(async (
  req,
  ctx: { params: Promise<{ id: string }> },
  _session
) => {
  const t = translatorForRequest(req);
  const { id } = await ctx.params;
  const variant = parseTrashVariant(req.nextUrl.searchParams.get("variant"));
  if (variant === null) {
    return NextResponse.json({ error: t("apiAdmin.common.invalidInstance") }, { status: 400 });
  }
  const spec = await getSpecDetail(id, variant);
  if (!spec) return NextResponse.json({ error: t("apiAdmin.common.notFound") }, { status: 404 });

  return NextResponse.json(spec);
});
