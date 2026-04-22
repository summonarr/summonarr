import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import bcrypt from "bcryptjs";

export async function PATCH(req: NextRequest) {
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;

  let body: { currentPassword?: string; newPassword?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { currentPassword, newPassword } = body;

  if (!newPassword || typeof newPassword !== "string") {
    return NextResponse.json({ error: "New password is required" }, { status: 400 });
  }

  if (newPassword.length < 8) {
    return NextResponse.json({ error: "New password must be at least 8 characters" }, { status: 400 });
  }

  if (newPassword.length > 1024) {
    return NextResponse.json({ error: "New password must be at most 1024 characters" }, { status: 400 });
  }

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { passwordHash: true },
  });

  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const DUMMY_HASH = "$2b$12$LkFEkPkDAMiJl3dLNcRLeezS3KD2OQ3z1bKKuXNi2b8f4yJBLO2G";
  const hashToCheck = user.passwordHash ?? DUMMY_HASH;
  const currentOk = await bcrypt.compare(currentPassword ?? "", hashToCheck);
  if (user.passwordHash && !currentOk) {
    return NextResponse.json({ error: "Invalid password" }, { status: 400 });
  }

  const newHash = await bcrypt.hash(newPassword, 12);

  await prisma.$transaction([
    prisma.user.update({ where: { id: session.user.id }, data: { passwordHash: newHash } }),
    prisma.authSession.deleteMany({
      where: { userId: session.user.id },
    }),
  ]);

  return NextResponse.json({ ok: true, requiresRelogin: true });
}
