import { NextResponse } from "next/server";
import { readJsonCapped } from "@/lib/body-size";
import { withAdmin } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";

export const PATCH = withAdmin(async (
  req,
  ctx: { params: Promise<{ id: string }> },
  session,
) => {
  const { id } = await ctx.params;
  const parsed = await readJsonCapped<{ enabled?: unknown }>(req, 16384);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed;
  if (typeof body.enabled !== "boolean") {
    return NextResponse.json({ error: "enabled must be boolean" }, { status: 400 });
  }

  const app = await prisma.trashApplication.findUnique({
    where: { id },
    include: { trashSpec: true },
  });
  if (!app) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // updateMany (not update) so a concurrent delete returns count:0 instead of
  // throwing an unhandled P2025 → 500 (mirrors the issues route convention).
  const updated = await prisma.trashApplication.updateMany({
    where: { id },
    data: { enabled: body.enabled },
  });
  if (updated.count === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await logAudit({
    userId: session.user.id,
    userName: session.user.name ?? "admin",
    action: "SETTINGS_CHANGE",
    target: "trash:application-toggle",
    details: { trashId: app.trashSpec.trashId, kind: app.trashSpec.kind, enabled: body.enabled },
  });

  return NextResponse.json({ ok: true });
});

export const DELETE = withAdmin(async (
  _req,
  ctx: { params: Promise<{ id: string }> },
  session,
) => {
  const { id } = await ctx.params;
  const app = await prisma.trashApplication.findUnique({
    where: { id },
    include: { trashSpec: true },
  });
  if (!app) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // deleteMany (not delete) so a concurrent delete returns count:0 instead of
  // throwing an unhandled P2025 → 500 (mirrors the issues route convention).
  const deleted = await prisma.trashApplication.deleteMany({ where: { id } });
  if (deleted.count === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await logAudit({
    userId: session.user.id,
    userName: session.user.name ?? "admin",
    action: "SETTINGS_CHANGE",
    target: "trash:application-delete",
    details: { trashId: app.trashSpec.trashId, kind: app.trashSpec.kind },
  });

  return NextResponse.json({ ok: true });
});
