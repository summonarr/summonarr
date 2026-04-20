import { NextRequest, NextResponse } from "next/server";
import { auth, isTokenExpired } from "@/lib/auth";
import { getSpecDetail } from "@/lib/trash";

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session || isTokenExpired(session) || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await ctx.params;
  const spec = await getSpecDetail(id);
  if (!spec) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json(spec);
}
