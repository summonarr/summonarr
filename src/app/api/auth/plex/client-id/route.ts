import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return NextResponse.json({ clientId: null });

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { plexClientId: true },
  });
  return NextResponse.json({ clientId: user?.plexClientId ?? null });
}
