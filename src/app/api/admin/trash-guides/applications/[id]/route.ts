import { NextResponse } from "next/server";
import { readJsonCapped } from "@/lib/body-size";
import { withAdmin } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { logAudit, auditContext } from "@/lib/audit";
import { isFeatureEnabled } from "@/lib/features";
import { isPrismaErrorCode } from "@/lib/prisma-errors";
import { translatorForRequest } from "@/lib/i18n/server-locale";

// One TRaSH spec's application on an instance: switch it on/off, or remove it.
// Gated on the integration like apply/refresh/starter-pack: with TRaSH off the
// page is hidden and nothing should still edit what the nightly sync pushes.

export const PATCH = withAdmin(async (
  req,
  ctx: { params: Promise<{ id: string }> },
  session,
) => {
  const t = translatorForRequest(req);
  if (!(await isFeatureEnabled("trashGuidesEnabled"))) {
    return NextResponse.json({ error: t("apiAdmin.trash.disabled") }, { status: 403 });
  }
  const { id } = await ctx.params;
  const parsed = await readJsonCapped<{ enabled?: unknown }>(req, 16384);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed;
  if (typeof body.enabled !== "boolean") {
    return NextResponse.json({ error: t("apiAdmin.trash.enabledBoolean") }, { status: 400 });
  }

  // One statement: the write returns the spec the audit names, and a row that
  // is gone (never there, or deleted concurrently) is P2025 → 404, not a 500.
  let app;
  try {
    app = await prisma.trashApplication.update({
      where: { id },
      data: { enabled: body.enabled },
      include: { trashSpec: true },
    });
  } catch (err) {
    if (isPrismaErrorCode(err, "P2025")) return NextResponse.json({ error: t("apiAdmin.common.notFound") }, { status: 404 });
    throw err;
  }

  await logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email,
    ...auditContext(req, session),
    action: "SETTINGS_CHANGE",
    target: "trash:application-toggle",
    details: { trashId: app.trashSpec.trashId, kind: app.trashSpec.kind, enabled: body.enabled },
  });

  return NextResponse.json({ ok: true });
});

export const DELETE = withAdmin(async (
  req,
  ctx: { params: Promise<{ id: string }> },
  session,
) => {
  const t = translatorForRequest(req);
  if (!(await isFeatureEnabled("trashGuidesEnabled"))) {
    return NextResponse.json({ error: t("apiAdmin.trash.disabled") }, { status: 403 });
  }
  const { id } = await ctx.params;

  // As in PATCH: the delete returns the row it removed, and a missing one is a 404.
  let app;
  try {
    app = await prisma.trashApplication.delete({
      where: { id },
      include: { trashSpec: true },
    });
  } catch (err) {
    if (isPrismaErrorCode(err, "P2025")) return NextResponse.json({ error: t("apiAdmin.common.notFound") }, { status: 404 });
    throw err;
  }

  await logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email,
    ...auditContext(req, session),
    action: "SETTINGS_CHANGE",
    target: "trash:application-delete",
    details: { trashId: app.trashSpec.trashId, kind: app.trashSpec.kind },
  });

  return NextResponse.json({ ok: true });
});
