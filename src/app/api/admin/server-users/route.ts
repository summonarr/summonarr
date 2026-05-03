import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const session = await requireAuth({ role: "ADMIN" });
  if (session instanceof NextResponse) return session;

  const users = await prisma.mediaServerUser.findMany({
    select: {
      id: true,
      source: true,
      sourceUserId: true,
      username: true,
      email: true,
      thumbUrl: true,
      downloadsEnabled: true,
      isServerAdmin: true,
      userId: true,
      user: { select: { name: true, email: true } },
    },
    orderBy: [{ source: "asc" }, { username: "asc" }],
  });

  return NextResponse.json(users);
}

export async function PATCH(req: NextRequest) {
  const session = await requireAuth({ role: "ADMIN" });
  if (session instanceof NextResponse) return session;

  let body: { autoDisableNew?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (typeof body.autoDisableNew !== "boolean") {
    return NextResponse.json({ error: "autoDisableNew must be a boolean" }, { status: 400 });
  }

  await prisma.setting.upsert({
    where: { key: "downloadAutoDisableNew" },
    create: { key: "downloadAutoDisableNew", value: body.autoDisableNew ? "true" : "false" },
    update: { value: body.autoDisableNew ? "true" : "false" },
  });

  return NextResponse.json({ ok: true });
}
