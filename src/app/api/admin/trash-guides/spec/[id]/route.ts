import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { getSpecDetail } from "@/lib/trash";

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await requireAuth({ role: "ADMIN" });
  if (session instanceof NextResponse) return session;

  const { id } = await ctx.params;
  const spec = await getSpecDetail(id);
  if (!spec) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json(spec);
}
