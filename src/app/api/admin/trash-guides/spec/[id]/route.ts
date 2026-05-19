import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { getSpecDetail } from "@/lib/trash";

export const GET = withAdmin(async (
  _req,
  ctx: { params: Promise<{ id: string }> },
  _session
) => {
  const { id } = await ctx.params;
  const spec = await getSpecDetail(id);
  if (!spec) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json(spec);
});
