import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  // DB-checked session read (revocation / cutoff / role-aware), not JWT-only
  // auth(). requireAuth returns a NextResponse on failure; preserve the original
  // unauthenticated response shape ({ clientId: null }) rather than its 401.
  const session = await requireAuth();
  if (session instanceof NextResponse) return NextResponse.json({ clientId: null });

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { plexClientId: true },
  });
  return NextResponse.json({ clientId: user?.plexClientId ?? null });
}
