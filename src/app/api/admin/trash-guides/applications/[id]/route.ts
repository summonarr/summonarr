import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await requireAuth({ role: "ADMIN" });
  if (session instanceof NextResponse) return session;

  const { id } = await ctx.params;
  let body: { enabled?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof body.enabled !== "boolean") {
    return NextResponse.json({ error: "enabled must be boolean" }, { status: 400 });
  }

  const app = await prisma.trashApplication.findUnique({
    where: { id },
    include: { trashSpec: true },
  });
  if (!app) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.trashApplication.update({
    where: { id },
    data: { enabled: body.enabled },
  });

  await logAudit({
    userId: session.user.id,
    userName: session.user.name ?? "admin",
    action: "SETTINGS_CHANGE",
    target: "trash:application-toggle",
    details: { trashId: app.trashSpec.trashId, kind: app.trashSpec.kind, enabled: body.enabled },
  });

  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await requireAuth({ role: "ADMIN" });
  if (session instanceof NextResponse) return session;

  const { id } = await ctx.params;
  const app = await prisma.trashApplication.findUnique({
    where: { id },
    include: { trashSpec: true },
  });
  if (!app) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.trashApplication.delete({ where: { id } });

  await logAudit({
    userId: session.user.id,
    userName: session.user.name ?? "admin",
    action: "SETTINGS_CHANGE",
    target: "trash:application-delete",
    details: { trashId: app.trashSpec.trashId, kind: app.trashSpec.kind },
  });

  return NextResponse.json({ ok: true });
}
