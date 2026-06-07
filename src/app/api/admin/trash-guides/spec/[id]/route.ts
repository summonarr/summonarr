import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { getSpecDetail } from "@/lib/trash";
import type { ArrVariant } from "@/lib/arr";

export const GET = withAdmin(async (
  req,
  ctx: { params: Promise<{ id: string }> },
  _session
) => {
  const { id } = await ctx.params;
  const variant: ArrVariant = req.nextUrl.searchParams.get("variant") === "4k" ? "4k" : "hd";
  const spec = await getSpecDetail(id, variant);
  if (!spec) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json(spec);
});
