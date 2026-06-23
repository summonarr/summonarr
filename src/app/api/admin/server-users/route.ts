import { NextResponse } from "next/server";
import { readJsonCapped } from "@/lib/body-size";
import { withAdmin } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { logAudit, auditContext } from "@/lib/audit";

export const GET = withAdmin(async (_req, _ctx, _session) => {
  const [users, autoDisableRow] = await Promise.all([
    prisma.mediaServerUser.findMany({
      where: { active: true }, // hide soft-deleted (departed) server users from active management
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
    }),
    prisma.setting.findUnique({ where: { key: "downloadAutoDisableNew" }, select: { value: true } }),
  ]);

  // Object shape (was a bare array) so the auto-disable-new-Jellyfin-users flag
  // travels with the list — the native admin client reads + toggles it.
  return NextResponse.json({ users, autoDisableNew: autoDisableRow?.value === "true" });
});

export const PATCH = withAdmin(async (req, _ctx, session) => {
  const parsed = await readJsonCapped<{ autoDisableNew?: boolean }>(req, 16384);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed;

  if (body.autoDisableNew !== undefined) {
    if (typeof body.autoDisableNew !== "boolean") {
      return NextResponse.json({ error: "autoDisableNew must be a boolean" }, { status: 400 });
    }
    const newValue = body.autoDisableNew ? "true" : "false";

    // Audit the privilege-relevant write — this Setting controls whether
    // newly-discovered Jellyfin users are auto-restricted from downloads.
    // The /api/settings audit trail doesn't see this write because it lives
    // on a different route, so audit explicitly here.
    const before = await prisma.setting.findUnique({
      where: { key: "downloadAutoDisableNew" },
      select: { value: true },
    });
    await prisma.setting.upsert({
      where: { key: "downloadAutoDisableNew" },
      create: { key: "downloadAutoDisableNew", value: newValue },
      update: { value: newValue },
    });
    void logAudit({
      userId: session.user.id,
      userName: session.user.name ?? session.user.email ?? null,
      action: "SETTINGS_CHANGE",
      target: "settings:downloadAutoDisableNew",
      details: {
        key: "downloadAutoDisableNew",
        before: { value: before?.value ?? null },
        after: { value: newValue },
      },
      ...auditContext(req, session),
    });
  }

  return NextResponse.json({ ok: true });
});
